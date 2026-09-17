import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function isSlab(mesh) {
  if (!mesh?.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh) return false;
  const data = mesh.userData || {};
  if (data.authoringType) return ['slab', 'mergedSlab'].includes(data.authoringType);
  return /(?:^|[^a-z])(ifcslab|slab|dalle|floor|plancher)(?:$|[^a-z])/i.test(
    [mesh.name, data.ifcHint, data.ifcType, data.smeltIfcType].filter(Boolean).join(' ')
  );
}

export function mergeEligibility(meshes) {
  if (meshes.length < 2) return 'Sélectionne au moins deux dalles avec Shift+clic.';
  if (new Set(meshes).size !== meshes.length || !meshes.every(isSlab)) return 'La sélection doit contenir uniquement des dalles.';
  const storeys = new Set(meshes.map(mesh => String(mesh.userData.storeyId ?? '')));
  const elevations = new Set(meshes.map(mesh => Number(mesh.userData.storeyElevation ?? 0)));
  if (storeys.size > 1 || elevations.size > 1) return 'Les dalles doivent appartenir au même étage.';
  if (meshes.some(mesh => mesh.userData.slabOpenings?.length)) return 'Les dalles avec une trémie liée à un escalier ne peuvent pas être regroupées.';
  if (meshes.some(mesh => !mesh.parent || mesh.children.length)) return 'Les dalles doivent être des meshes sans objets enfants.';
  return '';
}

// Concatenation preserves triangles/materials; it is deliberately not a CSG union.
// A merged result is free geometry, not a rectangular parametric slab.
export function createMergeSlabsCommand(meshes, parent, { id, name } = {}) {
  const reason = mergeEligibility(meshes);
  if (reason) throw new Error(reason);
  parent.updateWorldMatrix(true, false);
  if (Math.abs(parent.matrixWorld.determinant()) < 1e-12) throw new Error('Transformation du groupe non inversible.');
  const inverseParent = parent.matrixWorld.clone().invert();
  const geometries = [];
  const materials = [];
  const groups = [];
  let vertexOffset = 0;
  let merged;
  try {
    for (const mesh of meshes) {
      const source = mesh.geometry;
      if (!source?.getAttribute('position') || Object.keys(source.morphAttributes).length || source.drawRange.start !== 0 || source.drawRange.count !== Infinity) {
        throw new Error('Géométrie partielle ou animée non prise en charge pour ce regroupement.');
      }
      mesh.updateWorldMatrix(true, false);
      const matrix = inverseParent.clone().multiply(mesh.matrixWorld);
      if (Math.abs(matrix.determinant()) < 1e-12) throw new Error('Une dalle a une échelle nulle.');
      const geometry = source.index ? source.toNonIndexed() : source.clone();
      geometries.push(geometry);
      geometry.applyMatrix4(matrix);
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const count = geometry.getAttribute('position').count;
      if (count % 3) throw new Error('La géométrie doit contenir des triangles complets.');
      // Mirroring changes winding. Reverse every attribute to retain face orientation.
      if (matrix.determinant() < 0) {
        for (const attr of Object.values(geometry.attributes)) {
          for (let i = 0; i < count; i += 3) {
            for (let c = 0; c < attr.itemSize; c++) {
              const value = attr.getComponent(i + 1, c);
              attr.setComponent(i + 1, c, attr.getComponent(i + 2, c));
              attr.setComponent(i + 2, c, value);
            }
          }
        }
        const tangent = geometry.getAttribute('tangent');
        if (tangent) for (let i = 0; i < count; i++) tangent.setW(i, -tangent.getW(i));
      }
      const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const sourceGroups = Array.isArray(mesh.material) ? source.groups : [{ start: 0, count, materialIndex: 0 }];
      let covered = 0;
      for (const group of [...sourceGroups].sort((a, b) => a.start - b.start)) {
        if (group.start !== covered || group.count % 3 || group.start + group.count > count || !sourceMaterials[group.materialIndex]) {
          throw new Error('Groupes de matériaux incomplets ou incompatibles.');
        }
        covered += group.count;
        const material = sourceMaterials[group.materialIndex];
        let index = materials.indexOf(material);
        if (index < 0) index = materials.push(material) - 1;
        groups.push({ start: vertexOffset + group.start, count: group.count, materialIndex: index });
      }
      if (covered !== count) throw new Error('Groupes de matériaux incomplets.');
      vertexOffset += count;
    }
    const signature = geometry => Object.entries(geometry.attributes).sort().map(([key, attr]) => `${key}:${attr.itemSize}:${attr.normalized}:${attr.array?.constructor.name}`).join('|');
    if (!geometries.every(geometry => signature(geometry) === signature(geometries[0]))) {
      throw new Error('Attributs géométriques différents (UV, couleurs, etc.) : regroupement annulé pour les préserver.');
    }
    merged = mergeGeometries(geometries, false);
    if (!merged) throw new Error('Impossible de regrouper ces géométries.');
  } finally {
    geometries.forEach(geometry => geometry.dispose());
  }
  merged.clearGroups();
  groups.forEach(group => merged.addGroup(group.start, group.count, group.materialIndex));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  const result = new THREE.Mesh(merged, materials);
  result.name = name || 'Slab_Merged';
  const base = meshes[0].userData;
  result.userData = {
    __modelerId: id,
    modelerId: id,
    authoringType: 'mergedSlab',
    ifcHint: 'IfcSlab',
    storeyId: base.storeyId,
    storeyName: base.storeyName,
    storeyElevation: base.storeyElevation,
    mergedFrom: meshes.map(mesh => ({ id: mesh.userData.__modelerId, name: mesh.name })),
  };
  for (const key of Object.keys(result.userData)) {
    if (result.userData[key] === undefined) delete result.userData[key];
  }
  const records = meshes.map(mesh => ({ mesh, parent: mesh.parent, index: mesh.parent.children.indexOf(mesh) }));
  return {
    type: 'mergeSlabs', label: 'Regrouper les dalles', mesh: result, records,
    redo() {
      records.forEach(record => record.mesh.removeFromParent());
      parent.add(result);
    },
    undo() {
      result.removeFromParent();
      for (const record of [...records].sort((a, b) => a.index - b.index)) {
        record.parent.add(record.mesh);
        const children = record.parent.children;
        children.splice(children.indexOf(record.mesh), 1);
        children.splice(Math.min(record.index, children.length), 0, record.mesh);
      }
    },
  };
}

// GLTFLoader represents a multi-material glTF mesh as a Group of primitives.
// Restore only our explicitly tagged free slabs, leaving arbitrary imports alone.
export function restoreMergedSlabGroups(root) {
  const groups = [];
  root.traverse(object => {
    if (!object.isMesh && object.userData?.authoringType === 'mergedSlab' && object.children.length >= 2) groups.push(object);
  });
  for (const group of groups) {
    const children = [...group.children];
    if (!children.every(child => child.isMesh && !child.isSkinnedMesh && !child.isInstancedMesh && child.children.length === 0)) continue;
    const metadata = children.map(child => child.userData);
    let command;
    try {
      children.forEach(child => { child.userData = { ...group.userData }; });
      command = createMergeSlabsCommand(children, group, { id: group.userData.__modelerId ?? group.userData.modelerId, name: group.name });
    } finally {
      children.forEach((child, i) => { child.userData = metadata[i]; });
    }
    command.mesh.userData = { ...group.userData };
    command.redo();
  }
}
