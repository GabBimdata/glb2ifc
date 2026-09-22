import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/studio/geometry.js';
import * as M from '../src/studio/model.js';
import { stairRhythm, stairLayout } from '../src/studio/stairs.js';
import { buildElements, levelTremies } from '../src/studio/build.js';
import { exportIfc } from '../src/studio/ifc-export.js';

test('the rhythm follows the Blondel rule', () => {
  for (const h of [2.5, 2.7, 2.8, 3.0, 3.2]) {
    const { risers, riser, going } = stairRhythm(h);
    assert.ok(Math.abs(risers * riser - h) < 1e-9, 'la hauteur totale est exacte');
    assert.ok(riser >= 0.16 && riser <= 0.19, `hauteur de marche ${riser}`);
    assert.ok(Math.abs(2 * riser + going - 0.63) < 0.02, `2h + g = ${2 * riser + going}`);
  }
});

test('headroom is at least 2 m wherever the slab above is kept', () => {
  for (const type of ['straight', 'quarter']) {
    const L = stairLayout({ type, x: 0, y: 0, dir: [1, 0], width: 0.9, turn: 1 }, 2.8, 0.2);
    // chaque marche hors trémie a au moins 2 m sous la dalle du dessus
    const treads = L.parts.filter((p) => p.key === 'tread');
    for (const t of treads) {
      const zs = t.mesh.positions.map((q) => q[2]);
      const top = Math.max(...zs);
      const xs = t.mesh.positions.map((q) => q[0]), ys = t.mesh.positions.map((q) => q[1]);
      const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      if (!G.pointInPolygon(c, L.tremie)) assert.ok((2.8 - 0.2) - top >= 2.0 - 1e-9, `${type} : échappée ${(2.6 - top).toFixed(2)}`);
    }
    assert.ok(Math.abs(G.polygonArea(L.tremie)) < Math.abs(G.polygonArea(L.footprint)), 'la trémie ne couvre pas tout l’escalier');
  }
});

function house() {
  const store = new M.Store(M.newProject('Escaliers'));
  store.commit('rdc', (pr) => {
    const L = pr.levels[0];
    const h = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
    for (let i = 0; i < 4; i++) M.addWall(L, h[i], h[i + 1], { type: 'ext30' });
  });
  store.commit('r1', (pr) => {
    const d = M.duplicateLevelData(pr.levels[0], { walls: true, partitions: true, openings: true, rooms: true });
    d.name = 'R+1';
    pr.levels.push(d);
    pr.levels[0].stairs = [
      { id: 'a', type: 'quarter', x: 1, y: 7.2, dir: [1, 0], width: 0.9, turn: -1 },
      { id: 'b', type: 'straight', x: 8.8, y: 7.3, dir: [0, -1], width: 0.9 },
    ];
  });
  return store.project;
}

test('stairs pierce the slab above and get a guardrail around the opening', () => {
  const pr = house();
  assert.equal(levelTremies(pr, 1).length, 2);
  const el = buildElements(pr).elements;
  const slab = el.find((e) => e.kind === 'slab' && e.levelIndex === 1);
  assert.equal(slab.pieces.reduce((n, p) => n + p.holes.length, 0), 2, 'deux trémies dans le plancher');
  assert.equal(el.filter((e) => e.kind === 'tremieRail').length, 2);
  assert.equal(el.filter((e) => e.kind === 'stair').length, 2);
});

test('stairs are exported as IfcStair with flights, landing and handrail', () => {
  const ifc = exportIfc(house());
  assert.match(ifc, /IFCSTAIR\([^\n]*\.QUARTER_TURN_STAIR\./);
  assert.match(ifc, /IFCSTAIR\([^\n]*\.STRAIGHT_RUN_STAIR\./);
  assert.match(ifc, /IFCSTAIRFLIGHT\(/);
  assert.match(ifc, /IFCSLAB\([^\n]*\.LANDING\./);
  assert.match(ifc, /IFCRAILING\([^\n]*\.HANDRAIL\./);
  assert.match(ifc, /IFCARBITRARYPROFILEDEFWITHVOIDS\(/, 'plancher percé');
});
