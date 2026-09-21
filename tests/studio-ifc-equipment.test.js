import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as M from '../src/studio/model.js';
import { exportIfc } from '../src/studio/ifc-export.js';

function assetFromGeometry(geometry) {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return { scene, box, size, center };
}

test('studio IFC uses exact triangulated geometry for GLB-backed equipment', () => {
  const project = M.newProject('Equipment IFC tessellation test');
  const level = project.levels[0];

  level.equipment = [
    { id: 'eq-wc', type: 'wc', x: 1, y: 1, rotation: 90, width: 0.356, depth: 0.666, height: 0.778, zOffset: 0, roomId: null },
  ];

  const geometry = new THREE.SphereGeometry(0.5, 8, 6);
  const asset = assetFromGeometry(geometry);

  globalThis.smelt = {
    equipment: {
      assets: new Map([['wc', asset]]),
    },
  };

  try {
    const ifc = exportIfc(project);

    assert.match(ifc, /IFCSANITARYTERMINAL\(/);
    assert.match(ifc, /\.TOILETPAN\./);
    assert.match(ifc, /IFCTRIANGULATEDFACESET\(/);
    assert.match(ifc, /IFCSHAPEREPRESENTATION\([^\n]*'Tessellation'/);
    assert.match(ifc, /'Smelt_Equipment'/);

    // The exact GLB-backed WC must not use the old rectangular prism geometry.
    const equipmentStart = ifc.indexOf("'WC'");
    assert.ok(equipmentStart > 0);
    const beforeEquipment = ifc.slice(0, equipmentStart);
    const afterEquipment = ifc.slice(equipmentStart);
    assert.doesNotMatch(afterEquipment, /IFCRECTANGLEPROFILEDEF/);
  } finally {
    delete globalThis.smelt;
  }
});

test('GLB-backed equipment fails loudly instead of silently exporting a cube', () => {
  const project = M.newProject('Missing asset test');
  project.levels[0].equipment = [
    { id: 'eq-wc', type: 'wc', x: 0, y: 0, rotation: 0, width: 0.356, depth: 0.666, height: 0.778, zOffset: 0, roomId: null },
  ];

  delete globalThis.smelt;
  assert.throws(
    () => exportIfc(project),
    /GLB.*WC.*n'est pas chargé/,
  );
});
