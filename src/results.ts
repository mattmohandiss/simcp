import { requireThat } from './errors.js';
import type { ArtifactRef } from './schemas.js';

export function parseScalars(data: string, names: string, source: ArtifactRef) {
  const lines = data.trim().split(/\r?\n/).filter(s => s.trim() && !s.trim().startsWith('#'));
  requireThat(lines.length > 0, 'malformed_results', 'Missing scalar data.');
  const values = lines.at(-1)!.trim().split(/\s+/).map(s => Number(s.replace(/[dD]/, 'e')));
  requireThat(values.every(Number.isFinite), 'malformed_results', 'Nonfinite scalar output.');
  const columns = new Map<string, number>();
  for (const line of names.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s*:\s*(.+?)\s*$/);
    if (match) columns.set(match[2].toLowerCase(), Number(match[1])-1);
  }
  const value = (name: string) => {
    const index = columns.get(name);
    requireThat(index !== undefined && Number.isFinite(values[index]), 'malformed_results', `Missing scalar column: ${name}.`);
    return values[index];
  };
  requireThat(value('nonlin converged: temperature') > 0, 'solver_failed', 'Heat solver did not report nonlinear convergence.');
  return [
    { name: 'temperature_min', value: value('min: temperature'), units: 'K', method: 'Elmer SaveScalars nodal minimum' },
    { name: 'temperature_max', value: value('max: temperature'), units: 'K', method: 'Elmer SaveScalars nodal maximum' },
    { name: 'temperature_mean', value: value('mean: temperature'), units: 'K', method: 'Elmer SaveScalars unweighted nodal mean (not volume mean)' },
    { name: 'heat_flux_magnitude_mean', value: value('mean: temperature flux_mag'), units: 'W/m2', method: 'Elmer FluxSolver projected magnitude; SaveScalars unweighted nodal mean (not integrated heat flow)' },
  ].map(s => ({ ...s, source }));
}

// Narrow validator for the ASCII VTU emitted by the generated SIF, not a
// general XML/VTK reader. Reject external entities, appended/binary payloads.
export function inspectVtu(text: string) {
  requireThat(!/<!DOCTYPE|<!ENTITY|<AppendedData/i.test(text) && /<VTKFile\b[^>]*type="UnstructuredGrid"/.test(text) && /<\/VTKFile>\s*$/.test(text), 'malformed_results', 'Expected complete ASCII unstructured-grid VTU.');
  const piece = text.match(/<Piece\b[^>]*NumberOfPoints="(\d+)"[^>]*NumberOfCells="(\d+)"/);
  requireThat(piece && Number(piece[1]) > 0 && Number(piece[2]) > 0, 'malformed_results', 'Empty/malformed VTU piece.');
  const points = Number(piece[1]);
  const arrayValues = (array: RegExpMatchArray | undefined | null) => {
    requireThat(array && /\bformat="ascii"/i.test(array[1]), 'malformed_results', 'Missing ASCII VTU geometry array.');
    const values = array[2].trim().split(/\s+/).map(Number);
    requireThat(values.length > 0 && values.every(Number.isFinite), 'malformed_results', 'Nonfinite VTU geometry.');
    return values;
  };
  const pointBlock = text.match(/<Points\b[^>]*>([\s\S]*?)<\/Points>/)?.[1];
  const xyz = arrayValues(pointBlock?.match(/<DataArray\b([^>]*)>([\s\S]*?)<\/DataArray>/));
  requireThat(xyz.length === 3 * points, 'malformed_results', 'VTU point count mismatch.');
  const cellBlock = text.match(/<Cells\b[^>]*>([\s\S]*?)<\/Cells>/)?.[1];
  const cells = (name: string) => arrayValues(cellBlock?.match(new RegExp(`<DataArray\\b([^>]*Name="${name}"[^>]*)>([\\s\\S]*?)<\\/DataArray>`)));
  const connectivity = cells('connectivity'), offsets = cells('offsets'), types = cells('types');
  requireThat(connectivity.every(n => Number.isInteger(n) && n >= 0 && n < points), 'malformed_results', 'VTU connectivity references unknown points.');
  requireThat(offsets.length === Number(piece[2]) && types.length === offsets.length && offsets.at(-1) === connectivity.length, 'malformed_results', 'VTU cell counts mismatch.');
  let previous = 0;
  offsets.forEach((offset, i) => {
    const size = types[i] === 10 ? 4 : types[i] === 5 ? 3 : undefined;
    requireThat(size && offset - previous === size, 'malformed_results', 'Expected linear tetrahedra/triangles in VTU.');
    previous = offset;
  });
  const fields: { name: string; components: number; association: string; units?: string }[] = [];
  for (const [association, block] of [['point', text.match(/<PointData\b[^>]*>([\s\S]*?)<\/PointData>/)?.[1]], ['cell', text.match(/<CellData\b[^>]*>([\s\S]*?)<\/CellData>/)?.[1]]] as const) {
    for (const array of (block ?? '').matchAll(/<DataArray\b([^>]*)>([\s\S]*?)<\/DataArray>/g)) {
      const name = array[1].match(/\bName="([^"]+)"/)?.[1];
      requireThat(name && /\bformat="ascii"/i.test(array[1]), 'malformed_results', 'Expected named ASCII VTU field.');
      const components = Number(array[1].match(/NumberOfComponents="(\d+)"/)?.[1] ?? 1);
      const values = array[2].trim().split(/\s+/).map(Number);
      requireThat(values.every(Number.isFinite) && values.length === components * (association === 'point' ? points : Number(piece[2])), 'malformed_results', 'Invalid VTU field length/values.');
      const lower = name.toLowerCase();
      fields.push({ name, components, association, ...(lower === 'temperature' ? { units: 'K' } : lower.startsWith('temperature flux') ? { units: 'W/m2' } : {}) });
    }
  }
  requireThat(fields.some(f => f.name.toLowerCase() === 'temperature' && f.association === 'point' && f.components === 1), 'malformed_results', 'Temperature field missing from VTU.');
  return { pointCount: points, cellCount: Number(piece[2]), fields, frame: 'step-world-si', coordinateUnits: 'm' };
}
