import { test } from 'node:test';
import assert from 'node:assert/strict';
import { railingParts, railingUnderRoof } from '../src/studio/build.js';
import * as G from '../src/studio/geometry.js';

test('a sloped roof clips railing boxes into closed outward solids', () => {
  const parts = railingParts([0, 0], [4, 0], 0, 1, 'bars', [0, 1]);
  const ctx = { faces: [{ poly: [[-1, -1], [5, -1], [5, 1], [-1, 1]], zAt: ([x]) => 1.4 - x * 0.3 }] };
  const before = structuredClone(parts);
  const fitted = railingUnderRoof(parts, ctx);
  assert.ok(fitted.clipped);
  assert.deepEqual(parts, before, 'source parts are not changed');
  assert.ok(fitted.parts.length > 0);
  for (const { mesh } of fitted.parts) {
    const edges = new Map();
    for (const p of mesh.positions) assert.ok(p[2] <= G.roofHeightAt(ctx.faces, p) - 0.02 + 1e-8);
    for (const tri of mesh.triangles) {
      const ids = tri.map(i => mesh.positions[i].map(v => Math.round(v * 1e7)).join(','));
      for (let i = 0; i < 3; i++) {
        const a = ids[i], b = ids[(i + 1) % 3], key = [a, b].sort().join('/');
        const uses = edges.get(key) || [];
        uses.push(a < b ? 1 : -1); edges.set(key, uses);
      }
    }
    for (const uses of edges.values()) { assert.equal(uses.length % 2, 0); assert.equal(uses.reduce((a, b) => a + b, 0), 0); }
  }
});

test('railings stay unchanged without a roof or with sufficient clearance', () => {
  const parts = railingParts([0, 0], [4, 0], 0, 1, 'bars', [0, 1]);
  assert.equal(railingUnderRoof(parts, null).parts, parts);
  const ctx = { faces: [{ poly: [[-1, -1], [5, -1], [5, 1], [-1, 1]], zAt: () => 3 }] };
  assert.deepEqual(railingUnderRoof(parts, ctx), { parts, clipped: false });
});
