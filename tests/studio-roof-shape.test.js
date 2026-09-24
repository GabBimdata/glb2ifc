import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/studio/geometry.js';

const rect = [[0, 0], [10, 0], [10, 6], [0, 6]];
// maison en L : le garage occupe l'angle avant droit (remplissage < 85 %)
const L = [[0, 0], [8, 0], [8, 8.5], [5, 8.5], [5, 4], [0, 4]].map(([x, y]) => [x, y]);
const houseL = [[14, 17.05], [9.05, 17.05], [9.05, 12.24], [5.95, 12.24], [5.95, 11.4], [5.85, 11.4], [5.85, 8.5], [14, 8.5]];

const openEdges = (part) => {
  const P = part.positions.map((p) => p.map((v) => v.toFixed(4)).join(','));
  const n = new Map();
  for (const [i, j, k] of part.triangles) for (const [a, b] of [[i, j], [j, k], [k, i]]) {
    const key = P[a] < P[b] ? `${P[a]}|${P[b]}` : `${P[b]}|${P[a]}`;
    n.set(key, (n.get(key) || 0) + 1);
  }
  return [...n.values()].filter((v) => v !== 2).length;
};
const roof = (outline, opts) => G.buildRoof(outline, { type: 'gable', pitch: 35, baseZ: 2.8, ...opts });

test('each end of the ridge can be a gable or a hip (2, 3 or 4 roof planes)', () => {
  for (const [ends, planes] of [[{ min: 'gable', max: 'gable' }, 2], [{ min: 'hip', max: 'gable' }, 3], [{ min: 'gable', max: 'hip' }, 3], [{ min: 'hip', max: 'hip' }, 4]]) {
    const r = roof(rect, { ends });
    assert.equal(r.faces.length, planes, JSON.stringify(ends));
    assert.equal(r.parts.reduce((a, p) => a + openEdges(p), 0), 0, 'toiture fermée');
  }
  // compatibilité : le type « quatre pans » sans extrémités explicites donne toujours quatre pans
  assert.equal(roof(rect, { type: 'hip' }).faces.length, 4);
});

test('the hip goes on the requested side of the plan', () => {
  const r = roof(rect, { ends: { min: 'hip', max: 'gable' } });
  const ridge = r.faces.flatMap((f) => f.poly).filter((p) => Math.abs(p[2] - r.ridgeZ) < 1e-6).map((p) => p[0]);
  assert.ok(Math.min(...ridge) > 2, 'croupe à gauche : le faîtage commence en retrait');
  assert.ok(Math.abs(Math.max(...ridge) - 10.4) < 1e-6, 'pignon à droite : le faîtage va jusqu’au débord');
  assert.equal(r.ridgeAxis, 'x');
});

test('an L-shaped house can get a single roof on its rectangle', () => {
  const auto = roof(houseL, { ridgeFlip: true });
  const single = roof(houseL, { ridgeFlip: true, footprint: 'rect' });
  assert.ok(auto.parts.length > 1, 'automatique : un toit par aile');
  assert.equal(single.parts.length, 1, 'rectangle : un seul toit');
  assert.equal(single.faces.length, 2, 'deux pans');
  assert.equal(openEdges(single.parts[0]), 0);
});

test('the former "follow setbacks" option still works', () => {
  const a = roof(L, { followSetbacks: true });
  const b = roof(L, { footprint: 'follow' });
  assert.equal(a.parts.length, b.parts.length);
});

import * as M from '../src/studio/model.js';
import { exportIfc } from '../src/studio/ifc-export.js';

test('a three-plane roof is exported as a user-defined IfcRoof', () => {
  const pr = M.newProject('Trois pans');
  const Lv = pr.levels[0];
  const h = [[0, 0], [10, 0], [10, 6], [0, 6], [0, 0]];
  for (let i = 0; i < 4; i++) M.addWall(Lv, h[i], h[i + 1], { type: 'ext30' });
  M.recomputeAll(pr);
  pr.bodies[0].roof.ends = { min: 'hip', max: 'gable' };
  assert.match(exportIfc(pr), /IFCROOF\([^\n]*'Trois pans \(croupe et pignon\)'[^\n]*\.USERDEFINED\.\)/);
  pr.bodies[0].roof.ends = { min: 'gable', max: 'gable' };
  assert.match(exportIfc(pr), /IFCROOF\([^\n]*\.GABLE_ROOF\.\)/);
});
