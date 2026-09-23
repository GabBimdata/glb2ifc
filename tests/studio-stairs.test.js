import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/studio/geometry.js';
import * as M from '../src/studio/model.js';
import { stairRhythm, stairParameters, stairLayout } from '../src/studio/stairs.js';
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
  for (const type of ['straight', 'quarter', 'winder']) {
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

test('legacy stairs keep their automatic rhythm and asymmetric split', () => {
  for (const [flight1, expected] of [[undefined, [7, 7]], [3, [3, 11]], [11, [11, 3]]]) {
    const p = stairParameters({ type: 'quarter', flight1 }, 2.8);
    assert.equal(p.risers, 16);
    assert.equal(p.riser, 0.175);
    assert.equal(p.going, 0.28);
    assert.deepEqual(p.flights, expected);
  }
});

test('independent flight counts preserve the exact storey height', () => {
  for (const type of ['quarter', 'winder']) {
    const stair = { type, x: 0, y: 0, dir: [1, 0], flight1: 3, flight2: 9 };
    const L = stairLayout(stair, 2.8);
    assert.deepEqual(L.info.flights, [3, 9]);
    assert.equal(L.info.risers, type === 'quarter' ? 14 : 16);
    const surfaces = L.parts.filter((p) => ['tread', 'landing'].includes(p.key));
    const tops = surfaces.map((p) => Math.max(...p.mesh.positions.map((v) => v[2]))).sort((a, b) => a - b);
    assert.equal(tops.length, L.info.risers - 1);
    tops.push(2.8);
    tops.forEach((z, i) => assert.ok(Math.abs(z - (i + 1) * L.info.riser) < 1e-9));
    const changed = stairParameters({ ...stair, flight1: 6 }, 2.8);
    assert.deepEqual(changed.flights, [6, 9]);
    assert.equal(changed.risers, L.info.risers + 3);
    assert.equal(stairParameters({ ...stair, type: 'straight' }, 2.8).risers, 16, 'straight ignores hidden turning settings');
  }
});

function checkClosedMesh(mesh) {
  const edges = new Map();
  let volume = 0;
  for (const v of mesh.positions) assert.ok(v.every(Number.isFinite));
  for (const [a, b, c] of mesh.triangles) {
    const p = mesh.positions[a], q = mesh.positions[b], r = mesh.positions[c];
    const u = q.map((v, i) => v - p[i]), v = r.map((x, i) => x - p[i]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(Math.hypot(...cross) > 1e-10, 'no degenerate triangles');
    volume += p.reduce((s, x, i) => s + x * cross[i], 0) / 6;
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
      const edge = edges.get(key) || { count: 0, direction: 0 };
      edge.count++;
      edge.direction += i < j ? 1 : -1;
      edges.set(key, edge);
    }
  }
  for (const edge of edges.values()) assert.deepEqual(edge, { count: 2, direction: 0 }, 'closed and consistently wound');
  assert.ok(volume > 0, `outward normals, volume=${volume}`);
}

test('both turns stay closed under mirroring, rotation and zero-length flights', () => {
  for (const type of ['quarter', 'winder']) for (const turn of [-1, 1]) {
    for (const angle of [0, Math.PI / 2, 0.37]) for (const [flight1, flight2] of [[3, 9], [9, 3], [0, 12], [12, 0], [0, 0], [1, 20]]) {
      for (const winderSteps of type === 'winder' ? [2, 3, 4, 5, 8] : [1]) {
        const L = stairLayout({ type, turn, x: 2, y: -3, dir: [Math.cos(angle), Math.sin(angle)], flight1, flight2, winderSteps }, 2.8);
        assert.ok(G.polygonArea(L.footprint) > 0);
        if (L.tremie) assert.ok(G.polygonArea(L.tremie) > 0);
        for (const part of L.parts) checkClosedMesh(part.mesh);
      }
    }
  }
});

test('fan treads tile the entire square turn without a landing or overlap', () => {
  for (const winderSteps of [2, 3, 4, 5, 8]) for (const width of [0.6, 0.9, 1.2]) {
    const L = stairLayout({ type: 'winder', x: 0, y: 0, dir: [1, 0], flight1: 0, flight2: 0, winderSteps, width }, 1.2);
    assert.equal(L.parts.filter((p) => p.key === 'landing').length, 0);
    const treads = L.parts.filter((p) => p.key === 'tread');
    assert.equal(treads.length, winderSteps);
    const polygons = treads.map((p) => p.mesh.positions.slice(0, p.mesh.positions.length / 2).map((v) => v.slice(0, 2)));
    assert.ok(Math.abs(polygons.reduce((a, p) => a + G.polygonArea(p), 0) - width * width) < 1e-9);
    for (let x = 0; x < 17; x++) for (let y = 0; y < 17; y++) {
      const point = [width * (x + 0.31) / 17, width * ((y + 0.63) / 17 - 0.5)];
      assert.equal(polygons.filter((p) => G.pointInPolygon(point, p)).length, 1, 'every point belongs to exactly one tread');
    }
  }
});

test('headroom openings include the noses and all high turning treads', () => {
  for (const type of ['straight', 'quarter', 'winder']) for (const turn of [-1, 1]) {
    for (const height of [2.1, 2.8, 3.2]) for (const [flight1, flight2] of [[2, 10], [10, 2], [0, 12], [12, 0]]) {
      const L = stairLayout({ type, x: 2, y: 4, dir: [Math.cos(0.37), Math.sin(0.37)], turn, flight1, flight2 }, height, 0.25);
      for (const part of L.parts.filter((p) => ['tread', 'landing'].includes(p.key))) {
        const top = Math.max(...part.mesh.positions.map((p) => p[2]));
        if (height - 0.25 - top >= 2 - 1e-9) continue;
        const poly = part.mesh.positions.slice(0, part.mesh.positions.length / 2).map((p) => p.slice(0, 2));
        const center = G.polygonCentroid(poly);
        for (const p of poly) {
          const inside = G.add(G.mul(p, 0.999), G.mul(center, 0.001));
          assert.ok(L.tremie && G.pointInPolygon(inside, L.tremie), `${type}: low headroom at ${inside}`);
        }
      }
    }
  }
});

test('invalid counts are bounded and never create partial or non-finite steps', () => {
  const p = stairParameters({ type: 'winder', flight1: -8, flight2: 9999, winderSteps: 9999 }, 2.8);
  assert.deepEqual(p.flights, [0, 100]);
  assert.equal(p.turnSteps, 8);
  const q = stairParameters({ type: 'winder', flight1: NaN, flight2: Infinity, winderSteps: NaN }, 2.8);
  assert.deepEqual(q.flights, [6, 6]);
  assert.equal(q.turnSteps, 3);
  assert.deepEqual(stairParameters({ type: 'quarter', flight1: 3.4, flight2: 8.8 }, 2.8).flights, [3, 9]);
});

test('winder settings survive save/load and undo/redo, and update the upper slab', () => {
  const store = new M.Store(house());
  store.commit('winder', (p) => Object.assign(p.levels[0].stairs[0], { type: 'winder', flight1: 3, flight2: 9, winderSteps: 3 }));
  const saved = M.validateProject(JSON.parse(JSON.stringify(store.project)));
  assert.deepEqual(stairParameters(saved.levels[0].stairs[0], 2.8).flights, [3, 9]);
  const before = levelTremies(saved, 1)[0].poly;
  store.undo();
  assert.equal(store.project.levels[0].stairs[0].type, 'quarter');
  store.redo();
  assert.equal(store.project.levels[0].stairs[0].flight2, 9);
  store.commit('change split', (p) => Object.assign(p.levels[0].stairs[0], { flight1: 9, flight2: 3 }));
  assert.notDeepEqual(levelTremies(store.project, 1)[0].poly, before);
  assert.equal(buildElements(saved).elements.filter((e) => e.kind === 'stair').length, 2);
  assert.equal(buildElements(saved).elements.filter((e) => e.kind === 'tremieRail').length, 2);
});

test('IFC distinguishes a winding flight from two straight flights and a landing', () => {
  const p = house();
  p.levels[0].stairs = [{ id: 'custom', type: 'winder', x: 1, y: 7, dir: [1, 0], turn: -1, flight1: 3, flight2: 9, winderSteps: 3 }];
  const ifc = exportIfc(p);
  assert.match(ifc, /IFCSTAIR\([^\n]*\.QUARTER_WINDING_STAIR\./);
  assert.match(ifc, /IFCSTAIRFLIGHT\([^\n]*,16,15,0\.175,0\.28,\.WINDER\.\)/);
  assert.doesNotMatch(ifc, /IFCSLAB\([^\n]*\.LANDING\./);
  assert.match(ifc, /IFCARBITRARYPROFILEDEFWITHVOIDS\(/);
  p.levels[0].stairs[0].type = 'quarter';
  const landingIfc = exportIfc(p);
  const flights = landingIfc.match(/IFCSTAIRFLIGHT\([^\n]+/g);
  assert.equal(flights.length, 2);
  assert.match(flights[0], /,4,3,0\.2,0\.23,\.STRAIGHT\.\)/);
  assert.match(flights[1], /,10,9,0\.2,0\.23,\.STRAIGHT\.\)/);
  assert.match(landingIfc, /IFCSLAB\([^\n]*\.LANDING\./);
});

// ── Main courante côté jour et poteaux ──────────────────────────────────────
import { stairLayout as layoutRails } from '../src/studio/stairs.js';

const railPieces = (L) => L.parts.filter((p) => p.key === 'rail');
// distance d'une pièce au coin intérieur du virage (pivot), dans le repère du plan
const nearPoint = (mesh, p, tol) => mesh.positions.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < tol);

for (const type of ['quarter', 'winder']) {
  test(`${type}: the handrail runs on the inner side, with a newel at the pivot`, () => {
    const st = { type, x: 0, y: 0, dir: [1, 0], width: 0.9, turn: 1 };
    const L = layoutRails(st, 2.8, 0.2);
    const u1 = L.info.flights[0] * L.info.going;
    // repère : U = +x, V = perp(U) = +y (virage à droite) ; pivot au coin intérieur (u1, w/2)
    const pivot = [u1, 0.45];
    const tall = railPieces(L).filter((p) => Math.max(...p.mesh.positions.map((q) => q[2])) > 1.5 && nearPoint(p.mesh, pivot, 0.12));
    assert.ok(tall.length >= 1, 'poteau au pivot');
    // aucune main courante le long des bords extérieurs (contre les murs) : y = -0.45 pour la volée 1
    const outerFlight1 = railPieces(L).filter((p) => p.mesh.positions.every((q) => q[1] < -0.35) && p.mesh.positions.some((q) => q[0] > 0.5 && q[0] < u1 - 0.2));
    assert.equal(outerFlight1.length, 0, 'pas de main courante côté mur');
  });
}

test('the handrail side can be switched to the walls or both sides', () => {
  const base = { type: 'quarter', x: 0, y: 0, dir: [1, 0], width: 0.9, turn: 1 };
  const inner = railPieces(layoutRails(base, 2.8, 0.2)).length;
  const both = railPieces(layoutRails({ ...base, rail: 'both' }, 2.8, 0.2)).length;
  const outer = layoutRails({ ...base, rail: 'outer' }, 2.8, 0.2);
  assert.ok(both > inner);
  assert.ok(railPieces(outer).some((p) => p.mesh.positions.every((q) => q[1] < -0.35)), 'main courante côté mur sur demande');
});

test('a straight stair has a starting newel at the foot of its handrail', () => {
  const L = layoutRails({ type: 'straight', x: 0, y: 0, dir: [1, 0], width: 0.9 }, 2.8, 0.2);
  // poteau de 9 × 9 cm centré au pied de la main courante
  assert.ok(railPieces(L).some((p) => nearPoint(p.mesh, [0.045, 0.405], 0.08) && Math.max(...p.mesh.positions.map((q) => q[2])) > 1.0));
});

test('arrival newels start at the last tread underside and keep their original top', () => {
  // Includes the reported GLB: 0 straight treads, 3 winders, 11 straight treads,
  // width 1 m and storey height 2.8 m, with the two mirrored stairs.
  const configurations = [
    { type: 'straight' },
    ...['quarter', 'winder'].flatMap((type) => [
      { type },
      ...[[0, 11], [3, 9], [8, 1], [8, 0], [0, 0]].map(([flight1, flight2]) =>
        ({ type, flight1, flight2, winderSteps: 3 })),
    ]),
  ];
  for (const config of configurations) for (const rail of ['inner', 'outer', 'both']) {
    for (const turn of [-1, 1]) for (const dir of [[1, 0], [0.6, 0.8]]) {
      const L = stairLayout({ ...config, rail, turn, dir, x: 4, y: -3, width: 1 }, 2.8);
      const surfaces = L.parts.filter((p) => ['tread', 'landing'].includes(p.key));
      const last = surfaces.reduce((a, b) =>
        Math.max(...a.mesh.positions.map((p) => p[2])) > Math.max(...b.mesh.positions.map((p) => p[2])) ? a : b);
      const underside = Math.min(...last.mesh.positions.map((p) => p[2]));
      const ascent = config.type === 'straight' ? dir : G.mul(G.perp(dir), turn);
      const [a, b] = L.arrival;
      const across = G.norm(G.sub(b, a));
      const ends = rail === 'both' ? [0, 1] : [rail === 'outer' ? 1 : 0];
      // On straight stairs the inner edge is the second arrival endpoint.
      const targets = ends.map((end) => {
        const e = config.type === 'straight' ? 1 - end : end;
        return G.sub(G.add(e ? b : a, G.mul(across, e ? -0.045 : 0.045)), G.mul(ascent, 0.045));
      });
      for (const target of targets) {
        const posts = railPieces(L).filter(({ mesh }) => {
          if (mesh.positions.length !== 8) return false;
          // With no second flight, the pivot shares this position but has a
          // taller cap; it remains a separate support for the turning treads.
          if (Math.abs(Math.max(...mesh.positions.map((p) => p[2])) - 3.75) > 1e-9) return false;
          const center = [0, 1].map((axis) => mesh.positions.reduce((sum, p) => sum + p[axis], 0) / 8);
          return G.dist(center, target) < 1e-8;
        });
        assert.equal(posts.length, 1, JSON.stringify({ config, rail, turn, dir }));
        const zs = posts[0].mesh.positions.map((p) => p[2]);
        assert.ok(Math.abs(Math.min(...zs) - underside) < 1e-9, 'base at the last surface underside');
        assert.ok(Math.abs(Math.max(...zs) - 3.75) < 1e-9, 'original arrival top preserved');
      }
    }
  }
});
