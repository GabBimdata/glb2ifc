import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/studio/geometry.js';
import * as M from '../src/studio/model.js';
import { extrude, extrudeWithHoles, buildElements } from '../src/studio/build.js';
import { equipmentParts } from '../src/studio/equipment-models.js';
import { exportIfc } from '../src/studio/ifc-export.js';

const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
function volume(mesh) {
  const origin = mesh.positions[0];
  return mesh.triangles.reduce((v, t) => {
    const [a, b, c] = t.map((i) => sub(mesh.positions[i], origin));
    return v + dot(a, cross(b, c)) / 6;
  }, 0);
}

function outwardConvex(mesh) {
  const center = [0, 1, 2].map((axis) => mesh.positions.reduce((s, p) => s + p[axis], 0) / mesh.positions.length);
  assert.ok(volume(mesh) > 0, 'positive signed volume');
  for (const t of mesh.triangles) {
    const [a, b, c] = t.map((i) => mesh.positions[i]);
    assert.ok(dot(cross(sub(b, a), sub(c, a)), sub(a, center)) > 1e-12, 'every face points away from the interior');
  }
}

function closedOriented(mesh) {
  const edges = new Map();
  for (const t of mesh.triangles) {
    const ids = t.map((i) => mesh.positions[i].map((v) => Math.round(v * 1e7)).join(','));
    for (let i = 0; i < 3; i++) {
      const a = ids[i], b = ids[(i + 1) % 3];
      const key = [a, b].sort().join('/');
      const uses = edges.get(key) || [];
      uses.push(a < b ? 1 : -1);
      edges.set(key, uses);
    }
  }
  for (const uses of edges.values()) {
    assert.equal(uses.length, 2, 'each geometric edge has two faces');
    assert.equal(uses[0] + uses[1], 0, 'adjacent faces traverse their edge in opposite directions');
  }
}

test('vertical and sloped prisms point outwards for either contour winding', () => {
  const contour = [[0, 0], [4, 0], [4, 3], [0, 3]];
  for (const poly of [contour, contour.toReversed()]) {
    const original = structuredClone(poly);
    for (const mesh of [extrude(poly, 0, 2), G.slopedPrism(poly, ([x]) => 2 + x / 4, -0.2, 0), G.prismVarTop(poly, 0, ([x]) => 2 + x / 4)]) {
      outwardConvex(mesh);
      closedOriented(mesh);
    }
    assert.deepEqual(poly, original, 'input contour is not mutated');
  }
});

test('perforated slabs orient outer and hole walls independently of supplied winding', () => {
  const outer = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const hole = [[1, 1], [2, 1], [2, 2], [1, 2]];
  for (const o of [outer, outer.toReversed()]) for (const h of [hole, hole.toReversed()]) {
    const before = structuredClone([o, h]);
    const mesh = extrudeWithHoles(o, [h], 0, 2);
    closedOriented(mesh);
    assert.ok(Math.abs(volume(mesh) - 22) < 1e-9, 'volume is outer prism minus hole');
    assert.deepEqual([o, h], before);
  }
});

test('washer cylinders preserve outward faces when their axes are swapped', () => {
  const parts = equipmentParts({ type: 'washer', width: 0.6, depth: 0.6, height: 0.85 });
  for (const { mesh } of parts) { outwardConvex(mesh); closedOriented(mesh); }
});

function attic(reverse, angle) {
  const store = new M.Store(M.newProject('Normals regression'));
  store.commit('walls and attic', (p) => {
    const l = p.levels[0];
    const rotate = ([x, y]) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
    const poly = [[0, 0], [10, 0], [10, 8], [0, 8]].map(rotate);
    for (let i = 0; i < 4; i++) {
      const a = poly[i], b = poly[(i + 1) % 4];
      M.addWall(l, reverse ? b : a, reverse ? a : b, { type: 'ext30' });
    }
    M.addWall(l, rotate([5, 0]), rotate([5, 8]), { type: 'part10' });
    l.attic = { enabled: true, kneeWall: 0.9, ceilingHeight: 2.5 };
    Object.assign(p.bodies[0].roof, { type: 'gable', pitch: 35 });
    l.walls[1].openings.push({ id: 'test-window', type: 'window', kind: 'window', offset: 4, width: 1, height: 1, sill: 1.2 });
  });
  return store.project;
}

// A clipped wall contains several indexed prism components. Check each one:
// a large positive component must not conceal a smaller inverted component.
function positiveComponents(mesh) {
  const parent = mesh.positions.map((_, i) => i);
  const root = (i) => parent[i] === i ? i : (parent[i] = root(parent[i]));
  for (const [a, b, c] of mesh.triangles) { parent[root(b)] = root(a); parent[root(c)] = root(a); }
  const groups = new Map();
  for (const t of mesh.triangles) {
    const key = root(t[0]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  assert.ok(groups.size > 0);
  for (const triangles of groups.values()) {
    assert.ok(volume({ positions: mesh.positions, triangles }) > 1e-10, 'each wall prism has outward winding');
  }
}

test('attic wall components stay outward after drawing direction and rotation changes', () => {
  for (const reverse of [false, true]) for (const angle of [0, Math.PI / 2, 0.37]) {
    const walls = buildElements(attic(reverse, angle)).elements.filter((e) => e.kind === 'wall');
    assert.ok(walls.length >= 5);
    for (const wall of walls) { assert.ok(wall.tessellated); positiveComponents(wall.mesh); }
  }
});

test('IFC coordinates and triangle order preserve outward attic walls after Y reflection', () => {
  const ifc = exportIfc(attic(false, 0.37));
  const entities = new Map([...ifc.matchAll(/^(#\d+)=(.*);$/gm)].map((m) => [m[1], m[2]]));
  const lastRef = (text) => text.match(/#\d+/g).at(-1);
  const array = (text) => JSON.parse(text.replaceAll('(', '[').replaceAll(')', ']').replace(/(\d)\.(?=[,\]])/g, '$1.0'));
  let checked = 0;
  for (const wall of entities.values()) {
    if (!wall.startsWith('IFCWALL(')) continue;
    const rep = wall.match(/,(#\d+),\$,\.(?:STANDARD|PARTITIONING)\.\)$/)[1];
    const shape = entities.get(lastRef(entities.get(rep)));
    const faceSet = entities.get(lastRef(shape));
    const match = faceSet.match(/^IFCTRIANGULATEDFACESET\((#\d+),\$,\.T\.,(.*),\$\)$/);
    assert.ok(match, 'wall exported as tessellated geometry');
    const coordinates = entities.get(match[1]).match(/^IFCCARTESIANPOINTLIST3D\((.*),\$\)$/)[1];
    const mesh = { positions: array(coordinates), triangles: array(match[2]).map((t) => t.map((i) => i - 1)) };
    positiveComponents(mesh);
    checked++;
  }
  assert.ok(checked >= 5);
});
