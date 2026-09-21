import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/studio/geometry.js';
import * as M from '../src/studio/model.js';
import { buildElements } from '../src/studio/build.js';
import { exportIfc } from '../src/studio/ifc-export.js';

test('habitable area counts only the part at least 1.80 m high', () => {
  // pièce 8 × 5 sous deux pans à 45°, jambette 0,90 : 0,90 m perdu de chaque côté
  const faces = [
    { poly: [[-1, -1], [9, -1], [9, 2.5], [-1, 2.5]], zAt: (p) => 0.9 + p[1] },
    { poly: [[-1, 2.5], [9, 2.5], [9, 6], [-1, 6]], zAt: (p) => 0.9 + (5 - p[1]) },
  ];
  const room = [[0, 0], [8, 0], [8, 5], [0, 5]];
  assert.ok(Math.abs(G.areaAtLeast(room, faces, 1.8) - 8 * (5 - 1.8)) < 1e-9);
  const m = G.prismUnderRoof(room, 0, 2.5, faces);
  assert.ok(Math.max(...m.positions.map((p) => p[2])) <= 2.5 + 1e-9, 'plafonné au faux plafond');
});

function attic() {
  const store = new M.Store(M.newProject('Combles'));
  store.commit('rdc', (pr) => {
    const L = pr.levels[0];
    const h = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
    for (let i = 0; i < 4; i++) M.addWall(L, h[i], h[i + 1], { type: 'ext30' });
    pr.bodies[0].roof.pitch = 45;
  });
  store.commit('combles', (pr) => {
    const d = M.duplicateLevelData(pr.levels[0], { walls: true, partitions: true, openings: true, rooms: true });
    d.name = 'Combles';
    d.attic.enabled = true;
    M.addWall(d, [5, 0], [5, 8], { type: 'part10' });
    d.equipment = [{ id: 'a', type: 'wardrobe', x: 1, y: 0.6, rotation: 0, width: 1.2, depth: 0.6, height: 2.1, zOffset: 0 }];
    pr.levels.push(d);
  });
  return store.project;
}

test('an attic level: roof on knee walls, partitions under the slope, warnings', () => {
  const pr = attic();
  const { elements, warnings } = buildElements(pr);
  const top = (e) => Math.max(...e.mesh.positions.map((p) => p[2]));
  const z = M.levelElevation(pr, pr.levels[1].id);
  const knee = elements.filter((e) => e.kind === 'wall' && e.levelIndex === 1 && e.wallType.category === 'exterior');
  assert.ok(knee.every((e) => Math.abs(top(e) - (z + 0.9)) < 1e-6), 'jambettes à 0,90 m');
  const partition = elements.find((e) => e.kind === 'wall' && e.levelIndex === 1 && e.wallType.category === 'partition');
  assert.ok(partition.tessellated && top(partition) <= z + 2.5 + 1e-6, 'cloison sous le faux plafond');
  const spaces = elements.filter((e) => e.kind === 'space' && e.levelIndex === 1);
  assert.ok(spaces.every((e) => e.areaHabitable > 0 && e.areaHabitable < e.area));
  assert.ok(warnings.some((w) => w.includes('Armoire')), 'équipement trop haut signalé');
});

test('attic spaces carry their habitable area in IFC', () => {
  const ifc = exportIfc(attic());
  assert.match(ifc, /'Smelt_Surfaces'/);
  assert.match(ifc, /'SurfaceHabitable'/);
  assert.match(ifc, /IFCCOVERING\([^\n]*'Faux plafond/);
});
