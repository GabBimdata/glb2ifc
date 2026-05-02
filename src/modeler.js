import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { getProject, updateProject, setLastProjectId, blobToText, blobToGlbFile, safeFileName } from "./project-store.js";

const container = document.getElementById("container");
const dropzone = document.getElementById("dropzone");
const input = document.getElementById("glb-input");
const statusBox = document.getElementById("status");
const tree = document.getElementById("tree");
const treeSearch = document.getElementById("tree-search");
const properties = document.getElementById("properties");

const fitButton = document.getElementById("select-all");
const clearButton = document.getElementById("clear-scene");
const exportGlbButton = document.getElementById("export-glb");
const convertIfcButton = document.getElementById("convert-ifc");
const translateButton = document.getElementById("mode-translate");
const rotateButton = document.getElementById("mode-rotate");
const scaleButton = document.getElementById("mode-scale");
const localButton = document.getElementById("space-local");
const worldButton = document.getElementById("space-world");
const resetTransformButton = document.getElementById("reset-transform");

const state = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  transform: null,
  transformHelper: null,
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  modelRoot: null,
  currentFile: null,
  currentFileName: "",
  meshes: [],
  selected: null,
  boxHelper: null,
  grid: null,
  axes: null,
  pointerDown: null,
  isTransformDragging: false,
  objectUrls: new Set(),
  projectId: null,
  project: null,
  returnToViewer: false,
};

const selectionMaterial = new THREE.MeshBasicMaterial({
  color: 0xff9248,
  transparent: true,
  opacity: 0.14,
  depthTest: false,
  depthWrite: false,
});

init();

function init() {
  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color("#0b1016");

  state.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100000);
  state.camera.position.set(8, 6, 8);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  state.renderer.toneMappingExposure = 1.05;
  container.appendChild(state.renderer.domElement);

  state.controls = new OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.08;
  state.controls.screenSpacePanning = true;

  state.transform = new TransformControls(state.camera, state.renderer.domElement);
  state.transform.setMode("translate");
  state.transform.setSpace("world");
  state.transform.addEventListener("dragging-changed", (event) => {
    state.isTransformDragging = event.value;
    state.controls.enabled = !event.value;
  });
  state.transform.addEventListener("change", () => {
    updateBoxHelper();
    renderProperties();
    markDirty();
  });
  state.transformHelper = state.transform.getHelper ? state.transform.getHelper() : state.transform;
  state.scene.add(state.transformHelper);
  state.transformHelper.visible = false;

  addDefaultSceneHelpers();
  bindEvents();
  resize();
  animate();
  updateUiEnabled();
  loadProjectFromUrl().catch((error) => {
    console.error(error);
    setStatus(`Impossible de charger le projet local : ${escapeHtml(error.message || error)}`, "error");
  });
}

function addDefaultSceneHelpers() {
  const ambient = new THREE.HemisphereLight(0xffffff, 0x1d2630, 1.6);
  state.scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(8, 14, 10);
  state.scene.add(key);

  const fill = new THREE.DirectionalLight(0xffd4b0, 0.9);
  fill.position.set(-10, 8, -8);
  state.scene.add(fill);

  state.grid = new THREE.GridHelper(30, 30, 0x3a4654, 0x202a34);
  state.grid.position.y = 0;
  state.scene.add(state.grid);

  state.axes = new THREE.AxesHelper(2.5);
  state.scene.add(state.axes);
}

function bindEvents() {
  window.addEventListener("resize", resize);

  for (const eventName of ["dragenter", "dragover"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("drag-over");
    });
  }

  for (const eventName of ["dragleave", "drop"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("drag-over");
    });
  }

  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files?.[0];
    if (file) loadFile(file);
  });

  input.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) loadFile(file);
  });

  state.renderer.domElement.addEventListener("pointerdown", onPointerDown);
  state.renderer.domElement.addEventListener("pointerup", onPointerUp);

  treeSearch.addEventListener("input", renderTree);

  fitButton.addEventListener("click", () => fitCameraToObject(state.modelRoot || state.grid));
  clearButton.addEventListener("click", clearScene);
  exportGlbButton.addEventListener("click", exportGlbDownload);
  convertIfcButton.addEventListener("click", convertEditedGlbToIfc);

  translateButton.addEventListener("click", () => setTransformMode("translate"));
  rotateButton.addEventListener("click", () => setTransformMode("rotate"));
  scaleButton.addEventListener("click", () => setTransformMode("scale"));
  localButton.addEventListener("click", () => setTransformSpace("local"));
  worldButton.addEventListener("click", () => setTransformSpace("world"));
  resetTransformButton.addEventListener("click", resetSelectedTransform);

  window.addEventListener("keydown", (event) => {
    if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if (event.key === "Escape") selectMesh(null);
    if (event.key.toLowerCase() === "t") setTransformMode("translate");
    if (event.key.toLowerCase() === "r") setTransformMode("rotate");
    if (event.key.toLowerCase() === "s") setTransformMode("scale");
    if (event.key.toLowerCase() === "l") setTransformSpace("local");
    if (event.key.toLowerCase() === "w") setTransformSpace("world");
  });
}

function resize() {
  const rect = container.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(width, height, false);
}

function animate() {
  requestAnimationFrame(animate);
  state.controls.update();
  state.renderer.render(state.scene, state.camera);
}

function setStatus(message, type = "") {
  statusBox.className = `status ${type}`.trim();
  statusBox.innerHTML = message;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadFile(file) {
  if (!/\.(glb|gltf)$/i.test(file.name)) {
    setStatus("Le modeler attend un fichier .glb ou .gltf.", "error");
    return;
  }

  setStatus(`<span class="spinner"></span>Chargement de <strong>${escapeHtml(file.name)}</strong> (${formatBytes(file.size)})…`);
  clearScene({ silent: true });

  const url = URL.createObjectURL(file);
  state.objectUrls.add(url);

  try {
    const loader = createGLTFLoader();
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) throw new Error("Le GLB ne contient pas de scène exploitable.");

    root.name = root.name || file.name.replace(/\.(glb|gltf)$/i, "");
    state.scene.add(root);
    state.modelRoot = root;
    state.currentFile = file;
    state.currentFileName = file.name;

    indexMeshes(root);
    if (state.meshes.length === 0) {
      setStatus("GLB chargé, mais aucun mesh éditable n’a été trouvé.", "warning");
    } else {
      setStatus(`GLB chargé : <strong>${state.meshes.length}</strong> mesh${state.meshes.length > 1 ? "es" : ""} éditable${state.meshes.length > 1 ? "s" : ""}.`, "ok");
    }

    renderTree();
    renderProperties();
    updateUiEnabled();
    fitCameraToObject(root);
  } catch (error) {
    console.error(error);
    setStatus(`Erreur de chargement GLB : ${escapeHtml(error.message)}`, "error");
    clearScene({ silent: true });
  } finally {
    URL.revokeObjectURL(url);
    state.objectUrls.delete(url);
    input.value = "";
  }
}

async function loadProjectFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("project");
  if (!projectId) return;

  const project = await getProject(projectId);
  if (!project?.glbBlob) {
    throw new Error("Projet local introuvable ou GLB source absent.");
  }

  state.projectId = project.id;
  state.project = project;
  state.returnToViewer = params.get("return") === "viewer";
  setLastProjectId(project.id);

  const file = blobToGlbFile(project.glbBlob, project.glbFileName || "model.glb");
  await loadFile(file, { fromProject: true });

  if (state.returnToViewer && convertIfcButton) {
    convertIfcButton.textContent = "Enregistrer → retour viewer IFC";
  }

  const pending = Number(project.edits?.length || 0);
  if (pending > 0) {
    setStatus("GLB source ouvert depuis le viewer · " + pending + " reclassification(s) seront réappliquée(s) au retour.", "ok");
  }
}

async function reexportIfcWithProjectEdits(ifcText, fileName) {
  const edits = state.project?.edits || [];
  if (!edits.length) return { ifcText, applied: 0, errors: 0 };

  const response = await fetch("/api/reexport", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ifcText, edits, fileName }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Erreur serveur reexport" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  return {
    ifcText: await response.text(),
    applied: Number(response.headers.get("X-Edits-Applied") || 0),
    errors: Number(response.headers.get("X-Edits-Errors") || 0),
  };
}

async function saveRoundTripAndReturn(glbBlob, ifcText, ifcFileName) {
  if (!state.projectId) return;
  const updated = await updateProject(state.projectId, {
    glbBlob,
    glbFileName: editedFileName("glb"),
    ifcText,
    ifcFileName: safeFileName(ifcFileName, "model.ifc"),
    edits: [],
    lastOpenedIn: "modeler",
  });
  state.project = updated;
  setLastProjectId(updated.id);
  window.location.href = `/viewer.html?project=${encodeURIComponent(updated.id)}&from=modeler`;
}

function createGLTFLoader() {
  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("/vendor/draco/");
  loader.setDRACOLoader(dracoLoader);
  return loader;
}

function indexMeshes(root) {
  state.meshes = [];
  const editableObjects = [];

  root.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) return;
    editableObjects.push(object);
  });

  // Some GLB exporters reuse the same BufferGeometry for several nodes. We clone
  // shared geometries before normalising pivots, otherwise moving one origin would
  // silently move vertices used by another mesh.
  const geometryUseCount = new Map();
  for (const object of editableObjects) {
    if (!object.geometry) continue;
    geometryUseCount.set(object.geometry, (geometryUseCount.get(object.geometry) || 0) + 1);
  }

  let index = 1;

  for (const object of editableObjects) {
    object.name = object.name || object.parent?.name || `Mesh_${index}`;
    object.userData.__modelerId = index++;

    if (object.geometry) {
      if (!object.isInstancedMesh && geometryUseCount.get(object.geometry) > 1) {
        object.geometry = object.geometry.clone();
      }

      normalizeEditablePivotToGeometryCenter(object);
      object.geometry.computeBoundingBox();
      object.geometry.computeBoundingSphere();
    }

    // Store the reset transform after pivot normalisation. Visually the mesh is
    // still in the same place, but its local origin is now useful for editing.
    object.userData.__originalTransform = {
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
    };

    state.meshes.push(object);
  }
}

function normalizeEditablePivotToGeometryCenter(object) {
  if (!object?.isMesh || object.isInstancedMesh || !object.geometry) return;

  const geometry = object.geometry;
  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) return;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return;

  const localCenter = new THREE.Vector3();
  box.getCenter(localCenter);

  if (localCenter.lengthSq() < 1e-18) {
    object.userData.__pivotNormalized = false;
    return;
  }

  // Re-center vertices around the local origin, then compensate the object local
  // transform so the mesh does not visually move. TransformControls attaches to
  // object.position, so this puts the gizmo at the geometry/bbox centre instead
  // of at an arbitrary exporter origin.
  geometry.translate(-localCenter.x, -localCenter.y, -localCenter.z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  object.updateMatrix();
  const compensatedLocalMatrix = object.matrix.clone().multiply(
    new THREE.Matrix4().makeTranslation(localCenter.x, localCenter.y, localCenter.z)
  );
  compensatedLocalMatrix.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrix();
  object.updateMatrixWorld(true);

  object.userData.__pivotNormalized = true;
  object.userData.__pivotOffset = localCenter.toArray();
}

function clearScene(options = {}) {
  selectMesh(null);

  if (state.modelRoot) {
    state.scene.remove(state.modelRoot);
    disposeObject(state.modelRoot);
  }

  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls.clear();

  state.modelRoot = null;
  state.currentFile = null;
  state.currentFileName = "";
  state.meshes = [];
  renderTree();
  renderProperties();
  updateUiEnabled();

  if (!options.silent) setStatus("Scène vidée.");
}

function disposeObject(root) {
  root.traverse((object) => {
    if (object.geometry) object.geometry.dispose?.();
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose?.();
    }
  });
}

function renderTree() {
  const query = normalize(treeSearch.value);
  const meshes = state.meshes.filter((mesh) => normalize(mesh.name).includes(query));

  if (!state.modelRoot) {
    tree.innerHTML = `<div class="tree-empty">Charge un GLB pour voir les meshes éditables.</div>`;
    return;
  }

  if (meshes.length === 0) {
    tree.innerHTML = `<div class="tree-empty">Aucun mesh ne correspond au filtre.</div>`;
    return;
  }

  tree.innerHTML = meshes.map((mesh) => {
    const stats = geometryStats(mesh);
    const selected = mesh === state.selected ? " selected" : "";
    return `
      <div class="tree-item${selected}" data-id="${mesh.userData.__modelerId}">
        <div class="tree-main">
          <div class="tree-name">${escapeHtml(mesh.name || `Mesh ${mesh.userData.__modelerId}`)}</div>
          <div class="tree-meta">${stats.vertices} vertices · ${stats.triangles} triangles</div>
        </div>
        <div class="tree-badge">#${mesh.userData.__modelerId}</div>
      </div>
    `;
  }).join("");

  for (const item of tree.querySelectorAll(".tree-item")) {
    item.addEventListener("click", () => {
      const id = Number(item.dataset.id);
      selectMesh(state.meshes.find((mesh) => mesh.userData.__modelerId === id) || null);
    });
  }
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function onPointerDown(event) {
  state.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
}

function onPointerUp(event) {
  if (!state.pointerDown || state.isTransformDragging) return;

  const dx = event.clientX - state.pointerDown.x;
  const dy = event.clientY - state.pointerDown.y;
  const moved = Math.hypot(dx, dy);
  const elapsed = performance.now() - state.pointerDown.time;
  state.pointerDown = null;

  if (moved > 4 || elapsed > 550) return;
  selectFromPointer(event);
}

function selectFromPointer(event) {
  if (!state.meshes.length) return;

  const rect = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hits = state.raycaster.intersectObjects(state.meshes, true);
  const hit = hits.find((entry) => entry.object?.isMesh || entry.object?.isInstancedMesh);
  selectMesh(hit?.object || null);
}

function selectMesh(mesh) {
  state.selected = mesh || null;

  if (state.selected) {
    state.transform.enabled = true;
    state.transform.attach(state.selected);
    state.transform.setSize?.(1.15);
  } else {
    state.transform.detach();
  }

  if (state.transformHelper) {
    state.transformHelper.visible = Boolean(state.selected);
  }

  updateBoxHelper();
  renderTree();
  renderProperties();
  updateUiEnabled();
}

function updateBoxHelper() {
  if (state.boxHelper) {
    state.scene.remove(state.boxHelper);
    state.boxHelper.geometry?.dispose?.();
    state.boxHelper.material?.dispose?.();
    state.boxHelper = null;
  }

  if (!state.selected) return;

  state.selected.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(state.selected);
  if (box.isEmpty()) return;

  state.boxHelper = new THREE.Box3Helper(box, 0xff9248);
  state.boxHelper.material.depthTest = false;
  state.boxHelper.renderOrder = 10;
  state.scene.add(state.boxHelper);
}

function renderProperties() {
  if (!state.selected) {
    properties.innerHTML = `<div class="properties-empty">Sélectionne un mesh dans la scène ou dans l’arbre.</div>`;
    return;
  }

  const mesh = state.selected;
  mesh.updateMatrixWorld(true);
  const stats = geometryStats(mesh);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  properties.innerHTML = `
    <div class="prop-section">
      <h3>Identité</h3>
      <div class="prop-grid">
        <div class="prop-row"><div class="prop-label">Nom</div><div class="prop-value"><input id="name-input" value="${escapeHtml(mesh.name)}" /></div></div>
        <div class="prop-row"><div class="prop-label">ID local</div><div class="prop-value">#${mesh.userData.__modelerId}</div></div>
        <div class="prop-row"><div class="prop-label">Type</div><div class="prop-value">${mesh.isInstancedMesh ? "InstancedMesh" : "Mesh"}</div></div>
      </div>
      <div class="hint">Le nom est conservé à l’export : ton classifieur GLB → IFC peut continuer à détecter wall/mur, door/porte, window/fenêtre, etc.</div>
    </div>

    <div class="prop-section">
      <h3>Géométrie</h3>
      <div class="prop-grid">
        <div class="prop-row"><div class="prop-label">Vertices</div><div class="prop-value">${stats.vertices}</div></div>
        <div class="prop-row"><div class="prop-label">Triangles</div><div class="prop-value">${stats.triangles}</div></div>
        <div class="prop-row"><div class="prop-label">BBox taille</div><div class="prop-value">${formatVector(size)}</div></div>
        <div class="prop-row"><div class="prop-label">BBox centre</div><div class="prop-value">${formatVector(center)}</div></div>
      </div>
    </div>

    <div class="prop-section">
      <h3>Transform local</h3>
      <div class="prop-grid">
        <div class="prop-row"><div class="prop-label">Position</div><div class="prop-value">${formatVector(mesh.position)}</div></div>
        <div class="prop-row"><div class="prop-label">Rotation</div><div class="prop-value">${formatEuler(mesh.rotation)}</div></div>
        <div class="prop-row"><div class="prop-label">Scale</div><div class="prop-value">${formatVector(mesh.scale)}</div></div>
      </div>
    </div>
  `;

  const nameInput = document.getElementById("name-input");
  nameInput.addEventListener("input", () => {
    mesh.name = nameInput.value.trim() || `Mesh_${mesh.userData.__modelerId}`;
    renderTree();
    markDirty();
  });
}

function geometryStats(mesh) {
  const geometry = mesh.geometry;
  if (!geometry) return { vertices: 0, triangles: 0 };

  const position = geometry.getAttribute("position");
  const vertices = position?.count || 0;
  const triangles = geometry.index ? Math.floor(geometry.index.count / 3) : Math.floor(vertices / 3);
  return { vertices, triangles };
}

function formatVector(vector) {
  return [vector.x, vector.y, vector.z].map((value) => Number(value || 0).toFixed(3)).join(", ");
}

function formatEuler(euler) {
  return [euler.x, euler.y, euler.z]
    .map((value) => THREE.MathUtils.radToDeg(Number(value || 0)).toFixed(1) + "°")
    .join(", ");
}

function setTransformMode(mode) {
  state.transform.setMode(mode);
  updateToolbarState();
}

function setTransformSpace(space) {
  state.transform.setSpace(space);
  updateToolbarState();
}

function updateToolbarState() {
  translateButton.classList.toggle("active", state.transform.getMode() === "translate");
  rotateButton.classList.toggle("active", state.transform.getMode() === "rotate");
  scaleButton.classList.toggle("active", state.transform.getMode() === "scale");
  localButton.classList.toggle("active", state.transform.space === "local");
  worldButton.classList.toggle("active", state.transform.space === "world");
}

function resetSelectedTransform() {
  if (!state.selected) return;
  const original = state.selected.userData.__originalTransform;
  if (!original) return;

  state.selected.position.copy(original.position);
  state.selected.quaternion.copy(original.quaternion);
  state.selected.scale.copy(original.scale);
  state.selected.updateMatrixWorld(true);
  updateBoxHelper();
  renderProperties();
  markDirty();
}

function updateUiEnabled() {
  const hasModel = Boolean(state.modelRoot);
  const hasSelection = Boolean(state.selected);

  fitButton.disabled = !hasModel;
  clearButton.disabled = !hasModel;
  exportGlbButton.disabled = !hasModel;
  convertIfcButton.disabled = !hasModel;
  translateButton.disabled = !hasSelection;
  rotateButton.disabled = !hasSelection;
  scaleButton.disabled = !hasSelection;
  localButton.disabled = !hasSelection;
  worldButton.disabled = !hasSelection;
  resetTransformButton.disabled = !hasSelection;

  updateToolbarState();
}

function markDirty() {
  if (!state.modelRoot) return;
  exportGlbButton.disabled = false;
  convertIfcButton.disabled = false;
}

function fitCameraToObject(object) {
  if (!object) return;

  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxSize = Math.max(size.x, size.y, size.z, 1);
  const distance = maxSize / (2 * Math.tan(THREE.MathUtils.degToRad(state.camera.fov * 0.5)));
  const direction = new THREE.Vector3(1, 0.72, 1).normalize();

  state.camera.near = Math.max(0.001, distance / 1000);
  state.camera.far = Math.max(1000, distance * 100);
  state.camera.position.copy(center).add(direction.multiplyScalar(distance * 1.85));
  state.camera.updateProjectionMatrix();

  state.controls.target.copy(center);
  state.controls.update();
}

async function exportGlbDownload() {
  try {
    setStatus(`<span class="spinner"></span>Export du GLB baked…`);
    const blob = await exportEditedGlbBlob();
    downloadBlob(blob, editedFileName("glb"));
    setStatus(`GLB modifié exporté : <strong>${escapeHtml(editedFileName("glb"))}</strong> (${formatBytes(blob.size)}).`, "ok");
  } catch (error) {
    console.error(error);
    setStatus(`Erreur d’export GLB : ${escapeHtml(error.message)}`, "error");
  }
}

async function convertEditedGlbToIfc() {
  try {
    const inProjectRoundTrip = Boolean(state.projectId && state.returnToViewer);
    setStatus(inProjectRoundTrip
      ? `<span class="spinner"></span>Export GLB baked, conversion IFC, puis retour viewer…`
      : `<span class="spinner"></span>Export GLB baked puis conversion IFC…`);

    const glbBlob = await exportEditedGlbBlob();

    const formData = new FormData();
    formData.append("glb", glbBlob, editedFileName("glb"));

    const response = await fetch("/api/convert", { method: "POST", body: formData });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Erreur inconnue" }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const stats = JSON.parse(response.headers.get("X-Conversion-Stats") || "{}");
    const ifcBlob = await response.blob();
    let ifcText = await blobToText(ifcBlob);
    let ifcFileName = editedFileName("ifc");
    let editInfo = { applied: 0, errors: 0 };

    if (state.projectId) {
      const reexported = await reexportIfcWithProjectEdits(ifcText, ifcFileName);
      ifcText = reexported.ifcText;
      editInfo = reexported;
    }

    const total = Number(stats.total || 0);
    const storeys = Number(stats.storeys || 0);
    const spaces = Number(stats.spaces || 0);

    if (inProjectRoundTrip) {
      await saveRoundTripAndReturn(glbBlob, ifcText, ifcFileName);
      return;
    }

    downloadBlob(new Blob([ifcText], { type: "application/x-step" }), ifcFileName);
    const editSuffix = editInfo.applied
      ? ` · ${editInfo.applied} reclassification(s) réappliquée(s)${editInfo.errors ? ` · ${editInfo.errors} erreur(s)` : ""}`
      : "";

    setStatus(
      `IFC généré depuis le GLB modifié : <strong>${escapeHtml(ifcFileName)}</strong>\n` +
      `${total} éléments · ${storeys} étage${storeys > 1 ? "s" : ""} · ${spaces} space${spaces > 1 ? "s" : ""}${editSuffix}.`,
      "ok"
    );
  } catch (error) {
    console.error(error);
    setStatus(`Erreur conversion IFC : ${escapeHtml(error.message)}`, "error");
  }
}

async function exportEditedGlbBlob() {
  if (!state.modelRoot) throw new Error("Aucun GLB chargé.");

  const baked = createBakedExportScene(state.modelRoot);
  if (baked.children.length === 0) throw new Error("Aucun mesh exportable dans la scène.");

  const exporter = new GLTFExporter();
  const result = await parseGltf(exporter, baked, {
    binary: true,
    trs: false,
    onlyVisible: false,
    includeCustomExtensions: false,
  });

  disposeObject(baked);

  if (result instanceof ArrayBuffer) {
    return new Blob([result], { type: "model/gltf-binary" });
  }

  if (result && result.buffer instanceof ArrayBuffer) {
    return new Blob([result.buffer], { type: "model/gltf-binary" });
  }

  if (typeof result === "string") {
    return new Blob([result], { type: "model/gltf+json" });
  }

  return new Blob([JSON.stringify(result)], { type: "model/gltf+json" });
}

function createBakedExportScene(root) {
  root.updateMatrixWorld(true);

  const exportScene = new THREE.Scene();
  exportScene.name = `${root.name || "edited"}_baked`;

  root.traverse((object) => {
    if (object.isInstancedMesh) {
      bakeInstancedMesh(object, exportScene);
      return;
    }

    if (!object.isMesh || !object.geometry) return;

    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    if (geometry.getAttribute("normal")) geometry.normalizeNormals();

    const material = cloneMaterial(object.material);
    const bakedMesh = new THREE.Mesh(geometry, material);
    bakedMesh.name = object.name || `Mesh_${object.userData.__modelerId || exportScene.children.length + 1}`;
    bakedMesh.userData = copyExportUserData(object.userData);
    bakedMesh.frustumCulled = false;
    exportScene.add(bakedMesh);
  });

  return exportScene;
}

function bakeInstancedMesh(object, exportScene) {
  const instanceMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();

  for (let i = 0; i < object.count; i++) {
    object.getMatrixAt(i, instanceMatrix);
    worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);

    const geometry = object.geometry.clone();
    geometry.applyMatrix4(worldMatrix);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    if (geometry.getAttribute("normal")) geometry.normalizeNormals();

    const mesh = new THREE.Mesh(geometry, cloneMaterial(object.material));
    mesh.name = `${object.name || "InstancedMesh"}_${i + 1}`;
    mesh.userData = copyExportUserData(object.userData);
    exportScene.add(mesh);
  }
}

function cloneMaterial(material) {
  if (Array.isArray(material)) return material.map((item) => item?.clone?.() || item);
  return material?.clone?.() || material || selectionMaterial.clone();
}

function copyExportUserData(userData = {}) {
  const out = {};
  for (const [key, value] of Object.entries(userData)) {
    if (key.startsWith("__")) continue;
    if (typeof value === "function") continue;
    try {
      out[key] = JSON.parse(JSON.stringify(value));
    } catch {
      out[key] = String(value);
    }
  }
  return out;
}

function parseGltf(exporter, inputObject, options) {
  if (typeof exporter.parseAsync === "function") {
    return exporter.parseAsync(inputObject, options);
  }

  return new Promise((resolve, reject) => {
    exporter.parse(inputObject, resolve, reject, options);
  });
}

function editedFileName(extension) {
  const base = (state.currentFileName || "model.glb")
    .replace(/\.(glb|gltf)$/i, "")
    .replace(/[^a-z0-9_.-]+/gi, "_")
    .replace(/^_+|_+$/g, "") || "model";
  return `${base}.edited.${extension}`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
