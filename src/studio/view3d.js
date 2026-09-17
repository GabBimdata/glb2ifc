// Smelt Studio — vue 3D de contrôle (lecture seule) et export GLB.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildElements } from './build.js';
import { COLORS } from './catalog.js';

const IFC_HINT = { wall: 'IfcWall', slab: 'IfcSlab', roof: 'IfcRoof', gable: 'IfcWall', door: 'IfcDoor', window: 'IfcWindow' };

const materialCache = new Map();
function material(key, opts = {}) {
  const id = `${key}-${opts.opacity ?? 1}-${opts.highlight ? 1 : 0}`;
  if (materialCache.has(id)) return materialCache.get(id);
  const m = new THREE.MeshStandardMaterial({
    color: opts.highlight ? '#f08a4b' : (COLORS[key] || '#cccccc'),
    roughness: key === 'window' ? 0.1 : 0.85,
    metalness: 0,
    transparent: (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  m.name = key;
  materialCache.set(id, m);
  return m;
}

// plan (x, y vers le bas, z haut) → three (x, y haut, z)
function toGeometry(mesh) {
  const pos = new Float32Array(mesh.triangles.length * 9);
  let k = 0;
  for (const tri of mesh.triangles) {
    // l'échange d'axes inverse l'orientation : on inverse l'ordre
    for (const idx of [tri[0], tri[2], tri[1]]) {
      const p = mesh.positions[idx];
      pos[k++] = p[0]; pos[k++] = p[2]; pos[k++] = p[1];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function buildObject3D(project, options = {}) {
  const root = new THREE.Group();
  root.name = project.name || 'Smelt';
  const { elements, warnings } = buildElements(project, options);
  const edgeMat = new THREE.LineBasicMaterial({ color: '#3a4449', transparent: true, opacity: 0.35 });
  for (const el of elements) {
    const parts = [];
    if (el.kind === 'space') continue;
    const highlight = options.selectedKey && el.key === options.selectedKey;
    if (el.mesh) parts.push({ mesh: el.mesh, key: el.kind === 'wall' ? (el.wallType.category || 'interior') : el.kind });
    if (el.frame) parts.push({ mesh: el.frame, key: 'frame' });
    if (el.panel) parts.push({ mesh: el.panel, key: el.kind, opacity: el.kind === 'window' ? 0.45 : 1 });
    const group = new THREE.Group();
    group.name = el.name;
    group.userData = { ifcType: IFC_HINT[el.kind] || 'IfcBuildingElementProxy', smeltKey: el.key, level: el.level?.name };
    for (const part of parts) {
      if (!part.mesh.triangles.length) continue;
      const geom = toGeometry(part.mesh);
      const m = new THREE.Mesh(geom, material(part.key, { opacity: part.opacity, highlight }));
      m.name = el.name;
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
      if (options.edges !== false && part.key !== 'window') {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), edgeMat);
        edges.userData.helper = true;
        group.add(edges);
      }
    }
    root.add(group);
  }
  return { root, warnings };
}

export class View3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#e6e9eb');
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    this.camera.position.set(18, 16, 22);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.requestRender());

    const hemi = new THREE.HemisphereLight('#ffffff', '#b9b2a6', 1.6);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff4e6', 2.2);
    sun.position.set(20, 30, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -30; sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
    sun.shadow.bias = -0.0005;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.12 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.21;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(200, 200, '#c7cdd1', '#d7dcdf');
    grid.position.y = -0.205;
    this.scene.add(grid);

    this.model = null;
    this.hasFramed = false;
    this.pending = false;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.controls.update() || this.pending) {
        this.pending = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  requestRender() { this.pending = true; }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  update(project, options) {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    const { root, warnings } = buildObject3D(project, options);
    this.model = root;
    this.scene.add(root);
    const box = new THREE.Box3().setFromObject(root);
    if (!box.isEmpty()) {
      const c = box.getCenter(new THREE.Vector3());
      this.sun.target.position.copy(c);
      this.sun.position.set(c.x + 20, c.y + 30, c.z + 12);
      if (!this.hasFramed) { this.frame(); this.hasFramed = true; }
    }
    this.requestRender();
    return warnings;
  }

  frame() {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const fov = (this.camera.fov * Math.PI) / 180;
    const fitH = radius / Math.sin(fov / 2);
    const fitW = radius / Math.sin(Math.atan(Math.tan(fov / 2) * Math.max(0.2, this.camera.aspect)));
    const distance = Math.max(fitH, fitW) * 1.05 + 1;
    const dir = new THREE.Vector3(0.9, 0.75, 1.1).normalize();
    this.camera.position.copy(c).add(dir.multiplyScalar(distance));
    this.controls.target.copy(c);
    this.controls.update();
    this.requestRender();
  }
}

export function exportGlb(project) {
  const { root } = buildObject3D(project, { edges: false });
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(root, (result) => resolve(new Blob([result], { type: 'model/gltf-binary' })), reject, { binary: true });
  });
}
