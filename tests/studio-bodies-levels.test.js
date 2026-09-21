import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/studio/model.js';
import { buildElements } from '../src/studio/build.js';

// Maison + garage accolé au rez-de-chaussée
function houseAndGarage() {
  const store = new M.Store(M.newProject('Corps et étages'));
  store.commit('rdc', (pr) => {
    const L = pr.levels[0];
    const h = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
    for (let i = 0; i < 4; i++) M.addWall(L, h[i], h[i + 1], { type: 'ext30' });
    const g = [[10, 0], [16, 0], [16, 6], [10, 6]];
    for (let i = 0; i < 3; i++) M.addWall(L, g[i], g[i + 1], { type: 'ext30' });
    M.addWall(L, [10, 6], [10, 0], { type: 'ext30' });
  });
  const garage = M.newBody('Garage');
  store.commit('garage', (pr) => {
    pr.bodies.push(garage);
    pr.levels[0].rooms.find((r) => r.x > 10).bodyId = garage.id;
  });
  return { store, garage };
}

test('duplicating a level keeps each room in its building body, even without names', () => {
  const { store, garage } = houseAndGarage();
  store.commit('dup', (pr) => {
    const d = M.duplicateLevelData(pr.levels[0], { walls: true, partitions: true, openings: true, rooms: false });
    d.name = 'R+1';
    pr.levels.push(d);
  });
  const up = store.project.levels[1];
  assert.equal(up.rooms.filter((r) => r.bodyId === garage.id).length, 1, 'la pièce au-dessus du garage reste au garage');
  const roofs = buildElements(store.project).elements.filter((e) => e.kind === 'roof');
  assert.ok(roofs.some((e) => e.body.id === garage.id), 'le garage garde sa propre toiture');
  assert.ok(roofs.some((e) => e.body.id !== garage.id), 'la maison garde la sienne');
});

test('a room drawn on an upper level inherits the body of the room below', () => {
  const { store, garage } = houseAndGarage();
  store.commit('étage', (pr) => {
    const d = M.newLevel('R+1');
    const g = [[10, 0], [16, 0], [16, 6], [10, 6], [10, 0]];
    for (let i = 0; i < 4; i++) M.addWall(d, g[i], g[i + 1], { type: 'ext20' });
    pr.levels.push(d);
  });
  assert.equal(store.project.levels[1].rooms[0].bodyId, garage.id);
});
