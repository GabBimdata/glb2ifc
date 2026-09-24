import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joineryParts } from '../src/studio/joinery.js';
import * as M from '../src/studio/model.js';
import { buildElements } from '../src/studio/build.js';
import { exportIfc } from '../src/studio/ifc-export.js';

const closed = (m) => {
  const P = m.positions.map((p) => p.map((v) => v.toFixed(5)).join(','));
  const n = new Map();
  for (const [a, b, c] of m.triangles) for (const [x, y] of [[a, b], [b, c], [c, a]]) {
    const k = P[x] < P[y] ? `${P[x]}|${P[y]}` : `${P[y]}|${P[x]}`;
    n.set(k, (n.get(k) || 0) + 1);
  }
  return [...n.values()].every((v) => v === 2);
};

test('a window has a frame, one sash and glass per leaf, and a sill', () => {
  const p = joineryParts({ kind: 'window', width: 1.2, height: 1.25 }, { leaves: 2, exterior: 0.15, sill: true, shutters: true });
  assert.equal(p.leaves, 2);
  assert.equal(p.glass.length, 2, 'un vitrage par vantail');
  assert.equal(p.sill.length, 1);
  assert.equal(p.shutter.length, 0, 'pas de volets sans demande');
  for (const k of ['frame', 'glass', 'sill', 'handle']) for (const m of p[k]) assert.ok(closed(m), k);
});

test('open shutters lie flat against the façade, closed ones sit in the reveal', () => {
  const e = 0.15;
  const open = joineryParts({ kind: 'window', width: 1.2, height: 1.25, shutters: 'open' }, { leaves: 2, exterior: e, shutters: true });
  const ys = open.shutter.flatMap((m) => m.positions.map((q) => q[1]));
  const xs = open.shutter.flatMap((m) => m.positions.map((q) => q[0]));
  assert.ok(Math.min(...ys) >= e - 1e-9, 'contre le nu extérieur, dehors');
  assert.ok(Math.min(...xs) < -0.6 && Math.max(...xs) > 0.6, 'de part et d’autre de la baie');
  const shut = joineryParts({ kind: 'window', width: 1.2, height: 1.25, shutters: 'closed' }, { leaves: 2, exterior: e, shutters: true });
  const ys2 = shut.shutter.flatMap((m) => m.positions.map((q) => q[1]));
  const xs2 = shut.shutter.flatMap((m) => m.positions.map((q) => q[0]));
  assert.ok(Math.max(...ys2) <= e + 1e-9, 'dans le tableau');
  assert.ok(Math.min(...xs2) >= -0.6 && Math.max(...xs2) <= 0.6, 'dans la largeur de la baie');
});

test('glazing bars and door leaves', () => {
  const plain = joineryParts({ kind: 'window', width: 1.2, height: 1.25 }, { leaves: 2 });
  const bars = joineryParts({ kind: 'window', width: 1.2, height: 1.25, bars: true }, { leaves: 2 });
  assert.ok(bars.frame.length > plain.frame.length, 'petits bois');
  const dbl = joineryParts({ kind: 'door', width: 1.4, height: 2.15 }, { leaves: 2 });
  assert.equal(dbl.leaves, 2);
  assert.ok(dbl.door.length >= 2 && dbl.handle.length > 0 && dbl.glass.length === 0);
});

function house() {
  const pr = M.newProject('Menuiseries');
  const L = pr.levels[0];
  const h = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
  for (let i = 0; i < 4; i++) M.addWall(L, h[i], h[i + 1], { type: 'ext30' });
  M.recomputeAll(pr);
  const nord = L.walls.find((w) => Math.abs(L.nodes[w.a][1]) < 1e-6 && Math.abs(L.nodes[w.b][1]) < 1e-6);
  nord.openings.push(
    { id: 'w1', type: 'window', kind: 'window', offset: 2, width: 1.2, height: 1.25, sill: 0.95, shutters: 'open' },
    { id: 'd1', type: 'doorDouble', kind: 'door', offset: 6, width: 1.4, height: 2.15, sill: 0, side: 1, hinge: 'start' },
  );
  return pr;
}

test('shutters and sills go on the outside of the façade', () => {
  const pr = house();
  const w = buildElements(pr).elements.find((e) => e.opening?.id === 'w1');
  assert.deepEqual(w.exteriorSide.map((v) => Math.round(v)), [0, -1], 'façade nord : extérieur vers le nord');
  const ys = w.joinery.shutter.positions.map((q) => q[1]);
  assert.ok(Math.max(...ys) < -0.15 + 1e-9, 'volets dehors, au nord du nu extérieur');
});

test('IFC: double-leaf window, double door and shutters as shading devices', () => {
  const ifc = exportIfc(house());
  assert.match(ifc, /IFCWINDOW\([^\n]*\.DOUBLE_PANEL_VERTICAL\./);
  assert.match(ifc, /IFCDOOR\([^\n]*\.DOUBLE_DOOR_SINGLE_SWING\./);
  assert.match(ifc, /IFCSHADINGDEVICE\([^\n]*\.SHUTTER\./);
});
