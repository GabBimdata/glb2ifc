// Smelt Modeler Plus bootstrap
// - Shift+clic multi-selection objet dans le modeler
// - Bouton Merge slabs actif quand au moins 2 slabs sont sélectionnées
// - Merge géométrique des slabs sélectionnées
// - Resync wallPath des murs avant pose Door/Window pour éviter le reset

async function loadAndPatchModeler() {
  const response = await fetch('/src/modeler.js?modeler-plus=' + Date.now(), { cache: 'no-store' });
  if (!response.ok) throw new Error('Impossible de charger /src/modeler.js');
  let source = await response.text();

  // Injection d'un bouton DOM si modeler.html n'a pas été modifié par le loader.
  source = source.replace(
    'const roofFromSlabButton = document.getElementById("roof-from-slab");',
    'const roofFromSlabButton = document.getElementById("roof-from-slab");\nconst mergeSlabsButton = document.getElementById("merge-slabs");'
  );

  // Etat multi-sélection persistant.
  source = source.replace(
    'selected: null,',
    'selected: null,\n  multiSelected: new Set(),\n  multiBoxHelpers: new Map(),\n  multiLastModifier: false,'
  );

  // Event du bouton Merge.
  source = source.replace(
    'roofFromSlabButton?.addEventListener("click", createRoofFromSelectedSlab);',
    'roofFromSlabButton?.addEventListener("click", createRoofFromSelectedSlab);\n  mergeSlabsButton?.addEventListener("click", mergeSelectedSlabsPlus);'
  );

  // Hook de sélection : le code original continue à sélectionner le dernier objet,
  // mais on maintient en parallèle un Set multi-sélectionné.
  source = source.replace(
    'function selectMesh(mesh) {',
    'function selectMesh(mesh) {\n  smeltPlusBeforeSelectMesh(mesh);'
  );

  // Hook update UI : pas grave si absent, on met aussi des listeners directs.
  source = source.replace(
    'function updateUiEnabled() {',
    'function updateUiEnabled() {\n  updateMergeSlabsButtonPlus();'
  );

  // Fix mur reset: avant de calculer/poser une ouverture, on recalcule wallPath
  // depuis la géométrie réelle si l'utilisateur a changé L/l via propriétés/transform.
  for (const needle of [
    'function updateOpeningPlacementPreview(',
    'function createOpeningOnWall(',
    'function placeOpeningOnWall(',
    'function commitOpeningPlacement(',
  ]) {
    if (source.includes(needle)) {
      source = source.replace(needle, needle + '\n  syncAllWallPathsFromGeometryPlus();');
    }
  }

  source += `\n\n${plusRuntimeSource()}\n`;

  const blob = new Blob([source], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  await import(url);
}

function plusRuntimeSource() {
  return String.raw`
// ─────────────────────────────────────────────────────────────
// Smelt Modeler Plus runtime injected into modeler.js module scope
// ─────────────────────────────────────────────────────────────

function smeltPlusInstallCaptureListeners() {
  const remember = (event) => {
    state.multiLastModifier = Boolean(event.shiftKey || event.ctrlKey || event.metaKey);
  };

  state.renderer?.domElement?.addEventListener('pointerdown', remember, true);
  state.renderer?.domElement?.addEventListener('pointerup', remember, true);
  tree?.addEventListener('pointerdown', remember, true);
  tree?.addEventListener('click', remember, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Shift') state.multiLastModifier = true;
  }, true);
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') state.multiLastModifier = false;
  }, true);

  updateMergeSlabsButtonPlus();
}

function smeltPlusBeforeSelectMesh(mesh) {
  if (!state.multiSelected) state.multiSelected = new Set();
  if (!state.multiBoxHelpers) state.multiBoxHelpers = new Map();

  const multi = Boolean(state.multiLastModifier);

  if (!multi) {
    clearMultiSelectionPlus();
    updateMergeSlabsButtonPlus();
    return;
  }

  // Shift/Ctrl/Cmd + clic : toggle sans perdre les autres objets déjà choisis.
  if (mesh) {
    if (state.multiSelected.has(mesh)) removeFromMultiSelectionPlus(mesh);
    else addToMultiSelectionPlus(mesh);
  }

  state.multiLastModifier = false;
  updateMergeSlabsButtonPlus();
}

function addToMultiSelectionPlus(mesh) {
  if (!mesh || mesh.userData?.__modelerOverlay) return;
  state.multiSelected.add(mesh);

  if (!state.multiBoxHelpers.has(mesh)) {
    const helper = new THREE.BoxHelper(mesh, 0xff9248);
    helper.userData.__modelerOverlay = true;
    helper.renderOrder = 9999;
    state.scene?.add(helper);
    state.multiBoxHelpers.set(mesh, helper);
  }

  state.multiBoxHelpers.get(mesh)?.update?.();
  markTreeItemMultiSelectedPlus(mesh, true);
}

function removeFromMultiSelectionPlus(mesh) {
  if (!mesh) return;
  state.multiSelected.delete(mesh);
  const helper = state.multiBoxHelpers?.get(mesh);
  if (helper) {
    helper.parent?.remove(helper);
    helper.geometry?.dispose?.();
    helper.material?.dispose?.();
  }
  state.multiBoxHelpers?.delete(mesh);
  markTreeItemMultiSelectedPlus(mesh, false);
}

function clearMultiSelectionPlus() {
  for (const mesh of [...(state.multiSelected || [])]) removeFromMultiSelectionPlus(mesh);
  state.multiSelected?.clear?.();
}

function refreshMultiSelectionHelpersPlus() {
  for (const helper of state.multiBoxHelpers?.values?.() || []) helper.update?.();
}

function markTreeItemMultiSelectedPlus(mesh, selected) {
  try {
    const items = [...tree.querySelectorAll('.tree-item')];
    const idx = state.meshes.indexOf(mesh);
    const name = String(mesh?.name || '');
    for (const item of items) {
      const text = item.textContent || '';
      if ((idx >= 0 && item.dataset?.index === String(idx)) || (name && text.includes(name))) {
        item.classList.toggle('selected', selected || item.classList.contains('selected'));
        if (selected) item.style.outline = '1px solid rgba(255,146,72,.55)';
        else item.style.outline = '';
      }
    }
  } catch {}
}

function isSlabMeshPlus(mesh) {
  if (!mesh?.isMesh) return false;
  const data = mesh.userData || {};
  const text = [
    mesh.name,
    data.authoringType,
    data.authoringKind,
    data.smeltIfcType,
    data.ifcType,
    data.type,
  ].filter(Boolean).join(' ').toLowerCase();
  return /(^|\b)(slab|dalle|floor|plancher|ifcslab)(\b|$)/i.test(text);
}

function selectedSlabsPlus() {
  const out = [...(state.multiSelected || [])].filter(isSlabMeshPlus);
  if (isSlabMeshPlus(state.selected) && !out.includes(state.selected)) out.push(state.selected);
  return out.filter((mesh, i, arr) => arr.indexOf(mesh) === i);
}

function updateMergeSlabsButtonPlus() {
  try {
    const count = selectedSlabsPlus().length;
    if (mergeSlabsButton) {
      mergeSlabsButton.disabled = count < 2;
      mergeSlabsButton.textContent = count >= 2 ? `Merge slabs (${count})` : 'Merge slabs';
      mergeSlabsButton.title = count >= 2
        ? `Fusionner ${count} slabs sélectionnées`
        : 'Shift+clic sur au moins 2 slabs pour activer le merge';
    }
    refreshMultiSelectionHelpersPlus();
  } catch {}
}

function transformedGeometryClonePlus(mesh) {
  mesh.updateWorldMatrix(true, false);
  const clone = mesh.geometry.clone();
  clone.applyMatrix4(mesh.matrixWorld);
  return clone.toNonIndexed();
}

function mergeBufferGeometriesPlus(geometries) {
  const positions = [];
  const normals = [];
  const uvs = [];
  let hasNormals = true;
  let hasUvs = true;

  for (const geom of geometries) {
    const pos = geom.getAttribute('position');
    const normal = geom.getAttribute('normal');
    const uv = geom.getAttribute('uv');
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    if (normal) {
      for (let i = 0; i < normal.count; i++) normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    } else {
      hasNormals = false;
    }
    if (uv) {
      for (let i = 0; i < uv.count; i++) uvs.push(uv.getX(i), uv.getY(i));
    } else {
      hasUvs = false;
    }
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (hasNormals && normals.length === positions.length) merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  else merged.computeVertexNormals();
  if (hasUvs && uvs.length === (positions.length / 3) * 2) merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function mergeSelectedSlabsPlus() {
  const slabs = selectedSlabsPlus();
  if (slabs.length < 2) {
    setStatus('Sélectionne au moins 2 slabs avec Shift+clic, puis Merge.', 'warning');
    return;
  }

  try {
    pushHistorySnapshot?.('Merge slabs');
  } catch {}

  const geometries = slabs.map(transformedGeometryClonePlus);
  const mergedGeometry = mergeBufferGeometriesPlus(geometries);
  geometries.forEach((g) => g.dispose?.());

  const base = slabs[0];
  const material = Array.isArray(base.material) ? base.material[0]?.clone?.() : base.material?.clone?.();
  const mesh = new THREE.Mesh(mergedGeometry, material || authoringSlabMaterial.clone());
  mesh.name = `Slab_Merged_${String(++state.authoring.slabCount).padStart(3, '0')}`;
  mesh.userData = {
    ...(base.userData || {}),
    authoringType: 'slab',
    authoringKind: 'slab',
    smeltIfcType: 'IFCSLAB',
    mergedFrom: slabs.map((s) => s.name || s.uuid),
    mergedAt: new Date().toISOString(),
    storeyId: base.userData?.storeyId || state.authoring.activeStoreyId,
  };

  const parent = state.modelRoot || state.scene;
  parent.add(mesh);

  for (const slab of slabs) {
    removeFromMultiSelectionPlus(slab);
    const i = state.meshes.indexOf(slab);
    if (i >= 0) state.meshes.splice(i, 1);
    slab.parent?.remove(slab);
    slab.geometry?.dispose?.();
  }

  state.meshes.push(mesh);
  clearMultiSelectionPlus();
  selectMesh(mesh);
  renderTree?.();
  updateUiEnabled?.();
  updateMergeSlabsButtonPlus();
  markDirty?.();
  setStatus(`${slabs.length} slabs fusionnées en ${mesh.name}.`, 'ok');
}

function syncWallPathFromGeometryPlus(mesh) {
  if (!mesh?.isMesh) return false;
  const data = mesh.userData || {};
  const text = [mesh.name, data.authoringType, data.authoringKind, data.smeltIfcType, data.ifcType].join(' ').toLowerCase();
  const looksWall = /wall|mur|cloison|partition|ifcwall/.test(text) || data.wallPath;
  if (!looksWall) return false;

  mesh.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const alongX = size.x >= size.z;
  const length = Math.max(alongX ? size.x : size.z, 0.001);
  const thickness = Math.max(alongX ? size.z : size.x, 0.001);
  const y = box.min.y;
  const start = alongX
    ? { x: center.x - length / 2, y, z: center.z }
    : { x: center.x, y, z: center.z - length / 2 };
  const end = alongX
    ? { x: center.x + length / 2, y, z: center.z }
    : { x: center.x, y, z: center.z + length / 2 };

  const previous = data.wallPath || {};
  mesh.userData.wallPath = {
    ...previous,
    start,
    end,
    height: Math.max(size.y, Number(previous.height) || Number(data.wallHeight) || state.authoring.wallHeight || 3),
    thickness,
    openings: Array.isArray(previous.openings) ? previous.openings : [],
  };
  mesh.userData.wallHeight = mesh.userData.wallPath.height;
  mesh.userData.wallThickness = thickness;
  mesh.userData.authoringType = mesh.userData.authoringType || 'wall';
  mesh.userData.authoringKind = mesh.userData.authoringKind || 'wall';
  return true;
}

function syncAllWallPathsFromGeometryPlus() {
  for (const mesh of state.meshes || []) syncWallPathFromGeometryPlus(mesh);
}

smeltPlusInstallCaptureListeners();
setInterval(() => {
  updateMergeSlabsButtonPlus();
  syncAllWallPathsFromGeometryPlus();
}, 700);
`;
}

loadAndPatchModeler().catch((error) => {
  console.error(error);
  document.body.innerHTML = '<pre style="padding:2rem;color:#ff6b6b;white-space:pre-wrap">Erreur Modeler Plus: ' + String(error && error.stack || error) + '</pre>';
});
