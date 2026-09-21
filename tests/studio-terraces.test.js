import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/studio/geometry.js';
import * as M from '../src/studio/model.js';
import { buildElements, levelTerraces } from '../src/studio/build.js';
import { exportIfc } from '../src/studio/ifc-export.js';

const area = (pieces) => pieces.reduce((s, p) => s + Math.abs(G.polygonArea(p.outer))
  - p.holes.reduce((t, h) => t + Math.abs(G.polygonArea(h)), 0), 0);
const len = (edges) => edges.reduce((s, [a, b]) => s + G.dist(a, b), 0);
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test('difference of footprints, including shared façades and a ring', () => {
  let r = G.polygonDifference(rect(0, 0, 10, 8), rect(0, 0, 10, 5));
  assert.equal(r.pieces.length, 1);
  assert.ok(Math.abs(area(r.pieces) - 30) < 1e-6);
  assert.ok(Math.abs(len(r.free) - 16) < 1e-6, 'garde-corps sur les trois bords libres');
  assert.ok(Math.abs(len(r.facade) - 10) < 1e-6, 'bord appuyé contre la façade');

  r = G.polygonDifference(rect(0, 0, 10, 8), rect(2, 2, 8, 6));
  assert.equal(r.pieces[0].holes.length, 1, 'terrasse en anneau');
  assert.ok(Math.abs(area(r.pieces) - 56) < 1e-6);

  assert.equal(G.polygonDifference(rect(0, 0, 10, 8), rect(0, 0, 10, 8)).pieces.length, 0);
});

function project() {
  const store = new M.Store(M.newProject('Terrasses'));
  store.commit('rdc', (pr) => {
    const L = pr.levels[0];
    const h = [[0, 0], [12, 0], [12, 9], [0, 9], [0, 0]];
    for (let i = 0; i < 4; i++) M.addWall(L, h[i], h[i + 1], { type: 'ext30' });
  });
  store.commit('r1', (pr) => {
    const d = M.newLevel('R+1');
    const h = [[0, 0], [12, 0], [12, 5.5], [0, 5.5], [0, 0]];
    for (let i = 0; i < 4; i++) M.addWall(d, h[i], h[i + 1], { type: 'ext30' });
    d.balconies = [{ id: 'b1', x: 6, y: -0.15, dir: [0, -1], width: 3, depth: 1.2, thickness: 0.18, railing: 'bars', railingHeight: 1 }];
    pr.levels.push(d);
  });
  return store.project;
}

test('the uncovered part of the lower level becomes a terrace with railings', () => {
  const pr = project();
  const t = levelTerraces(pr, 1);
  assert.equal(t.length, 1);
  assert.ok(Math.abs(t[0].area - 12.3 * 3.5) < 1e-6);
  const el = buildElements(pr).elements;
  const terrace = el.find((e) => e.kind === 'terrace');
  assert.ok(terrace.railParts.length > 0);
  pr.levels[1].terrace.mode = 'roof';
  assert.equal(buildElements(pr).elements.find((e) => e.kind === 'terrace').railParts.length, 0, 'toiture-terrasse sans garde-corps');
});

test('balconies and terraces are exported as slabs, railings and external spaces', () => {
  const ifc = exportIfc(project());
  assert.match(ifc, /IFCSLAB\([^\n]*'Terrasse'[^\n]*\.FLOOR\./);
  assert.match(ifc, /IFCSLAB\([^\n]*'Balcon'[^\n]*\.FLOOR\./);
  assert.match(ifc, /IFCRAILING\([^\n]*\.GUARDRAIL\./);
  assert.match(ifc, /IFCSPACE\([^\n]*\.EXTERNAL\./);
});
