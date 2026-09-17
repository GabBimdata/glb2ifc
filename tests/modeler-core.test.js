import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ObjectSelection } from '../src/modeler/object-selection.js';
import { createMergeSlabsCommand, mergeEligibility, restoreMergedSlabGroups } from '../src/modeler/merge-slabs.js';

function slab(parent, x = 0, material = new THREE.MeshBasicMaterial()) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), material);
  mesh.name = 'Slab';
  mesh.userData = { authoringType: 'slab', storeyId: 'storey-0', storeyElevation: 0, slabBoundary: { minX: 0, maxX: 2 }, __modelerId: x + 1 };
  mesh.position.x = x;
  parent.add(mesh);
  return mesh;
}
function points(mesh) {
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.index;
  return Array.from({ length: idx ? idx.count : pos.count }, (_, i) => {
    const j = idx ? idx.getX(i) : i;
    return new THREE.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(mesh.matrixWorld).toArray();
  });
}

test('selection: simple click, modifier toggle, empty click, detached object cleanup', () => {
  const root = new THREE.Scene(), a = slab(root), b = slab(root, 3), selection = new ObjectSelection();
  assert.equal(selection.select(a), a);
  assert.equal(selection.select(b, true), b);
  selection.sync(root, [a, b]);
  assert.equal(selection.helpers.size, 2);
  assert.equal(selection.select(b, true), a);
  selection.sync(root, [a, b]);
  assert.equal(selection.helpers.size, 0);
  selection.select(b, true);
  selection.sync(root, [a]);
  assert.deepEqual([...selection.objects], [a]);
  selection.select(null);
  selection.sync(root, [a]);
  assert.equal(selection.objects.size, 0);
});

test('merge preserves world geometry under rotated, scaled parents and source materials', () => {
  const root = new THREE.Group(); root.position.set(5, 2, -4); root.rotation.y = 0.4; root.scale.set(2, 1, 3);
  const child = new THREE.Group(); child.rotation.y = 0.7; root.add(child);
  const a = slab(child), b = slab(root, 5); b.rotation.z = 0.2;
  const before = [...points(a), ...points(b)];
  const command = createMergeSlabsCommand([a,b], root, { id: 20 });
  assert.equal(a.parent, child, 'preparing command must not change scene');
  command.redo();
  const actual = points(command.mesh);
  assert.equal(actual.length, before.length);
  for (let i = 0; i < before.length; i++) {
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[i][axis] - before[i][axis]) < 1e-5, 'world coordinates must survive Float32 baking');
  }
  assert.deepEqual(command.mesh.material, [a.material, b.material]);
  assert.equal(command.mesh.geometry.groups.length, 2);
  assert.equal(command.mesh.userData.__modelerId, 20);
  assert.equal(command.mesh.userData.slabBoundary, undefined);
  assert.equal(command.mesh.userData.authoringType, 'mergedSlab');
  assert.equal(command.mesh.userData.ifcHint, 'IfcSlab');
});

test('undo/redo restores original objects, transforms and sibling order', () => {
  const root = new THREE.Group(), first = slab(root), other = new THREE.Group(), last = slab(root, 4);
  root.add(other); const order = [...root.children];
  const command = createMergeSlabsCommand([last, first], root);
  const before = points(first);
  for (let i = 0; i < 3; i++) {
    command.redo(); assert.equal(first.parent, null);
    command.undo(); assert.deepEqual(root.children, order); assert.deepEqual(points(first), before);
  }
});

test('incompatible selection and linked stair holes are rejected without mutation', () => {
  const root = new THREE.Group(), a = slab(root), b = slab(root, 3);
  b.userData.storeyId = 'storey-1';
  assert.match(mergeEligibility([a,b]), /étage/);
  assert.throws(() => createMergeSlabsCommand([a,b], root));
  b.userData.storeyId = a.userData.storeyId; b.userData.slabOpenings = [{ stairId: 12 }];
  assert.match(mergeEligibility([a,b]), /trémie/);
  assert.deepEqual(root.children, [a,b]);
});

test('different vertex attributes are rejected rather than discarded', () => {
  const root = new THREE.Group(), a = slab(root), b = slab(root, 3);
  b.geometry.deleteAttribute('uv');
  assert.throws(() => createMergeSlabsCommand([a,b], root), /Attributs/);
  assert.deepEqual(root.children, [a,b]);
});

test('multi-material groups survive and mirrored faces retain outward normals', () => {
  const root = new THREE.Group();
  const mats = Array.from({length: 6}, () => new THREE.MeshBasicMaterial());
  const a = slab(root, 0, mats), b = slab(root, 3, mats); b.scale.x = -1;
  const command = createMergeSlabsCommand([a,b], root);
  command.redo();
  assert.equal(command.mesh.geometry.groups.length, 12);
  const g = command.mesh.geometry, p = g.getAttribute('position'), n = g.getAttribute('normal');
  for (let i = 0; i < p.count; i += 3) {
    const v = j => new THREE.Vector3().fromBufferAttribute(p, j);
    const geometricNormal = v(i+1).sub(v(i)).cross(v(i+2).sub(v(i))).normalize();
    assert.ok(geometricNormal.dot(new THREE.Vector3().fromBufferAttribute(n, i)) > 0.99);
  }
});


test('tagged GLB multi-material group reopens as one editable object', () => {
  const root = new THREE.Group(), group = new THREE.Group(); root.add(group);
  group.position.set(1, 2, 3); group.rotation.y = 0.7;
  group.userData = { authoringType: 'mergedSlab', __modelerId: 23, ifcHint: 'IfcSlab', mergedFrom: ['A', 'B'] };
  const a = slab(group), b = slab(group, 4);
  const before = [...points(a), ...points(b)];
  restoreMergedSlabGroups(root);
  assert.equal(group.children.length, 1);
  const result = group.children[0];
  assert.equal(result.userData.__modelerId, 23);
  assert.deepEqual(result.userData.mergedFrom, ['A', 'B']);
  const after = points(result);
  for (let i = 0; i < before.length; i++) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(before[i][axis] - after[i][axis]) < 1e-5);
  assert.equal(result.material.length, 2);
  restoreMergedSlabGroups(root);
  assert.equal(group.children[0], result, 'restoration is idempotent');
});
