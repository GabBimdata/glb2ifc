import * as THREE from "three";

const VERSION = "SMELT_MODELER_PLUS_MULTISELECT_MERGE_V1";

if (window.__SMELT_MODELER_PLUS__?.version === VERSION) {
  console.info(`[${VERSION}] déjà chargé.`);
} else {
  window.__SMELT_MODELER_PLUS__ = createPluginState();
  installRendererCapture();
  installUiLoop();
  installCanvasSelectionLoop();
  installWallPathSyncLoop();
  console.info(`[${VERSION}] actif.`);
}

function createPluginState() {
  return {
    version: VERSION,
    renderer: null,
    camera: null,
    scene: null,
    selectedObjects: new Set(),
    selectedSlabs: new Set(),
    helpers: new Map(),
    helperGroup: null,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    mergeButton: null,
    statusBox: null,
    lastPointerInstallCanvas: null,
    originalRender: null,
  };
}

function plugin() {
  return window.__SMELT_MODELER_PLUS__;
}

function installRendererCapture() {
  const proto = THREE.WebGLRenderer?.prototype;
  if (!proto || proto.__smeltModelerPlusRenderPatched) return;

  const originalRender = proto.render;
  proto.__smeltModelerPlusRenderPatched = true;
  proto.__smeltModelerPlusOriginalRender = originalRender;

  proto.render = function smeltModelerPlusRender(scene, camera, ...rest) {
    const p = plugin();
    p.renderer = this;
    p.scene = scene || p.scene;
    p.camera = camera || p.camera;
    updateSelectionHelpers();
    return originalRender.call(this, scene, camera, ...rest);
  };
}

function installUiLoop() {
  const tick = () => {
    ensureStatusBox();
    ensureMergeButton();
    updateMergeButtonState();
  };
  tick();
  setInterval(tick, 750);
}

function ensureStatusBox() {
  const p = plugin();
  if (p.statusBox?.isConnected) return p.statusBox;

  const host = document.querySelector('.authoring-dock') || document.body;
  let box = document.getElementById('smelt-plus-inline-status');
  if (!box) {
    box = document.createElement('div');
    box.id = 'smelt-plus-inline-status';
    box.style.cssText = [
      'position:absolute',
      'left:50%',
      'bottom:calc(100% + 8px)',
      'transform:translateX(-50%)',
      'display:none',
      'max-width:min(760px, calc(100vw - 2rem))',
      'padding:.45rem .65rem',
      'border:1px solid rgba(255,146,72,.45)',
      'border-radius:999px',
      'background:rgba(15,20,25,.90)',
      'color:#e8eaed',
      'font-size:.66rem',
      'white-space:nowrap',
      'pointer-events:none',
      'z-index:20',
      'box-shadow:0 10px 30px rgba(0,0,0,.25)',
    ].join(';');
    host.style.position = host.style.position || 'absolute';
    host.appendChild(box);
  }
  p.statusBox = box;
  return box;
}

function showPlusStatus(message, type = 'ok') {
  const box = ensureStatusBox();
  box.textContent = message;
  box.style.display = 'block';
  box.style.borderColor = type === 'error' ? 'rgba(255,107,107,.75)' : 'rgba(255,146,72,.45)';
  clearTimeout(box.__hideTimer);
  box.__hideTimer = setTimeout(() => { box.style.display = 'none'; }, 4500);
}

function ensureMergeButton() {
  const p = plugin();
  if (p.mergeButton?.isConnected) return p.mergeButton;

  let btn = document.getElementById('merge-selected-slabs');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'merge-selected-slabs';
    btn.type = 'button';
    btn.textContent = 'Merge';
    btn.title = 'Ctrl/Shift+clic pour sélectionner plusieurs slabs, puis fusionner en une seule slab';

    const anchor = document.getElementById('walls-from-slab') || document.getElementById('roof-from-slab');
    if (anchor?.parentElement) anchor.insertAdjacentElement('afterend', btn);
    else document.querySelector('.authoring-dock .dock-group')?.appendChild(btn);
  }

  btn.addEventListener('click', mergeSelectedSlabs);
  p.mergeButton = btn;
  updateMergeButtonState();
  return btn;
}

function updateMergeButtonState() {
  const p = plugin();
  const btn = p.mergeButton;
  if (!btn) return;
  const count = [...p.selectedSlabs].filter(isLiveSlab).length;
  btn.disabled = count < 2;
  btn.textContent = count > 0 ? `Merge (${count})` : 'Merge';
  btn.classList.toggle('active', count >= 2);
}

function installCanvasSelectionLoop() {
  const tick = () => {
    const canvas = document.querySelector('#container canvas');
    const p = plugin();
    if (!canvas || p.lastPointerInstallCanvas === canvas) return;

    if (p.lastPointerInstallCanvas) {
      p.lastPointerInstallCanvas.removeEventListener('pointerdown', onCanvasPointerDown, true);
    }

    canvas.addEventListener('pointerdown', onCanvasPointerDown, true);
    p.lastPointerInstallCanvas = canvas;
  };
  tick();
  setInterval(tick, 750);
}

function onCanvasPointerDown(event) {
  const p = plugin();
  if (!p.scene || !p.camera) return;
  if (event.button !== 0) return;

  const wantsMultiSelect = event.ctrlKey || event.metaKey || event.shiftKey;
  if (!wantsMultiSelect) {
    clearPlusSelection();
    return;
  }

  const slab = pickSlabFromPointer(event);
  if (!slab) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  if (p.selectedSlabs.has(slab)) {
    p.selectedSlabs.delete(slab);
    p.selectedObjects.delete(slab);
  } else {
    p.selectedSlabs.add(slab);
    p.selectedObjects.add(slab);
  }

  updateSelectionHelpers();
  updateMergeButtonState();
  showPlusStatus(`${p.selectedSlabs.size} slab(s) sélectionnée(s) pour Merge.`);
}

function pickSlabFromPointer(event) {
  const p = plugin();
  const canvas = p.renderer?.domElement || document.querySelector('#container canvas');
  if (!canvas || !p.camera || !p.scene) return null;

  const rect = canvas.getBoundingClientRect();
  p.pointer.set(
    ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
    -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1),
  );
  p.raycaster.setFromCamera(p.pointer, p.camera);

  const slabs = currentSlabs();
  const hits = p.raycaster.intersectObjects(slabs, true);
  for (const hit of hits) {
    const slab = findAncestor(hit.object, isSlabLikeMesh);
    if (slab) return slab;
  }
  return null;
}

function findAncestor(object, predicate) {
  let current = object;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

function clearPlusSelection() {
  const p = plugin();
  if (!p.selectedObjects.size && !p.selectedSlabs.size) return;
  p.selectedObjects.clear();
  p.selectedSlabs.clear();
  updateSelectionHelpers();
  updateMergeButtonState();
}

function updateSelectionHelpers() {
  const p = plugin();
  if (!p.scene) return;
  if (!p.helperGroup || !p.helperGroup.parent) {
    p.helperGroup = new THREE.Group();
    p.helperGroup.name = 'SmeltPlusSelectionHelpers';
    p.helperGroup.userData.__modelerOverlay = true;
    p.scene.add(p.helperGroup);
  }

  for (const [uuid, helper] of [...p.helpers.entries()]) {
    const stillSelected = [...p.selectedObjects].some((object) => object.uuid === uuid && object.parent);
    if (!stillSelected) {
      helper.parent?.remove(helper);
      helper.geometry?.dispose?.();
      p.helpers.delete(uuid);
    }
  }

  for (const object of [...p.selectedObjects]) {
    if (!object?.parent) {
      p.selectedObjects.delete(object);
      p.selectedSlabs.delete(object);
      continue;
    }
    let helper = p.helpers.get(object.uuid);
    if (!helper) {
      helper = new THREE.BoxHelper(object, 0xff9248);
      helper.name = `Plus helper ${object.name || object.uuid}`;
      helper.userData.__modelerOverlay = true;
      helper.renderOrder = 10000;
      p.helperGroup.add(helper);
      p.helpers.set(object.uuid, helper);
    }
    helper.update();
  }
}

function currentMeshes() {
  const p = plugin();
  const scene = p.scene;
  if (!scene) return [];
  const meshes = [];
  scene.traverse((object) => {
    if (!object?.isMesh) return;
    if (object.userData?.__modelerOverlay) return;
    if (!object.parent) return;
    meshes.push(object);
  });
  return meshes;
}

function currentSlabs() {
  return currentMeshes().filter(isLiveSlab);
}

function isLiveSlab(mesh) {
  return Boolean(mesh?.parent && mesh.isMesh && isSlabLikeMesh(mesh));
}

function isSlabLikeMesh(mesh) {
  if (!mesh?.isMesh) return false;
  const u = mesh.userData || {};
  const haystack = [
    mesh.name,
    u.name,
    u.type,
    u.kind,
    u.category,
    u.elementType,
    u.modelerType,
    u.modelerKind,
    u.authoringType,
    u.authoringKind,
    u.smeltAuthoringType,
    u.ifcType,
    u.IFCType,
    u.smeltIfcType,
  ].map((v) => String(v || '').toLowerCase()).join(' ');

  return /(^|\b)(slab|slabs|dalle|dalles|plancher|ifcslab)(\b|$)/i.test(haystack) || /^slab[_\s-]?\d*/i.test(String(mesh.name || ''));
}

function isWallLikeMesh(mesh) {
  if (!mesh?.isMesh) return false;
  const u = mesh.userData || {};
  const haystack = [
    mesh.name,
    u.name,
    u.type,
    u.kind,
    u.category,
    u.elementType,
    u.modelerType,
    u.modelerKind,
    u.authoringType,
    u.authoringKind,
    u.smeltAuthoringType,
    u.ifcType,
    u.IFCType,
    u.smeltIfcType,
  ].map((v) => String(v || '').toLowerCase()).join(' ');

  return Boolean(
    u.wallPath ||
    u.isWall ||
    u.isAuthoringWall ||
    u.authoringWall ||
    u.openingHost ||
    u.canHostOpenings ||
    /(^|\b)(wall|walls|mur|murs|cloison|cloisons|partition|ifcwall|ifcwallstandardcase)(\b|$)/i.test(haystack)
  );
}

function mergeSelectedSlabs() {
  const p = plugin();
  const slabs = [...p.selectedSlabs].filter(isLiveSlab);
  if (slabs.length < 2) {
    showPlusStatus('Sélectionne au moins 2 slabs avec Ctrl/Shift+clic.', 'error');
    return;
  }

  const base = slabs[0];
  const geometries = slabs.filter((mesh) => mesh.geometry?.getAttribute?.('position'));
  if (geometries.length < 2) {
    showPlusStatus('Impossible de merger: géométrie slab manquante.', 'error');
    return;
  }

  base.updateMatrixWorld(true);
  const inverseBaseWorld = new THREE.Matrix4().copy(base.matrixWorld).invert();

  const positions = [];
  const indices = [];
  let vertexOffset = 0;

  const v = new THREE.Vector3();

  for (const mesh of geometries) {
    mesh.updateMatrixWorld(true);
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    const index = geom.getIndex();

    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i)
        .applyMatrix4(mesh.matrixWorld)
        .applyMatrix4(inverseBaseWorld);
      positions.push(v.x, v.y, v.z);
    }

    if (index) {
      for (let i = 0; i < index.count; i += 1) {
        indices.push(index.getX(i) + vertexOffset);
      }
    } else {
      for (let i = 0; i < pos.count; i += 1) indices.push(vertexOffset + i);
    }

    vertexOffset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  const oldGeometry = base.geometry;
  base.geometry = merged;
  oldGeometry?.dispose?.();

  const now = Date.now();
  base.name = base.name && /merged/i.test(base.name) ? base.name : `Slab_Merged_${now}`;
  base.userData = {
    ...(base.userData || {}),
    type: 'slab',
    kind: 'slab',
    category: 'slab',
    authoringType: 'slab',
    authoringKind: 'slab',
    smeltAuthoringType: 'slab',
    smeltIfcType: 'IFCSLAB',
    mergedSlab: true,
    mergedAt: new Date().toISOString(),
    mergedFrom: slabs.map((mesh) => mesh.name || mesh.uuid),
  };

  for (const mesh of slabs.slice(1)) {
    mesh.userData = { ...(mesh.userData || {}), mergedInto: base.uuid, __smeltMergedHidden: true };
    mesh.parent?.remove(mesh);
  }

  p.selectedObjects.clear();
  p.selectedSlabs.clear();
  p.selectedObjects.add(base);
  p.selectedSlabs.add(base);
  updateSelectionHelpers();
  updateMergeButtonState();

  showPlusStatus(`${slabs.length} slabs mergées dans ${base.name}.`);
  dispatchModelChanged();
}

function dispatchModelChanged() {
  window.dispatchEvent(new CustomEvent('smelt:modeler-plus:model-changed', { detail: { source: VERSION } }));
}

function installWallPathSyncLoop() {
  const sync = () => {
    for (const mesh of currentMeshes()) {
      if (isWallLikeMesh(mesh)) syncWallPathFromGeometry(mesh);
    }
  };
  setInterval(sync, 350);
}

function readPoint(value) {
  if (Array.isArray(value)) {
    return new THREE.Vector3(Number(value[0] || 0), Number(value[1] || 0), Number(value[2] || 0));
  }
  return new THREE.Vector3(Number(value?.x || 0), Number(value?.y || 0), Number(value?.z || 0));
}

function pointObject(v) {
  return { x: Number(v.x), y: Number(v.y), z: Number(v.z) };
}

function syncWallPathFromGeometry(mesh) {
  const geom = mesh.geometry;
  const pos = geom?.getAttribute?.('position');
  if (!pos?.count) return false;

  const oldPath = mesh.userData?.wallPath || {};
  let start = readPoint(oldPath.start);
  let end = readPoint(oldPath.end);
  let dir = new THREE.Vector3(end.x - start.x, 0, end.z - start.z);

  const worldBox = new THREE.Box3().setFromObject(mesh);
  const size = worldBox.getSize(new THREE.Vector3());

  if (dir.lengthSq() < 1e-8) {
    dir = size.x >= size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  } else {
    dir.normalize();
  }

  const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
  const v = new THREE.Vector3();

  let minS = Infinity, maxS = -Infinity;
  let minT = Infinity, maxT = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  mesh.updateMatrixWorld(true);
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const s = v.dot(dir);
    const t = v.dot(perp);
    minS = Math.min(minS, s);
    maxS = Math.max(maxS, s);
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }

  if (![minS, maxS, minT, maxT, minY, maxY].every(Number.isFinite)) return false;

  const length = maxS - minS;
  const thickness = Math.max(0.001, maxT - minT);
  const height = Math.max(0.001, maxY - minY);
  if (length < 0.01) return false;

  const centerT = (minT + maxT) / 2;
  start = dir.clone().multiplyScalar(minS).add(perp.clone().multiplyScalar(centerT));
  end = dir.clone().multiplyScalar(maxS).add(perp.clone().multiplyScalar(centerT));
  start.y = minY;
  end.y = minY;

  const openings = Array.isArray(oldPath.openings) ? oldPath.openings : [];
  const nextPath = {
    ...oldPath,
    start: pointObject(start),
    end: pointObject(end),
    height,
    thickness,
    openings,
  };

  mesh.userData = {
    ...(mesh.userData || {}),
    wallPath: nextPath,
    wallHeight: height,
    wallThickness: thickness,
    dimensions: {
      ...(mesh.userData?.dimensions || {}),
      length,
      height,
      thickness,
    },
    isWall: true,
    isAuthoringWall: true,
    canHostOpenings: true,
    openingHost: true,
  };

  return true;
}
