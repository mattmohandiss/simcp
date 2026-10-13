#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { artifactSchema, caseSchema, controlsSchema, groupSchema, id, inventorySchema, meshSchema, thermalSchema } from './schemas.js';
import { Simulation, runSchema } from './service.js';
import { errorData } from './errors.js';

export function createServer(simulation: Simulation) {
  const server = new McpServer({ name: 'simulation-mcp-server', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
  const output = async <T extends Record<string, unknown>>(fn: () => Promise<T>) => {
    try {
      const data = await fn();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(errorData(error)) }], isError: true };
    }
  };
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  server.registerTool('inspect_source', {
    description: 'Snapshot a local STEP, verify exact bytes and inspect SI-normalized OCC topology. Supply exactly one URI or ArtifactRef. Labels are hints; entity IDs are revision/importer scoped.',
    inputSchema: z.strictObject({ uri: z.string().optional(), source: artifactSchema.optional() }),
    outputSchema: z.strictObject({ source: artifactSchema, inspection: artifactSchema, inventory: inventorySchema, logs: z.array(artifactSchema) }), annotations,
  }, (args, ctx) => output(() => simulation.inspect(args, ctx.mcpReq.signal)));
  server.registerTool('propose_mesh', {
    description: 'Reverify STEP/inspection refs and present the candidate inventory with requested mesh sizes in meters. Caller must explicitly choose all volume and boundary groups; no engineering choices are inferred.',
    inputSchema: z.strictObject({ source: artifactSchema, inspection: artifactSchema, controls: controlsSchema }),
    outputSchema: z.strictObject({ source: artifactSchema, inspection: artifactSchema, controls: controlsSchema, inventory: inventorySchema, diagnostics: z.array(z.string()) }),
    annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
  }, args => output(() => simulation.propose(args.source, args.inspection, args.controls)));
  server.registerTool('generate_mesh', {
    description: 'Generate ASCII MSH2.2 tetrahedra and convert with ElmerGrid. Explicitly partition all surfaces and volumes into disjoint groups; one solid per volume group. Verifies nonempty native group membership. No CAD repair, contact or internal-interface BCs.',
    inputSchema: z.strictObject({ source: artifactSchema, inspection: artifactSchema, controls: controlsSchema, groups: z.array(groupSchema).min(1) }),
    outputSchema: z.strictObject({ mesh: artifactSchema, metadata: meshSchema }), annotations,
  }, (args, ctx) => output(() => simulation.mesh(args.source, args.inspection, args.controls, args.groups, ctx.mcpReq.signal)));
  server.registerTool('configure_thermal_case', {
    description: 'Validate steady isotropic conduction: W/(m.K) per volume, optional W/m3 sources, and an explicit K temperature, inward W/m2 flux or insulation per surface group. Each disconnected component needs a fixed temperature. Persist normalized config and deterministic SIF.',
    inputSchema: z.strictObject({ mesh: artifactSchema, config: thermalSchema }),
    outputSchema: z.strictObject({ case: artifactSchema, configuration: caseSchema }), annotations,
  }, args => output(() => simulation.configure(args.mesh, args.config)));
  server.registerTool('run_analysis', {
    description: 'Reverify every case/mesh input, stage an isolated run and start configured ElmerSolver asynchronously. Returns an opaque runId; poll inspect_run. Arbitrary SIF/procedures/commands are never accepted.',
    inputSchema: z.strictObject({ case: artifactSchema }), outputSchema: runSchema, annotations,
  }, args => output(() => simulation.start(args.case)));
  server.registerTool('inspect_run', {
    description: 'Read persisted run status, provenance, exit/timeout/convergence evidence, per-file VTU/log refs and supported SI scalar summaries. Failed/interrupted runs remain inspectable. Successful artifact revisions are rechecked.',
    inputSchema: z.strictObject({ runId: id }), outputSchema: runSchema,
    annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
  }, args => output(() => simulation.status(args.runId)));
  server.registerTool('cancel_run', {
    description: 'Terminate the process group of an active run owned by this server; retain logs and partial outputs. Does not delete files.',
    inputSchema: z.strictObject({ runId: id }), outputSchema: runSchema, annotations,
  }, args => output(() => simulation.cancel(args.runId)));
  server.registerResource('simulation-workflow', 'simulation://workflow', { mimeType: 'text/plain', description: 'Staged steady thermal workflow and engineering limits.' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'inspect_source → propose_mesh → explicit generate_mesh groups → configure_thermal_case → run_analysis → inspect_run. Confirm engineering selections with the user. All surface conditions, including insulation, are explicit. No automatic material lookup, inference, CAD repair or certification. Local shared filesystem only. Retention is manual; do not remove active run directories.' }] }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const roots = JSON.parse(process.env.SIMULATION_INPUT_ROOTS ?? '[]') as unknown;
  const configuredRoots = z.array(z.string().min(1)).min(1).parse(roots);
  const simulation = await Simulation.create({
    workspace: resolve(process.env.SIMULATION_WORKSPACE ?? '.simulation-runs'), roots: configuredRoots,
    python: process.env.SIMULATION_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), elmerGrid: process.env.SIMULATION_ELMERGRID ?? 'ElmerGrid',
    elmerSolver: process.env.SIMULATION_ELMERSOLVER ?? 'ElmerSolver', timeoutMs: Number(process.env.SIMULATION_TIMEOUT_MS ?? 120000),
  });
  const handle = serveStdio(() => createServer(simulation), { legacy: 'reject' });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { await simulation.close(); await handle.close(); })();
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  process.stdin.once('end', () => void close());
}
