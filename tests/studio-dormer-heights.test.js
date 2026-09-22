import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/studio/model.js';
import { roofOpenings } from '../src/studio/build.js';

// Combles : jambette 0,90 m, couverture épaisse ; la baie d'une jacobine se règle depuis le plancher.
function attic(item) {
  const store = new M.Store(M.newProject('Jacobines'));
  store.commit('rdc', (pr) => {
    const L = pr.levels[0];
    const h = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
    for (let i = 0; i < 4; i++) M.addWall(L, h[i], h[i + 1], { type: 'ext30' });
    pr.bodies[0].roof.pitch = 45;
  });
  store.commit('combles', (pr) => {
    const d = M.duplicateLevelData(pr.levels[0], { walls: true, partitions: true, openings: true, rooms: true });
    d.attic.enabled = true;
    pr.levels.push(d);
    pr.bodies[0].roofItems = [{ id: 'j', type: 'dormerGable', kind: 'dormer', level: d.id, x: 5, y: 1, ...item }];
  });
  const pr = store.project;
  const L = pr.levels[1];
  const o = roofOpenings(pr, L, pr.bodies[0])[0];
  const z = (k) => o.groups[k].flatMap((m) => m.positions.map((p) => p[2] - o.floorZ));
  return { o, z };
}

test('dormer window sill and eave are measured from the attic floor', () => {
  const { o, z } = attic({ ref: 'floor', eave: 2.4, winSill: 0.95, winHeight: 1.2 });
  assert.ok(o.ok);
  const frame = z('frame');
  assert.ok(Math.abs(Math.min(...frame) - 0.95) < 1e-6, `allège à ${Math.min(...frame)}`);
  assert.ok(Math.abs(Math.max(...frame) - 2.15) < 1e-6, `linteau à ${Math.max(...frame)}`);
  assert.ok(Math.abs(Math.min(...z('front')) - 0.9) < 1e-6, 'la façade part du haut de la jambette');
  assert.equal(o.floorValues.reduced, false);
});

test('an older project keeps its dormer size but gets a sensible window', () => {
  const { o, z } = attic({ width: 1.6, wallHeight: 1.5, pitch: 40, setback: 0.4, winHeight: 1, winSill: 0.5 });
  assert.ok(Math.abs(Math.min(...z('frame')) - 0.95) < 1e-6, 'allège ramenée à 0,95 m au lieu de ~1,70 m');
  assert.ok(o.floorValues.eave > 2.5, 'la hauteur de la lucarne est conservée');
});

test('a window too tall for the dormer is reported, not silently cut', () => {
  const { o } = attic({ ref: 'floor', eave: 2.4, winSill: 0.95, winHeight: 1.6 });
  assert.equal(o.floorValues.reduced, true);
  assert.ok(o.floorValues.windowHeight < 1.6);
});

import * as G from '../src/studio/geometry.js';
import { buildElements } from '../src/studio/build.js';

function atticProject(item) {
  const store = new M.Store(M.newProject('Jacobines'));
  store.commit('rdc', (pr) => {
    const L = pr.levels[0];
    const h = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
    for (let i = 0; i < 4; i++) M.addWall(L, h[i], h[i + 1], { type: 'ext30' });
    pr.bodies[0].roof.pitch = 35;
  });
  store.commit('combles', (pr) => {
    const d = M.duplicateLevelData(pr.levels[0], { walls: true, partitions: true, openings: true, rooms: true });
    d.attic.enabled = true;
    pr.levels.push(d);
    pr.bodies[0].roofItems = [{ id: 'j', type: 'dormerGable', kind: 'dormer', level: d.id, x: 5, y: 1, ref: 'floor', eave: 2.4, winSill: 0.95, winHeight: 1.2, ...item }];
  });
  return store.project;
}

test('a dormer flush with the façade interrupts the eave: nothing masks its window', () => {
  const pr = atticProject({});
  const L = pr.levels[1], b = pr.bodies[0];
  const o = roofOpenings(pr, L, b)[0];
  assert.ok(o.ok && o.floorValues.flush);
  const roof = buildElements(pr).elements.filter((e) => e.kind === 'roof');
  const w2 = 0.8;
  for (const r of roof) for (const p of r.mesh.positions) {
    const du = G.dot(G.sub([p[0], p[1]], o.origin), o.u), dv = G.dot(G.sub([p[0], p[1]], o.origin), o.v);
    if (du < -0.02 && du > -0.5 && Math.abs(dv) < w2 - 0.1) assert.ok(p[2] - o.floorZ <= o.floorValues.winSill + 1e-6, 'couverture devant la baie');
  }
});

test('a dormer set back in the slope raises its sill above the covering', () => {
  const pr = atticProject({ setback: 1.5 });
  const o = roofOpenings(pr, pr.levels[1], pr.bodies[0])[0];
  assert.ok(o.ok && !o.floorValues.flush && o.floorValues.raised);
  assert.ok(o.floorValues.winSill >= (o.zOrigin - o.floorZ) + 0.15 - 1e-9, 'solin d’au moins 15 cm');
});

test('the false ceiling never enters a dormer', () => {
  const pr = atticProject({});
  const o = roofOpenings(pr, pr.levels[1], pr.bodies[0])[0];
  const ceil = buildElements(pr).elements.filter((e) => e.kind === 'ceiling');
  assert.ok(ceil.length > 0);
  const inside = (p) => G.pointInPolygon(p, o.poly) && o.poly.every((a, i) => G.projectOnSegment(p, a, o.poly[(i + 1) % o.poly.length]).d > 0.01);
  for (const c of ceil) for (const t of c.mesh.triangles) {
    const P = t.map((i) => c.mesh.positions[i]);
    assert.ok(!inside([(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3]), 'faux plafond dans la lucarne');
  }
});
