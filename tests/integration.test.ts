import { expect, it } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { service, fixture, barSelections, controls, waitForRun, temporary } from './helpers.js';
import { Simulation } from '../src/service.js';

it('completes STEP → explicit groups → native mesh → SIF → Elmer → analytic thermal results', async () => {
  const simulation = await service();
  try {
    const inspected = await simulation.inspect({ uri: pathToFileURL(fixture).href });
    expect(inspected.inventory.sourceUnits).toBe('mm');
    expect(inspected.inventory.scaleToMeters).toBe(0.001);
    const volume = inspected.inventory.entities.find(e => e.dimension === 3)!;
    expect(volume.measure).toBeCloseTo(0.00001, 10);
    expect(volume.bounds[3] - volume.bounds[0]).toBeCloseTo(0.1, 5);
    const selected = barSelections(inspected.inventory);
    const proposal = await simulation.propose(inspected.source, inspected.inspection, controls);
    expect(proposal.inventory).toEqual(inspected.inventory);
    const meshed = await simulation.mesh(inspected.source, inspected.inspection, controls, selected.groups);
    expect(meshed.metadata.groups.every(g => g.elements > 0)).toBe(true);
    expect(meshed.metadata.groups.map(g => g.id)).toEqual(selected.groups.map(g => g.id));
    expect(meshed.metadata.elementCount).toBeGreaterThan(0);
    expect(meshed.metadata.minimumQuality).toBeGreaterThan(0);
    expect(Object.values(meshed.metadata.files).every(f => f.format === 'elmer-mesh' && !f.uri?.endsWith('/mesh'))).toBe(true);
    const configured = await simulation.configure(meshed.mesh, selected.config);
    const started = await simulation.start(configured.case);
    const run = await waitForRun(simulation, started.runId);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(run.solver.version).toMatch(/Elmer|version/i);
    const scalar = (name: string) => run.summaries.find(s => s.name === name)!.value;
    expect(Math.abs(scalar('temperature_min') - 300)).toBeLessThan(0.1);
    expect(Math.abs(scalar('temperature_max') - 400)).toBeLessThan(0.1);
    expect(Math.abs(scalar('heat_flux_magnitude_mean') - 10000) / 10000).toBeLessThan(0.01);
    // Independent benchmark geometry gives A=1e-4 m²; this derivation is
    // benchmark-only, never advertised as a generic integrated heat flow.
    expect(Math.abs(scalar('heat_flux_magnitude_mean') * 0.0001 - 1)).toBeLessThan(0.01);
    const vtu = (await simulation.artifacts.verify(run.results[0].artifact)).toString();
    const positions = vtu.match(/<Points>\s*<DataArray[^>]*>([\s\S]*?)<\/DataArray>/)![1].trim().split(/\s+/).map(Number);
    const temperatures = vtu.match(/<DataArray[^>]*Name="temperature"[^>]*>([\s\S]*?)<\/DataArray>/i)![1].trim().split(/\s+/).map(Number);
    expect(positions.length).toBe(3 * temperatures.length);
    temperatures.forEach((t, i) => expect(Math.abs(t - (400 - 1000 * positions[3*i]))).toBeLessThan(0.1));
    const restarted = await Simulation.create(simulation.settings);
    expect((await restarted.status(run.runId)).status).toBe('succeeded');

    simulation.settings.elmerSolver = '/nonexistent-ElmerSolver';
    const missing = await waitForRun(simulation, (await simulation.start(configured.case)).runId);
    expect(missing.status).toBe('failed');
    expect(missing.error?.code).toBe('spawn_error');
    expect(missing.logs).toHaveLength(2);
    expect((await simulation.status(run.runId)).status).toBe('succeeded');

    const fake = join(await temporary(), 'fake-solver.mjs');
    await writeFile(fake, `#!${process.execPath}\nconsole.log('ElmerSolver test double');\n`, { mode: 0o700 });
    simulation.settings.elmerSolver = fake;
    const noOutput = await waitForRun(simulation, (await simulation.start(configured.case)).runId);
    expect(noOutput.status).toBe('failed');
    expect(noOutput.error?.code).toBe('malformed_results');
    await writeFile(fake, `#!${process.execPath}\nconsole.error('ERROR: forced failure');process.exit(9);\n`);
    const solverError = await waitForRun(simulation, (await simulation.start(configured.case)).runId);
    expect(solverError.execution?.exitCode).toBe(9);
    expect(solverError.status).toBe('failed');
    await writeFile(fake, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
    simulation.settings.timeoutMs = 50;
    const timedOut = await waitForRun(simulation, (await simulation.start(configured.case)).runId);
    expect(timedOut.status).toBe('timeout');
    simulation.settings.timeoutMs = 120000;
    const cancelled = await simulation.start(configured.case);
    expect((await simulation.cancel(cancelled.runId)).status).toBe('cancelled');

    // Exact-byte result revision verification applies after server restarts.
    const resultPath = fileURLToPath(run.results[0].artifact.uri!);
    await chmod(resultPath, 0o600);
    await writeFile(resultPath, (await readFile(resultPath, 'utf8')) + '\n');
    await expect(restarted.status(run.runId)).rejects.toMatchObject({ code: 'stale_artifact' });
  } finally { await simulation.close(); }
}, 240000);

it('rejects malformed STEP without invoking another service', async () => {
  const root = await temporary();
  await writeFile(join(root, 'bad.step'), 'not STEP');
  const simulation = await service({ roots: [root] });
  try {
    await expect(simulation.inspect({ uri: pathToFileURL(join(root, 'bad.step')).href })).rejects.toMatchObject({ code: 'unsupported_format' });
    await writeFile(join(root, 'bad.step'), 'ISO-10303-21;\nmalformed\n');
    await expect(simulation.inspect({ uri: pathToFileURL(join(root, 'bad.step')).href })).rejects.toMatchObject({ code: 'process_failed' });
  } finally { await simulation.close(); }
}, 30000);
