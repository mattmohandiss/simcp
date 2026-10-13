import { describe, expect, it } from 'vitest';
import { symlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Artifacts, digest } from '../src/artifacts.js';
import { artifactSchema, thermalSchema, type Thermal } from '../src/schemas.js';
import { generateSif, normalizeThermal, validateBoundaryNodes } from '../src/thermal.js';
import { validateConversion } from '../src/mesh.js';
import { parseScalars, inspectVtu } from '../src/results.js';
import { temporary } from './helpers.js';

describe('artifact inputs and exact bytes', () => {
  it('accepts supported artifact formats and rejects invalid references', () => {
    const revision = `sha256:${'a'.repeat(64)}`;
    const refs = ['step', 'gmsh-msh', 'elmer-mesh', 'vtu', 'elmer-sif', 'text', 'json']
      .map((format) => ({ revision, uri: `file:///tmp/artifact.${format}`, format }));
    for (const ref of refs) expect(artifactSchema.safeParse(ref).success).toBe(true);
    expect(artifactSchema.safeParse({ ...refs[0], revision: 'current' }).success).toBe(false);
    expect(artifactSchema.safeParse({ ...refs[0], format: 'directory' }).success).toBe(false);
    expect(artifactSchema.safeParse({ ...refs[0], arbitrary: true }).success).toBe(false);
    expect(digest('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(digest('abc\n')).not.toBe(digest('abc'));
  });
  it('rejects stale data, paths outside configured roots, traversal and directories', async () => {
    const workspace = await temporary(), input = await temporary(), outside = await temporary();
    const artifacts = await Artifacts.create(workspace, [input]);
    const source = join(input, 'input.step');
    await writeFile(source, 'abc');
    const ref = { revision: digest('abc'), uri: pathToFileURL(source).href, format: 'step' };
    const snapshot = await artifacts.put(await artifacts.directory(), 'source.step', await artifacts.verify(ref), 'step');
    await writeFile(source, 'changed');
    await expect(artifacts.verify(ref)).rejects.toMatchObject({ code: 'stale_artifact' });
    expect((await artifacts.verify(snapshot)).toString()).toBe('abc');
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(outside, join(input, 'escape'), 'junction');
    await expect(artifacts.bytes(pathToFileURL(join(input, 'escape', 'secret')).href)).rejects.toMatchObject({ code: 'path_policy' });
    await expect(artifacts.bytes(`${pathToFileURL(`${input}${sep}`).href}nested/../input.step`)).rejects.toMatchObject({ code: 'path_policy' });
    await expect(artifacts.bytes('https://example.com/model.step')).rejects.toMatchObject({ code: 'path_policy' });
    await expect(artifacts.bytes(pathToFileURL(input).href)).rejects.toMatchObject({ code: 'path_policy' });
  });
});

const ref = { format: 'text', revision: digest('fixture') };
const mesh = {
  groups: [
    { id: 1, name: 'volume', dimension: 3 as const, entities: [1], elements: 1 },
    { id: 2, name: 'hot', dimension: 2 as const, entities: [2], elements: 2 },
    { id: 3, name: 'insulated', dimension: 2 as const, entities: [3], elements: 3 },
  ],
  connectedBodies: [[1]], boundaryBodies: { '2': [1], '3': [1] },
};
const config: Thermal = {
  physics: 'steady-heat-conduction', materials: [{ group: 1, conductivity: { value: 10, units: 'W/(m.K)' } }], sources: [],
  boundaries: [{ group: 2, kind: 'temperature', temperature: { value: 400, units: 'K' } }, { group: 3, kind: 'insulated' }],
};
describe('thermal engineering inputs', () => {
  it('requires complete material and boundary coverage, known units and constrained components', () => {
    expect(() => normalizeThermal({ ...config, materials: [] }, mesh)).toThrow();
    expect(() => normalizeThermal({ ...config, boundaries: [config.boundaries[0]] }, mesh)).toThrow();
    expect(() => normalizeThermal({ ...config, boundaries: [{ group: 2, kind: 'insulated' }, config.boundaries[1]] }, mesh)).toThrow();
    expect(() => normalizeThermal({ ...config, sources: [{ group: 999, heat: { value: 1, units: 'W/m3' } }] }, mesh)).toThrow();
    expect(thermalSchema.safeParse({ ...config, physics: 'transient' }).success).toBe(false);
    expect(thermalSchema.safeParse({ ...config, materials: [{ group: 1, conductivity: { value: -1, units: 'W/(m.K)' } }] }).success).toBe(false);
    expect(thermalSchema.safeParse({ ...config, materials: [{ group: 1, conductivity: { value: 1, units: 'W' } }] }).success).toBe(false);
    expect(() => normalizeThermal({ ...config, materials: [config.materials[0], config.materials[0]] }, mesh)).toThrow();
    expect(() => normalizeThermal(config, { ...mesh, connectedBodies: [[1], [8]] })).toThrow();
  });
  it('generates deterministic numeric-only SIF and rejects conflicting nodal temperatures', () => {
    const normalized = normalizeThermal(config, mesh);
    expect(generateSif(normalized)).toBe(generateSif(normalizeThermal({ ...config, boundaries: [...config.boundaries].reverse() }, mesh)));
    const sif = generateSif(normalized);
    expect(sif).toContain('Heat Conductivity = 10');
    expect(sif).toContain('Temperature = 400');
    const sourced = normalizeThermal({ ...config, sources: [{ group: 1, heat: { value: 20, units: 'W/m3' } }] }, mesh);
    expect(generateSif(sourced)).toContain('Volumetric Heat Source = 20');
    expect(thermalSchema.safeParse({ ...config, procedure: 'evil' }).success).toBe(false);
    const conflict: Thermal = { ...config, boundaries: [config.boundaries[0], { group: 3, kind: 'temperature', temperature: { value: 300, units: 'K' } }] };
    expect(() => validateBoundaryNodes(conflict, '1 2 1 0 303 1 2 3\n2 3 1 0 303 2 3 4')).toThrow(/shared mesh node/);
  });
});

describe('conversion membership', () => {
  const msh = '$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$Nodes\n4\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n$EndNodes\n$Elements\n5\n1 4 2 1 1 1 2 3 4\n2 2 2 2 1 1 2 3\n3 2 2 2 2 1 2 4\n4 2 2 2 3 1 3 4\n5 2 2 2 4 2 3 4\n$EndElements\n';
  const files = { 'mesh.header': '4 1 4\n2\n504 1\n303 4', 'mesh.nodes': '11 -1 0 0 0\n12 -1 1 0 0\n13 -1 0 1 0\n14 -1 0 0 1', 'mesh.elements': '9 1 504 11 12 13 14', 'mesh.boundary': '1 2 9 0 303 11 12 13\n2 2 9 0 303 11 12 14\n3 2 9 0 303 11 13 14\n4 2 9 0 303 12 13 14' };
  const groups = [{ id: 1, name: 'volume', dimension: 3 as const, entities: [1], elements: 1 }, { id: 2, name: 'surface', dimension: 2 as const, entities: [1,2,3,4], elements: 4 }];
  it('accepts renumbered nodes but checks IDs, connectivity, counts and boundary parents', () => {
    expect(validateConversion(msh, files, groups)).toMatchObject({ nodeCount: 4, elementCount: 1, connectedBodies: [[1]], boundaryBodies: { '2': [1] } });
    expect(() => validateConversion(msh, { ...files, 'mesh.elements': '9 2 504 11 12 13 14' }, groups)).toThrow();
    expect(() => validateConversion(msh, { ...files, 'mesh.elements': '9 1 504 11 12 13 13' }, groups)).toThrow();
    expect(() => validateConversion(msh, { ...files, 'mesh.boundary': files['mesh.boundary'].replace('9 0', '0 0') }, groups)).toThrow();
    expect(() => validateConversion(msh, files, [{ ...groups[0], elements: 2 }, groups[1]])).toThrow();
  });
});

describe('result semantics', () => {
  const names = 'Metadata\n1: min: temperature\n2: max: temperature\n3: mean: temperature\n4: mean: temperature flux_mag\n5: nonlin converged: temperature';
  it('uses named scalar columns, SI units and convergence evidence rather than successful exit alone', () => {
    const result = parseScalars('300 400 350 1.0D+4 1\n', names, ref);
    expect(result.find(s => s.name === 'heat_flux_magnitude_mean')).toMatchObject({ value: 10000, units: 'W/m2', source: ref });
    expect(() => parseScalars('300 400 350 10000 0', names, ref)).toThrow(/convergence/);
    expect(() => parseScalars('300 NaN 350 10000 1', names, ref)).toThrow();
    expect(() => parseScalars('300 400 350 10000 1', '', ref)).toThrow();
    expect(() => inspectVtu('<VTKFile/>')).toThrow();
    expect(() => inspectVtu('<!DOCTYPE VTKFile SYSTEM "file:///secret"><VTKFile/>')).toThrow();
  });
});
