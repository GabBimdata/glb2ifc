import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EQUIPMENT_TYPES, EQUIPMENT_GROUPS } from '../src/studio/equipment-catalog.js';
import { equipmentParts, hasModel, EQUIPMENT_MATERIALS } from '../src/studio/equipment-models.js';

// Chaque arête d'un solide fermé est partagée par exactement deux triangles.
function openEdges(mesh) {
  const key = (p) => p.map((v) => v.toFixed(5)).join(',');
  const P = mesh.positions.map(key);
  const count = new Map();
  for (const [i, j, k] of mesh.triangles) {
    for (const [a, b] of [[i, j], [j, k], [k, i]]) {
      const e = P[a] < P[b] ? `${P[a]}|${P[b]}` : `${P[b]}|${P[a]}`;
      count.set(e, (count.get(e) || 0) + 1);
    }
  }
  return [...count.values()].filter((n) => n !== 2).length;
}

test('every catalogue entry has a generated model, a group and valid materials', () => {
  for (const [type, cat] of Object.entries(EQUIPMENT_TYPES)) {
    assert.ok(hasModel(cat.model || type), `${type} n'a pas de modèle généré`);
    assert.ok(EQUIPMENT_GROUPS[cat.group], `${type} a un groupe inconnu`);
    const parts = equipmentParts({ type, model: cat.model, width: cat.width, depth: cat.depth, height: cat.height });
    assert.ok(parts.length > 0, `${type} ne produit aucune géométrie`);
    for (const p of parts) {
      assert.ok(EQUIPMENT_MATERIALS[p.mat], `${type} utilise un matériau inconnu : ${p.mat}`);
      assert.equal(openEdges(p.mesh), 0, `${type} : volume non fermé`);
    }
  }
});

test('resizing does not distort fixed features (worktop thickness, tap)', () => {
  const thickness = (parts) => {
    const top = parts.filter((p) => p.mat === 'worktop');
    const zs = top.flatMap((p) => p.mesh.positions.map((q) => q[2]));
    return Math.max(...zs) - Math.min(...zs);
  };
  const narrow = equipmentParts({ type: 'worktop', width: 0.6, depth: 0.6, height: 0.9 });
  const wide = equipmentParts({ type: 'worktop', width: 2.4, depth: 0.6, height: 0.9 });
  assert.ok(Math.abs(thickness(narrow) - thickness(wide)) < 1e-9, 'le plan de travail change d’épaisseur');

  // l'évier : la hauteur est celle du plan de travail, le robinet vient au-dessus
  const sink = equipmentParts({ type: 'sink', width: 0.8, depth: 0.6, height: 0.9 });
  const worktopTop = Math.max(...sink.filter((p) => p.mat === 'worktop').flatMap((p) => p.mesh.positions.map((q) => q[2])));
  assert.ok(Math.abs(worktopTop - 0.9) < 1e-9, `plan de travail à ${worktopTop} au lieu de 0,90`);
  const top = Math.max(...sink.flatMap((p) => p.mesh.positions.map((q) => q[2])));
  assert.ok(top > 1.1, 'le robinet doit dépasser du plan de travail');
});
