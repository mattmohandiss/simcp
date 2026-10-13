import { requireThat } from './errors.js';
import type { Group, Inventory } from './schemas.js';

export const meshFiles = ['mesh.header', 'mesh.nodes', 'mesh.elements', 'mesh.boundary'] as const;
const rows = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).map(line => line.trim().split(/\s+/).map(Number));
export function validateGroups(groups: Group[], inventory: Inventory) {
  const seen = new Set<string>(), ids = new Set<number>(), names = new Set<string>();
  const all = new Set(inventory.entities.map(e => `${e.dimension}:${e.tag}`));
  for (const group of groups) {
    requireThat(group.dimension !== 3 || group.entities.length === 1, 'bad_groups', 'V1 requires one imported solid per volume group so disconnected constraints remain explicit.');
    requireThat(!ids.has(group.id) && !names.has(group.name), 'bad_groups', 'Group IDs and names must be unique across dimensions.');
    ids.add(group.id); names.add(group.name);
    for (const entity of group.entities) {
      const key = `${group.dimension}:${entity}`;
      requireThat(all.has(key) && !seen.has(key), 'bad_groups', 'Unknown or multiply assigned entity.');
      seen.add(key);
    }
  }
  requireThat(seen.size === all.size, 'bad_groups', 'Explicitly assign every imported volume and surface, including insulated surfaces.');
}

// Compare connectivity AND group IDs against MSH2.2, independent of node/element
// renumbering by ElmerGrid. Coordinate keys avoid relying on label preservation.
export function validateConversion(msh: string, files: Record<typeof meshFiles[number], string>, groups: (Group & { elements: number })[]) {
  const section = (name: string) => {
    const match = msh.match(new RegExp(`\\$${name}\\r?\\n([\\s\\S]*?)\\$End${name}`));
    requireThat(match, 'bad_mesh', `Missing MSH ${name}.`);
    const data = rows(match[1]);
    requireThat(data[0][0] === data.length - 1, 'bad_mesh', `Malformed MSH ${name} count.`);
    return data.slice(1);
  };
  requireThat(msh.includes('2.2 0 8'), 'bad_mesh', 'Expected ASCII MSH 2.2.');
  const sourceNodes = new Map(section('Nodes').map(r => [r[0], r.slice(1)]));
  const nativeNodes = new Map(rows(files['mesh.nodes']).map(r => [r[0], r.slice(2)]));
  const coordinate = (xyz: number[] | undefined) => {
    requireThat(xyz?.length === 3 && xyz.every(Number.isFinite), 'bad_mesh', 'Invalid node coordinate.');
    return xyz.map(n => n === 0 ? '0' : n.toPrecision(12)).join(',');
  };
  const signature = (group: number, nodes: number[], map: Map<number, number[]>) => `${group}:${nodes.map(n => coordinate(map.get(n))).sort().join(';')}`;
  const expected = new Map<string, number>();
  for (const row of section('Elements')) {
    const type = row[1], tags = row[2];
    requireThat((type === 2 || type === 4) && tags >= 2 && row.length === 3 + tags + (type === 2 ? 3 : 4), 'bad_mesh', 'Unexpected MSH element.');
    const key = signature(row[3], row.slice(3 + tags), sourceNodes);
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  const volumes = rows(files['mesh.elements']);
  const boundaries = rows(files['mesh.boundary']);
  const header = rows(files['mesh.header'])[0];
  requireThat(header?.[0] === nativeNodes.size && header[1] === volumes.length && header[2] === boundaries.length && nativeNodes.size === sourceNodes.size, 'bad_mesh', 'Native mesh header/count mismatch.');
  const counts = new Map<number, number>();
  const bodyByElement = new Map<number, number>();
  const bodiesAtNode = new Map<number, Set<number>>();
  const consume = (row: number[], dimension: number) => {
    const offset = dimension === 3 ? 3 : 5;
    const type = row[offset - 1];
    requireThat(row.every(Number.isFinite) && type === (dimension === 3 ? 504 : 303) && row.length === offset + (dimension === 3 ? 4 : 3), 'bad_mesh', 'Unexpected native element.');
    requireThat(groups.some(g => g.id === row[1] && g.dimension === dimension), 'bad_groups', 'Native element has unknown physical group.');
    const key = signature(row[1], row.slice(offset), nativeNodes);
    requireThat((expected.get(key) ?? 0) > 0, 'bad_groups', 'ElmerGrid changed group membership/connectivity.');
    expected.set(key, expected.get(key)! - 1);
    counts.set(row[1], (counts.get(row[1]) ?? 0) + 1);
    if (dimension === 3) {
      requireThat(!bodyByElement.has(row[0]), 'bad_mesh', 'Duplicate native element ID.');
      bodyByElement.set(row[0], row[1]);
      for (const node of row.slice(offset)) {
        const bodies = bodiesAtNode.get(node) ?? new Set<number>();
        bodies.add(row[1]); bodiesAtNode.set(node, bodies);
      }
    }
  };
  volumes.forEach(r => consume(r, 3));
  boundaries.forEach(r => consume(r, 2));
  requireThat([...expected.values()].every(n => n === 0), 'bad_groups', 'ElmerGrid lost elements.');
  for (const group of groups) requireThat(counts.get(group.id) === group.elements, 'bad_groups', 'Converted group count mismatch.');
  const boundaryBodies: Record<string, number[]> = {};
  for (const row of boundaries) {
    // V1 supports external thermal BCs only. Internal interfaces must be
    // conformal but cannot carry conflicting user-selected surface conditions.
    requireThat(row[2] > 0 && row[3] === 0 && bodyByElement.has(row[2]), 'bad_mesh', 'V1 requires exterior boundary groups; internal/orphan boundaries are unsupported.');
    boundaryBodies[row[1]] = [...new Set([...(boundaryBodies[row[1]] ?? []), bodyByElement.get(row[2])!])].sort((a,b) => a-b);
  }
  const components = groups.filter(g => g.dimension === 3).map(g => new Set([g.id]));
  for (const shared of bodiesAtNode.values()) {
    const matches = components.filter(c => [...shared].some(id => c.has(id)));
    if (matches.length > 1) {
      for (const other of matches.slice(1)) {
        for (const id of other) matches[0].add(id);
        components.splice(components.indexOf(other), 1);
      }
    }
  }
  return { nodeCount: nativeNodes.size, elementCount: volumes.length, connectedBodies: components.map(c => [...c].sort((a,b) => a-b)), boundaryBodies };
}
