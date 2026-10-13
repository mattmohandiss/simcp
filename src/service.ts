import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Artifacts, digest } from './artifacts.js';
import { SimulationError, errorData, requireThat } from './errors.js';
import { artifactSchema, caseSchema, controlsSchema, groupSchema, id, inventorySchema, meshSchema, workerMeshSchema, type ArtifactRef, type Case, type Mesh } from './schemas.js';
import { meshFiles, validateConversion, validateGroups } from './mesh.js';
import { runProcess, termination, type ProcessResult } from './process.js';
import { generateSif, normalizeThermal, validateBoundaryNodes } from './thermal.js';
import { inspectVtu, parseScalars } from './results.js';

const inspectionSchema = z.strictObject({ source: artifactSchema, inventory: inventorySchema });
export const summarySchema = z.strictObject({ name: z.string(), value: z.number(), units: z.string(), method: z.string(), source: artifactSchema });
const resultSchema = z.strictObject({
  artifact: artifactSchema, pointCount: z.number().int().positive(), cellCount: z.number().int().positive(),
  fields: z.array(z.strictObject({ name: z.string(), components: z.number().int().positive(), association: z.string(), units: z.string().optional() })),
  frame: z.string(), coordinateUnits: z.literal('m'),
});
export const runSchema = z.strictObject({
  runId: id, status: z.enum(['preparing', 'running', 'succeeded', 'failed', 'timeout', 'cancelled', 'interrupted']),
  createdAt: z.string(), startedAt: z.string().optional(), endedAt: z.string().optional(),
  case: artifactSchema, source: artifactSchema, mesh: artifactSchema, sif: artifactSchema,
  solver: z.strictObject({ executable: z.literal('ElmerSolver'), version: z.string() }),
  execution: z.strictObject({ exitCode: z.number().nullable(), signal: z.string().nullable(), termination: z.string(), timeoutMs: z.number().int().positive() }).optional(),
  logs: z.array(artifactSchema), outputs: z.array(artifactSchema), results: z.array(resultSchema), summaries: z.array(summarySchema),
  convergence: z.string(), diagnostics: z.array(z.string()),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});
export type Run = z.infer<typeof runSchema>;
export type Settings = { workspace: string; roots: string[]; python: string; elmerGrid: string; elmerSolver: string; timeoutMs: number };
export class Simulation {
  private active = new Map<string, { abort: AbortController; done: Promise<void>; state: Run }>();
  private constructor(public artifacts: Artifacts, public settings: Settings) {}
  static async create(settings: Settings) {
    requireThat(Number.isInteger(settings.timeoutMs) && settings.timeoutMs > 0 && settings.timeoutMs <= 3_600_000, 'invalid_input', 'Timeout must be between 1 and 3600000 ms.');
    return new Simulation(await Artifacts.create(settings.workspace, settings.roots), settings);
  }
  async logs(dir: string, prefix: string) {
    return Promise.all(['stdout', 'stderr'].map(suffix => this.artifacts.capture(join(dir, `${prefix}.${suffix}`), 'text')));
  }
  async worker(dir: string, request: object, signal?: AbortSignal) {
    await this.artifacts.put(dir, 'request.json', JSON.stringify({ protocol: 1, ...request }), 'json');
    const worker = fileURLToPath(new URL('../worker/gmsh_worker.py', import.meta.url));
    const process = await runProcess(this.settings.python, [worker, 'request.json', 'response.json'], dir, 'gmsh', this.settings.timeoutMs, signal);
    const logs = await this.logs(dir, 'gmsh');
    const failure = termination(process);
    if (failure) throw new SimulationError(failure, 'Gmsh worker failed; inspect its retained logs.', { logs });
    let response: unknown;
    try { response = JSON.parse((await this.artifacts.bytes(pathToFileURL(join(dir, 'response.json')).href)).toString()); }
    catch { throw new SimulationError('worker_protocol', 'Gmsh returned a malformed response.', { logs }); }
    return { response, logs };
  }
  async inspect(input: { uri?: string; source?: ArtifactRef }, signal?: AbortSignal) {
    requireThat(Boolean(input.uri) !== Boolean(input.source), 'invalid_input', 'Supply exactly one STEP URI or artifact ref.');
    const bytes = input.source ? await this.artifacts.verify(input.source, 'step') : await this.artifacts.bytes(input.uri!);
    requireThat(bytes.toString('ascii', 0, 128).trimStart().startsWith('ISO-10303-21;'), 'unsupported_format', 'Expected STEP Part 21.');
    const dir = await this.artifacts.directory();
    const snapshot = await this.artifacts.put(dir, 'source.step', bytes, 'step');
    const { response, logs } = await this.worker(dir, { operation: 'inspect', source: 'source.step' }, signal);
    const inventory = inventorySchema.parse(response);
    if (input.source?.units) requireThat(input.source.units === inventory.sourceUnits, 'invalid_input', 'Artifact units disagree with STEP declaration.');
    const source = artifactSchema.parse({ ...snapshot, units: inventory.sourceUnits });
    if (input.source) await this.artifacts.verify(input.source, 'step');
    else requireThat(digest(await this.artifacts.bytes(input.uri!)) === source.revision, 'stale_artifact', 'Source changed during inspection.');
    const inspection = await this.artifacts.put(dir, 'inspection.json', JSON.stringify({ source, inventory }), 'json');
    return { source, inspection, inventory, logs };
  }
  async propose(source: ArtifactRef, inspection: ArtifactRef, controls: z.infer<typeof controlsSchema>) {
    controlsSchema.parse(controls);
    await this.artifacts.verify(source, 'step');
    const document = await this.artifacts.json(inspection, inspectionSchema);
    requireThat(document.source.revision === source.revision, 'stale_artifact', 'Inspection belongs to a different STEP revision.');
    return { source, inspection, controls, inventory: document.inventory, diagnostics: ['Confirm explicit physical groups for every listed volume and surface before generation. No groups are auto-selected.'] };
  }
  async mesh(source: ArtifactRef, inspection: ArtifactRef, controlsInput: unknown, groupsInput: unknown, signal?: AbortSignal) {
    const controls = controlsSchema.parse(controlsInput);
    const groups = z.array(groupSchema).min(1).parse(groupsInput);
    const bytes = await this.artifacts.verify(source, 'step');
    const document = await this.artifacts.json(inspection, inspectionSchema);
    requireThat(document.source.revision === source.revision, 'stale_artifact', 'Inventory belongs to another STEP revision.');
    validateGroups(groups, document.inventory);
    const dir = await this.artifacts.directory();
    const staged = await this.artifacts.put(dir, 'source.step', bytes, 'step', document.inventory.sourceUnits);
    const { response, logs } = await this.worker(dir, { operation: 'mesh', source: 'source.step', expectedInventory: document.inventory, controls, groups, output: 'mesh.msh' }, signal);
    const generated = workerMeshSchema.parse(response);
    requireThat(JSON.stringify(generated.inventory) === JSON.stringify(document.inventory), 'stale_artifact', 'Importer/topology changed; inspect source again.');
    const converted = await runProcess(this.settings.elmerGrid, ['14', '2', 'mesh.msh', '-out', 'mesh'], dir, 'elmergrid', this.settings.timeoutMs, signal);
    const conversionLogs = await this.logs(dir, 'elmergrid');
    const failure = termination(converted);
    if (failure) throw new SimulationError(failure, 'ElmerGrid conversion failed.', { logs: [...logs, ...conversionLogs] });
    const contents = Object.fromEntries(await Promise.all(meshFiles.map(async name => [name, (await this.artifacts.bytes(pathToFileURL(join(dir, 'mesh', name)).href)).toString()]))) as Record<typeof meshFiles[number], string>;
    const gmsh = await this.artifacts.capture(join(dir, 'mesh.msh'), 'gmsh-msh', 'm');
    const correspondence = validateConversion((await this.artifacts.verify(gmsh)).toString(), contents, generated.groups);
    requireThat(correspondence.nodeCount === generated.nodeCount && correspondence.elementCount === generated.elementCount, 'bad_mesh', 'Worker/native mesh counts disagree.');
    const files = Object.fromEntries(await Promise.all(meshFiles.map(async name => [name, await this.artifacts.capture(join(dir, 'mesh', name), 'elmer-mesh', 'm')]))) as Mesh['files'];
    await this.artifacts.verify(source, 'step');
    await this.artifacts.verify(inspection, 'json');
    const mesh = meshSchema.parse({
      kind: 'simulation-mesh-v1', source: staged, inventory: inspection, controls, groups: generated.groups, gmsh, files,
      gmshVersion: generated.inventory.gmshVersion, elmerGridVersion: version(converted, 'ElmerGrid'), minimumQuality: generated.minimumQuality,
      ...correspondence, logs: [...logs, ...conversionLogs], diagnostics: ['ASCII MSH2.2; linear tetrahedra; native group membership checked by coordinates/connectivity.', 'SI mesh coordinates. No geometry repair, fragmentation or contact modelling.'],
    });
    const artifact = await this.artifacts.put(dir, 'mesh.json', JSON.stringify(mesh), 'json');
    return { mesh: artifact, metadata: mesh };
  }
  async loadMesh(ref: ArtifactRef) {
    const mesh = await this.artifacts.json(ref, meshSchema);
    await this.artifacts.verify(mesh.source, 'step');
    const inspection = await this.artifacts.json(mesh.inventory, inspectionSchema);
    requireThat(inspection.source.revision === mesh.source.revision && inspection.inventory.gmshVersion === mesh.gmshVersion, 'stale_artifact', 'Mesh provenance mismatch.');
    validateGroups(mesh.groups, inspection.inventory);
    const contents = Object.fromEntries(await Promise.all(meshFiles.map(async name => {
      requireThat(mesh.files[name].units === 'm', 'bad_mesh', 'Native mesh must use meters.');
      return [name, (await this.artifacts.verify(mesh.files[name], 'elmer-mesh')).toString()];
    }))) as Record<typeof meshFiles[number], string>;
    const checked = validateConversion((await this.artifacts.verify(mesh.gmsh, 'gmsh-msh')).toString(), contents, mesh.groups);
    requireThat(JSON.stringify(checked.connectedBodies) === JSON.stringify(mesh.connectedBodies) && JSON.stringify(checked.boundaryBodies) === JSON.stringify(mesh.boundaryBodies) && checked.nodeCount === mesh.nodeCount && checked.elementCount === mesh.elementCount, 'bad_mesh', 'Mesh metadata no longer matches its constituent files.');
    return { mesh, contents };
  }
  async configure(meshRef: ArtifactRef, input: unknown) {
    const { mesh, contents } = await this.loadMesh(meshRef);
    const config = normalizeThermal(input, mesh);
    validateBoundaryNodes(config, contents['mesh.boundary']);
    const dir = await this.artifacts.directory();
    const sif = await this.artifacts.put(dir, 'case.sif', generateSif(config), 'elmer-sif');
    const document = caseSchema.parse({ kind: 'simulation-case-v1', mesh: meshRef, config, sif });
    const artifact = await this.artifacts.put(dir, 'case.json', JSON.stringify(document), 'json');
    return { case: artifact, configuration: document };
  }
  private async persist(dir: string, state: Run) {
    await writeFile(join(dir, 'status.tmp'), JSON.stringify(runSchema.parse(state)), { mode: 0o600 });
    await rename(join(dir, 'status.tmp'), join(dir, 'status.json'));
  }
  async start(caseRef: ArtifactRef) {
    const document = await this.artifacts.json(caseRef, caseSchema);
    const { mesh, contents } = await this.loadMesh(document.mesh);
    const config = normalizeThermal(document.config, mesh);
    validateBoundaryNodes(config, contents['mesh.boundary']);
    const sifText = generateSif(config);
    requireThat((await this.artifacts.verify(document.sif, 'elmer-sif')).toString() === sifText, 'invalid_input', 'SIF must exactly match the typed, generated configuration.');
    const dir = await this.artifacts.directory();
    await mkdir(join(dir, 'mesh'), { mode: 0o700 });
    for (const name of meshFiles) await this.artifacts.put(join(dir, 'mesh'), name, contents[name], 'elmer-mesh', 'm');
    const sif = await this.artifacts.put(dir, 'case.sif', sifText, 'elmer-sif');
    const state: Run = {
      runId: basename(dir), status: 'preparing', createdAt: new Date().toISOString(), case: caseRef, source: mesh.source, mesh: document.mesh, sif,
      solver: { executable: 'ElmerSolver', version: 'pending solver banner' }, logs: [], outputs: [], results: [], summaries: [],
      convergence: 'not evaluated', diagnostics: ['Serial linear steady conduction in SI units; no contact resistance or radiation.', 'Timeout and captured-output bounds are enforced. OS memory/disk quotas are deployment policy, not guaranteed by this server.'],
    };
    await this.persist(dir, state);
    const abort = new AbortController();
    const entry = { abort, state, done: Promise.resolve() };
    this.active.set(state.runId, entry);
    entry.done = this.solve(dir, state, document, abort.signal).catch(() => {
      state.status = 'failed'; state.error = { code: 'persistence_failed', message: 'Could not persist run status; inspect workspace storage.' };
    }).finally(() => this.active.delete(state.runId));
    return structuredClone(state);
  }
  private async solve(dir: string, state: Run, document: Case, signal: AbortSignal) {
    try {
      await this.artifacts.verify(state.case, 'json');
      await this.artifacts.verify(state.sif, 'elmer-sif');
      await this.loadMesh(document.mesh);
      state.status = 'running'; state.startedAt = new Date().toISOString();
      await this.persist(dir, state);
      const result = await runProcess(this.settings.elmerSolver, ['case.sif'], dir, 'solver', this.settings.timeoutMs, signal);
      state.logs = await this.logs(dir, 'solver');
      state.solver.version = version(result, 'ElmerSolver');
      state.execution = { exitCode: result.exitCode, signal: result.signal, termination: result.status, timeoutMs: this.settings.timeoutMs };
      const failed = termination(result);
      // Keep generated outputs even when termination failed. Do not publish
      // summaries or a success status until all required output checks pass.
      const collectOutputs = async (directory: string): Promise<void> => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await collectOutputs(path);
          else if (entry.isFile() && (entry.name.endsWith('.vtu') || entry.name === 'scalars.dat' || entry.name === 'scalars.dat.names')) {
            state.outputs.push(await this.artifacts.capture(path, entry.name.endsWith('.vtu') ? 'vtu' : 'text', entry.name.endsWith('.vtu') ? 'm' : undefined));
          }
        }
      };
      await collectOutputs(dir);
      if (failed) throw new SimulationError(failed, 'Elmer execution failed; inspect retained logs and partial outputs.');
      const scalar = state.outputs.find(r => r.uri?.endsWith('/scalars.dat'));
      const names = state.outputs.find(r => r.uri?.endsWith('/scalars.dat.names'));
      requireThat(scalar && names, 'malformed_results', 'Elmer did not produce required scalar output.');
      const summaries = parseScalars((await this.artifacts.verify(scalar)).toString(), (await this.artifacts.verify(names)).toString(), scalar);
      const vtus = state.outputs.filter(r => r.format === 'vtu');
      requireThat(vtus.length > 0, 'malformed_results', 'Elmer did not produce VTU output.');
      const results = [];
      for (const artifact of vtus) results.push({ artifact, ...inspectVtu((await this.artifacts.verify(artifact)).toString()), coordinateUnits: 'm' as const });
      await this.artifacts.verify(state.case, 'json');
      await this.artifacts.verify(state.sif, 'elmer-sif');
      await this.loadMesh(document.mesh);
      state.results = results; state.summaries = summaries;
      state.convergence = 'Exit 0, no fatal/nonconvergence diagnostics, finite VTU and scalars, positive Temperature NonlinConverged flag; linear abort-on-nonconvergence enabled.';
      state.status = 'succeeded';
    } catch (error) {
      const data = errorData(error);
      state.status = data.code === 'timeout' ? 'timeout' : data.code === 'cancelled' ? 'cancelled' : 'failed';
      state.error = { code: data.code, message: data.message };
      state.convergence = 'not established';
    } finally {
      state.endedAt = new Date().toISOString();
      await this.persist(dir, state);
    }
  }
  async status(runId: string) {
    id.parse(runId);
    const live = this.active.get(runId);
    const state = live ? structuredClone(live.state) : runSchema.parse(JSON.parse((await this.artifacts.bytes(pathToFileURL(join(this.artifacts.workspace, runId, 'status.json')).href)).toString()));
    if (!live && ['running', 'preparing'].includes(state.status)) {
      state.status = 'interrupted'; state.convergence = 'not established';
      state.diagnostics.push('No active process is owned by this server instance. Previous process may have been interrupted; inspect workspace before starting a new run.');
    }
    if (state.status === 'succeeded') {
      await this.artifacts.verify(state.case); await this.artifacts.verify(state.sif);
      await this.loadMesh(state.mesh);
      for (const ref of [...state.logs, ...state.outputs]) await this.artifacts.verify(ref);
    }
    return runSchema.parse(state);
  }
  async cancel(runId: string) {
    id.parse(runId);
    const live = this.active.get(runId);
    requireThat(live, 'invalid_input', 'Run is not active in this server instance.');
    live.abort.abort(); await live.done;
    return this.status(runId);
  }
  async close() {
    const active = [...this.active.values()];
    active.forEach(run => run.abort.abort());
    await Promise.allSettled(active.map(run => run.done));
  }
}

function version(result: ProcessResult, executable: string) {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
  return lines.filter(line => /version|revision|git sha|ElmerGrid|ElmerSolver/i.test(line)).slice(0, 8).map(s => s.trim()).join('; ').slice(0, 1200) || `${executable}: version not present in process banner; see revisioned logs`;
}
