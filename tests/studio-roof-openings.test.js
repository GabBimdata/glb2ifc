import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/studio/geometry.js';
import * as M from '../src/studio/model.js';
import { buildElements, roofOpenings, atticContext } from '../src/studio/build.js';
import { exportIfc } from '../src/studio/ifc-export.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const area = (p) => Math.abs(G.polygonArea(p));
function house({ type = 'gable', angle = 0, knee = 0.9, ceiling = true, elevation = 0, pitch = 35, overhang = 0.4, flip = false } = {}) {
  const store = new M.Store(M.newProject('Roof regression'));
  const transform = ([x, y]) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
  store.commit('walls', (p) => {
    const l = p.levels[0];
    const corners = [[0, 0], [10, 0], [10, 8], [0, 8]].map(transform);
    for (let i = 0; i < 4; i++) M.addWall(l, corners[i], corners[(i + 1) % 4], { type: 'ext30' });
    l.attic = { enabled: true, kneeWall: knee, ceilingHeight: 2.5 };
    Object.assign(p.bodies[0], { ceiling, elevation });
    Object.assign(p.bodies[0].roof, { type, pitch, overhang, ridgeFlip: flip });
  });
  return { p: store.project, l: store.project.levels[0], b: store.project.bodies[0], transform };
}
function addRoof(h, type, xy, props = {}) {
  const [x, y] = h.transform(xy);
  const item = { id: `opening-${h.b.roofItems.length}`, type, level: h.l.id, x, y, ...props };
  h.b.roofItems.push(item);
  return item;
}
function meshValid(mesh) {
  assert.ok(mesh.positions.length && mesh.triangles.length);
  assert.ok(mesh.positions.every((p) => p.length === 3 && p.every(Number.isFinite)));
  assert.ok(mesh.triangles.every((t) => t.length === 3 && t.every((i) => Number.isInteger(i) && i >= 0 && i < mesh.positions.length)));
}
function projectedArea(mesh) {
  return mesh.triangles.reduce((a, t) => a + area(t.map((i) => mesh.positions[i])), 0);
}
function noCoverage(mesh, hole) {
  for (const t of mesh.triangles) {
    const poly = t.map((i) => mesh.positions[i].slice(0, 2));
    if (area(poly) < 1e-9) continue;
    const overlap = G.convexClip(poly, hole);
    assert.ok(!overlap || area(overlap) < 1e-7, 'a triangle fills the opening');
  }
}
function surfacesAt(mesh, p, axes = [0, 1], heightAxis = 2) {
  const heights = [];
  for (const t of mesh.triangles) {
    const ps = t.map((i) => mesh.positions[i]);
    const poly = ps.map((q) => axes.map((axis) => q[axis]));
    if (area(poly) < 1e-9) continue;
    if (!G.pointInPolygon(p, poly) && !poly.some((a, i) => G.projectOnSegment(p, a, poly[(i + 1) % poly.length]).d < 1e-8)) continue;
    const plane = G.planeOf(ps.map((q) => [q[axes[0]], q[axes[1]], q[heightAxis]]));
    if (plane) heights.push(plane(p));
  }
  return heights;
}

test('gable windows pierce a continuous attic wall above the knee and above the ceiling', () => {
  const h = house();
  const wall = h.l.walls.find((w) => h.l.nodes[w.a][0] === 10 && h.l.nodes[w.b][0] === 10);
  wall.openings.push({ id: 'gable-window', type: 'window', kind: 'window', offset: 4, width: 1, height: 1, sill: 1.2 });
  const { elements, warnings } = buildElements(h.p);
  const host = elements.find((e) => e.kind === 'wall' && e.wallIds.includes(wall.id));
  assert.ok(host.tessellated);
  assert.equal(elements.filter((e) => e.kind === 'gable').length, 0);
  assert.equal(surfacesAt(host.mesh, [4, 1.7], [1, 2], 0).length, 0, 'window is actually empty');
  assert.ok(surfacesAt(host.mesh, [4, 3], [1, 2], 0).length > 0, 'gable continues above false ceiling');
  assert.ok(!warnings.some((w) => /Fenêtre/.test(w)));
  const op = elements.find((e) => e.opening?.id === 'gable-window');
  near(op.voidProfile.height, 1);
  assert.match(exportIfc(h.p), /IFCRELVOIDSELEMENT/);
});

for (const type of ['gable', 'hip', 'shed', 'flat']) {
  for (const angle of [0, Math.PI / 2, 0.37]) for (const knee of [0, 0.9, 1.5]) {
    test(`skylight geometry: ${type}, angle=${angle}, knee=${knee}`, () => {
      const h = house({ type, angle, knee, elevation: -0.2 });
      addRoof(h, 'skylight', [5, 1], { sill: 1.3 }); // defaults on legacy/imported items
      const [o] = roofOpenings(h.p, h.l, h.b);
      assert.ok(o.ok, o.reason);
      if (type !== 'flat' && !o.clamped) near(o.sillZ - o.floorZ, 1.3);
      const { elements } = buildElements(h.p);
      const sky = elements.find((e) => e.kind === 'skylight');
      meshValid(sky.frame); meshValid(sky.panel);
      const roof = elements.find((e) => e.key === o.hostKey);
      meshValid(roof.mesh); noCoverage(roof.mesh, o.poly);
      const ctx = atticContext(h.p, 0).get(h.b.id);
      for (const space of elements.filter((e) => e.kind === 'space')) {
        assert.ok(space.areaHabitable >= -1e-7 && space.areaHabitable <= space.area + 1e-7);
      }
      assert.ok(Number.isFinite(ctx.zUnder(h.transform([5, 4]))));
    });
  }
}

for (const type of ['dormerGable', 'dormerHip', 'dormerShed']) for (const angle of [0, 0.61, Math.PI / 2]) for (const ceiling of [false, true]) {
  test(`${type} enlarges attic envelope, angle=${angle}, ceiling=${ceiling}`, () => {
    const h = house({ angle, ceiling });
    const before = atticContext(h.p, 0).get(h.b.id);
    addRoof(h, type, [5, 0.2]);
    const [o] = roofOpenings(h.p, h.l, h.b);
    assert.ok(o.ok, o.reason);
    const q = G.add(o.origin, G.mul(o.u, 0.4));
    const after = atticContext(h.p, 0).get(h.b.id);
    assert.ok(after.zUnder(q) > before.zUnder(q) + 0.5, 'dormer clears usable space');
    const { elements } = buildElements(h.p);
    const dormer = elements.find((e) => e.kind === 'dormer');
    for (const key of ['walls', 'roofMesh', 'frame', 'panel']) meshValid(dormer[key]);
    noCoverage(elements.find((e) => e.key === o.hostKey).mesh, o.poly);
    const spaces = elements.filter((e) => e.kind === 'space');
    assert.ok(spaces.every((e) => e.areaHabitable <= e.area + 1e-7));
    assert.ok(spaces.some((e) => surfacesAt(e.mesh, q).some((z) => z > before.zUnder(q) + 0.5)));
    assert.equal(elements.some((e) => e.kind === 'ceiling'), ceiling);
  });
}

test('four jacobines on opposite slopes keep roof holes and room areas consistent', () => {
  // Minimal synthetic reproduction of the supplied house; no personal project data.
  const h = house();
  for (const point of [[2, 0.1], [8, 0.1], [2, 7.9], [8, 7.9]]) addRoof(h, 'dormerGable', point);
  const openings = roofOpenings(h.p, h.l, h.b);
  assert.equal(openings.filter((o) => o.ok).length, 4);
  const { elements } = buildElements(h.p);
  const roof = elements.find((e) => e.kind === 'roof');
  for (const o of openings) noCoverage(roof.mesh, o.poly);
  const outline = M.bodyOutlines(h.p, h.l, h.b.id, 1)[0];
  const plain = G.buildRoof(outline, { ...h.b.roof, baseZ: 0.9 });
  const projected = plain.faces.reduce((a, f) => a + area(f.poly), 0);
  near(projectedArea(roof.mesh), 2 * (projected - openings.reduce((a, o) => a + area(o.poly), 0)));
  const room = elements.find((e) => e.kind === 'space');
  const ctx = atticContext(h.p, 0).get(h.b.id);
  near(G.areaAtLeast(room.profile, ctx.faces, 0), room.area);
});

test('skylight cuts the false ceiling as well as the roof', () => {
  const h = house();
  addRoof(h, 'skylight', [5, 1], { sill: 2.3 });
  const [o] = roofOpenings(h.p, h.l, h.b);
  assert.ok(o.ok);
  const ceiling = buildElements(h.p).elements.find((e) => e.kind === 'ceiling');
  meshValid(ceiling.mesh); noCoverage(ceiling.mesh, o.poly);
  assert.ok(projectedArea(ceiling.mesh) > 20, 'ceiling outside opening retained');
});

test('exact fitting finds a narrow feasible interval missed by sampling', () => {
  const face = [[0, 0], [1, 0], [1, 10], [0, 10]];
  const opening = [[0.05, -4.995], [0.95, -4.995], [0.95, 4.995], [0.05, 4.995]];
  const t = G.fitTranslation(opening, face, [0, 1], -20);
  near(t, 4.99501);
  assert.equal(G.fitTranslation(opening, face, [1, 0], 0), null);
});

test('invalid and overlapping roof openings produce explicit warnings and no broken geometry', () => {
  const h = house();
  addRoof(h, 'skylight', [5, 1]);
  addRoof(h, 'skylight', [5, 1]);
  addRoof(h, 'skylight', [2, 1], { width: 30 });
  addRoof(h, 'dormerGable', [8, 1], { wallHeight: 0.3 });
  addRoof(h, 'skylight', [100, 100]);
  const openings = roofOpenings(h.p, h.l, h.b);
  assert.equal(openings.length, 5);
  assert.equal(openings.filter((o) => o.ok).length, 1);
  assert.match(openings[1].reason, /chevauche/);
  const r = buildElements(h.p);
  assert.equal(r.elements.filter((e) => e.kind === 'skylight').length, 1);
  for (const o of openings.filter((o) => !o.ok)) assert.ok(r.warnings.some((w) => w.includes(o.item.id)));
  const flat = house({ type: 'flat' }); addRoof(flat, 'dormerGable', [5, 1]);
  assert.match(roofOpenings(flat.p, flat.l, flat.b)[0].reason, /incliné/);
});

test('allège clamps exactly at either end, including a flipped ridge and no overhang', () => {
  for (const flip of [false, true]) for (const sill of [0, 30]) {
    const h = house({ flip, overhang: 0 }); addRoof(h, 'skylight', [2, 2], { sill });
    const [o] = roofOpenings(h.p, h.l, h.b);
    assert.ok(o.ok && o.clamped);
    assert.ok(buildElements(h.p).warnings.some((w) => /recalée/.test(w)));
  }
});

test('upper envelopes do not double count crossing or coplanar roof faces', () => {
  const poly = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const faces = G.roofEnvelope([{ poly, zAt: (p) => p[0] }, { poly, zAt: (p) => 4 - p[0] }, { poly, zAt: (p) => p[0] }]);
  near(G.areaAtLeast(poly, faces, 0), 16);
  near(G.areaAtLeast(poly, faces, 3), 8);
  near(G.roofHeightAt(faces, [2, 2]), 2);
  near(G.roofHeightAt(faces, [0, 2]), 4);
});

test('concave rooms and holes crossing cell edges preserve exact areas', () => {
  const poly = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
  const faces = [{ poly: [[-1, -1], [5, -1], [5, 5], [-1, 5]], zAt: () => 3 }];
  near(G.areaAtLeast(poly, faces, 1.8), 7);
  const holes = [[[0.5, 0.5], [2, 0.5], [2, 2], [0.5, 2]]];
  near(G.subtractConvexHoles(poly, holes).reduce((a, p) => a + area(p), 0), 5.75);
});

test('IFC roof openings keep their hosts and finite positive void extrusions', () => {
  const h = house({ elevation: 0.7 });
  addRoof(h, 'dormerGable', [2, 0.2]); addRoof(h, 'skylight', [8, 1]);
  const ifc = exportIfc(h.p);
  assert.ok(!/NaN|Infinity/.test(ifc));
  assert.equal((ifc.match(/=IFCOPENINGELEMENT\(/g) || []).length, 2); // the two roof holes
  for (const match of ifc.matchAll(/IFCEXTRUDEDAREASOLID\([^\n]*,([-\d.]+)\);/g)) assert.ok(Number(match[1]) > 0);
  assert.match(ifc, /IFCRELVOIDSELEMENT/);
});

test('shared walls use the higher adjacent body and are independent of room order', () => {
  const h = house();
  const store = new M.Store(h.p);
  store.commit('split bodies', (p) => M.addWall(p.levels[0], [5, 0], [5, 8], { type: 'int15' }));
  h.p = store.project; h.l = h.p.levels[0]; h.b = h.p.bodies[0];
  const other = M.newBody('Second body'); other.elevation = 0.6; other.roof.pitch = 50; other.roof.ridgeFlip = true;
  h.p.bodies.push(other);
  h.l.rooms.find((r) => r.x >= 5).bodyId = other.id;
  const wall = h.l.walls.find((w) => w.type === 'int15');
  const get = () => buildElements(h.p).elements.find((e) => e.kind === 'wall' && e.wallIds.includes(wall.id));
  const a = get();
  h.l.rooms.reverse();
  const b = get();
  near(Math.max(...a.mesh.positions.map((p) => p[2])), Math.max(...b.mesh.positions.map((p) => p[2])));
  near(projectedArea(a.mesh), projectedArea(b.mesh));
  const q = [5, 4];
  near(Math.max(...surfacesAt(a.mesh, q)), 3.1);
});

test('roof openings stay on their body top level through duplication and round-trip', () => {
  const h = house();
  addRoof(h, 'skylight', [5, 1]);
  const upper = M.duplicateLevelData(h.l, { walls: true, partitions: true, rooms: true, openings: true });
  upper.attic.enabled = true;
  h.p.levels.push(upper);
  assert.deepEqual(roofOpenings(h.p, h.l, h.b), []);
  h.b.roofItems[0].level = upper.id;
  const p = M.validateProject(JSON.parse(JSON.stringify(h.p)));
  const [o] = roofOpenings(p, p.levels[1], p.bodies[0]);
  assert.ok(o.ok);
  near(o.floorZ, h.l.height);
  assert.equal(buildElements(p).elements.filter((e) => e.kind === 'skylight').length, 1);
  assert.equal(buildElements(p, { upToLevelIndex: 0 }).elements.filter((e) => e.kind === 'skylight').length, 0);
  p.bodies[0].roof.enabled = false;
  assert.equal(atticContext(p, 1).size, 0);
});

test('square hip roof supports skylights on all four triangular faces', () => {
  const h = house({ type: 'hip' });
  for (const p of Object.values(h.l.nodes)) if (p[0] === 10) p[0] = 8;
  for (const point of [[4, 1], [4, 7], [1, 4], [7, 4]]) addRoof(h, 'skylight', point);
  const openings = roofOpenings(h.p, h.l, h.b);
  assert.equal(openings.filter((o) => o.ok).length, 4);
  const roof = buildElements(h.p).elements.find((e) => e.kind === 'roof');
  for (const o of openings) noCoverage(roof.mesh, o.poly);
});

test('L-shaped attic with intersecting roofs preserves its floor area', () => {
  const store = new M.Store(M.newProject());
  store.commit('L shape', (p) => {
    const points = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 8], [0, 8]];
    for (let i = 0; i < points.length; i++) M.addWall(p.levels[0], points[i], points[(i + 1) % points.length], { type: 'ext30' });
    p.levels[0].attic.enabled = true;
    p.bodies[0].roof.followSetbacks = true;
  });
  const p = store.project;
  const ctx = atticContext(p, 0).get(p.bodies[0].id);
  const room = buildElements(p).elements.find((e) => e.kind === 'space');
  near(G.areaAtLeast(room.profile, ctx.faces, 0), room.area);
  assert.ok(room.areaHabitable <= room.area);
  meshValid(room.mesh);
});

test('jacobine glass is transparent in the shared 3D/GLB scene', async () => {
  const { buildObject3D } = await import('../src/studio/view3d.js');
  const h = house(); addRoof(h, 'dormerGable', [5, 0.2]);
  const { root } = buildObject3D(h.p, { edges: false });
  const group = root.children.find((g) => g.userData.smeltKey.startsWith('dormer-'));
  const glass = group.children.filter((m) => m.material.name === 'window');
  assert.equal(glass.length, 1);
  near(glass[0].material.opacity, 0.45);
  assert.equal(glass[0].material.depthWrite, false);
  assert.equal(glass[0].material.transparent, true);
});

test('a ceiling lower than 1.80 m has no habitable area', () => {
  const h = house(); h.l.attic.ceilingHeight = 1.5;
  const spaces = buildElements(h.p).elements.filter((e) => e.kind === 'space');
  assert.ok(spaces.length);
  assert.ok(spaces.every((e) => e.areaHabitable === 0));
});
