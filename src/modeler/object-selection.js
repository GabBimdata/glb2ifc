import * as THREE from 'three';

// Selection owns its overlays, never the selected objects or their resources.
export class ObjectSelection {
  constructor() {
    this.objects = new Set();
    this.helpers = new Map();
  }

  select(mesh, additive = false) {
    if (!additive) this.objects.clear();
    if (mesh) {
      if (additive && this.objects.has(mesh)) this.objects.delete(mesh);
      else this.objects.add(mesh);
    }
    return [...this.objects].at(-1) || null;
  }

  sync(scene, meshes) {
    const available = new Set(meshes);
    for (const mesh of this.objects) {
      if (!available.has(mesh)) this.objects.delete(mesh);
    }
    for (const [mesh, helper] of this.helpers) {
      if (this.objects.size < 2 || !this.objects.has(mesh)) {
        helper.removeFromParent();
        helper.geometry.dispose();
        helper.material.dispose();
        this.helpers.delete(mesh);
      }
    }
    if (this.objects.size < 2) return;
    for (const mesh of this.objects) {
      if (!this.helpers.has(mesh)) {
        const helper = new THREE.BoxHelper(mesh, 0xff9248);
        helper.userData.__modelerOverlay = true;
        scene.add(helper);
        this.helpers.set(mesh, helper);
      }
      this.helpers.get(mesh).update();
    }
  }
}
