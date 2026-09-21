import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/studio/model.js';
import { exportIfc } from '../src/studio/ifc-export.js';

test('generated equipment is exported as triangulated geometry with the right IFC class', () => {
  const project = M.newProject('Equipment IFC test');
  project.levels[0].equipment = [
    { id: 'eq-wc', type: 'wc', x: 1, y: 1, rotation: 90, width: 0.36, depth: 0.66, height: 0.78, zOffset: 0, roomId: null },
    { id: 'eq-fridge', type: 'fridge', x: 3, y: 1, rotation: 0, width: 0.6, depth: 0.65, height: 1.85, zOffset: 0, roomId: null },
    { id: 'eq-bed', type: 'bedDouble', x: 5, y: 3, rotation: 0, width: 1.6, depth: 2, height: 0.5, zOffset: 0, roomId: null },
  ];
  delete globalThis.smelt; // aucun fichier chargé : l'export ne doit plus en dépendre

  const ifc = exportIfc(project);
  assert.match(ifc, /IFCSANITARYTERMINAL\([^\n]*\.TOILETPAN\./);
  assert.match(ifc, /IFCELECTRICAPPLIANCE\([^\n]*\.REFRIGERATOR\./);
  assert.match(ifc, /IFCFURNITURE\([^\n]*\.BED\./);
  assert.match(ifc, /IFCTRIANGULATEDFACESET\(/);
  assert.match(ifc, /'Smelt_Equipment'/);
});
