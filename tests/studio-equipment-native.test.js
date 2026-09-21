import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/studio/model.js';
import { buildElements } from '../src/studio/build.js';

function houseWithGarage() {
  const store = new M.Store(M.newProject('Équipements natifs'));
  store.commit('murs', (pr) => {
    const L = pr.levels[0];
    const h = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
    for (let i = 0; i < 4; i++) M.addWall(L, h[i], h[i + 1], { type: 'ext30' });
    const g = [[10, 0], [16, 0], [16, 5], [10, 5]];
    for (let i = 0; i < 3; i++) M.addWall(L, g[i], g[i + 1], { type: 'ext30' });
    M.addWall(L, [10, 5], [10, 0], { type: 'ext30' });
  });
  const pr = store.project;
  const garage = M.newBody('Garage');
  garage.elevation = -0.15;
  pr.bodies.push(garage);
  pr.levels[0].rooms.find((r) => r.x > 10).bodyId = garage.id;
  return { store, pr, garage };
}

test('equipment is built from the level data and sits on its body floor', () => {
  const { pr } = houseWithGarage();
  pr.levels[0].equipment = [
    { id: 'a', type: 'fridge', x: 3, y: 3, rotation: 0, width: 0.6, depth: 0.65, height: 1.85, zOffset: 0 },
    { id: 'b', type: 'wardrobe', x: 13, y: 2.5, rotation: 90, width: 1.2, depth: 0.6, height: 2.1, zOffset: 0 },
  ];
  const eq = buildElements(pr).elements.filter((e) => e.kind === 'equipment');
  assert.equal(eq.length, 2);
  const minZ = (e) => Math.min(...e.parts.flatMap((p) => p.mesh.positions.map((q) => q[2])));
  assert.ok(Math.abs(minZ(eq.find((e) => e.item.id === 'a'))) < 1e-9, 'maison : posé à 0');
  assert.ok(Math.abs(minZ(eq.find((e) => e.item.id === 'b')) + 0.15) < 1e-9, 'garage : posé à -0,15');
  assert.ok(eq.every((e) => e.room), 'chaque équipement connaît sa pièce');
});

test('equipment is part of undo history and can be duplicated with a level', () => {
  const { store } = houseWithGarage();
  store.commit('poser', (pr) => { pr.levels[0].equipment.push({ id: 'x', type: 'wc', x: 2, y: 2, rotation: 0, width: 0.36, depth: 0.66, height: 0.78 }); });
  assert.equal(store.project.levels[0].equipment.length, 1);
  store.undo();
  assert.equal(store.project.levels[0].equipment.length, 0);
  store.redo();
  const copy = M.duplicateLevelData(store.project.levels[0], { walls: true, partitions: true, openings: true, rooms: true, equipment: true });
  assert.equal(copy.equipment.length, 1);
  assert.notEqual(copy.equipment[0].id, 'x');
  const without = M.duplicateLevelData(store.project.levels[0], { walls: true, partitions: true, openings: true, rooms: true, equipment: false });
  assert.equal(without.equipment.length, 0);
});
