import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));

async function walk(dir) {
  const items = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(items.map(item => item.isDirectory() ? walk(`${dir}/${item.name}`) : [`${dir}/${item.name}`]));
  return files.flat();
}

const files = ['server.js', ...(await Promise.all(['src','public','scripts','tests'].map(walk))).flat()];
let checked = 0, failed = 0;

for (const file of files) {
  if (/\.(js|mjs)$/.test(file)) {
    const result = spawnSync('node', ['--check', file], { encoding: 'utf8' });
    checked++;
    if (result.error || result.status !== 0) {
      failed++;
      console.error(result.error || result.stderr);
    }
  } else if (file.endsWith('.html')) {
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/\bsrc\s*=/.test(match[1]) || /type\s*=\s*["'](?:importmap|application\/)/.test(match[1])) continue;
      const type = /type\s*=\s*["']module/.test(match[1]) ? 'module' : 'commonjs';
      const result = spawnSync('node', ['--check', `--input-type=${type}`], { input: match[2], encoding: 'utf8' });
      checked++;
      if (result.error || result.status !== 0) {
        failed++;
        console.error(file, result.error || result.stderr);
      }
    }
  }
}

// Garde-fou vitrage : cette partie doit casser le check si une future évolution
// rend à nouveau les fenêtres opaques dans la vue 3D, le GLB ou l'IFC.
const catalog = await import(new URL('../src/studio/catalog.js', import.meta.url));
const view3d = await readFile('src/studio/view3d.js', 'utf8');
const ifc = await readFile('src/studio/ifc-export.js', 'utf8');

const glassFailures = [];
if (Math.abs(catalog.GLASS_OPACITY - 0.45) > 1e-9) {
  glassFailures.push(`GLASS_OPACITY doit rester à 0.45, valeur actuelle : ${catalog.GLASS_OPACITY}`);
}
if (Math.abs(catalog.IFC_GLASS_TRANSPARENCY - 0.55) > 1e-9) {
  glassFailures.push(`IFC_GLASS_TRANSPARENCY doit rester à 0.55, valeur actuelle : ${catalog.IFC_GLASS_TRANSPARENCY}`);
}
if (!view3d.includes("opacity: panelKey === 'window' ? GLASS_OPACITY : 1")) {
  glassFailures.push('view3d.js doit utiliser GLASS_OPACITY pour tous les panneaux vitrés.');
}
if (!view3d.includes("depthWrite: key === 'window' ? false : true")) {
  glassFailures.push('view3d.js doit désactiver depthWrite sur le vitrage transparent.');
}
if (!ifc.includes('IFCSURFACESTYLERENDERING')) {
  glassFailures.push('ifc-export.js doit utiliser IFCSURFACESTYLERENDERING pour le vitrage.');
}
if (!ifc.includes('.GLASS.')) {
  glassFailures.push("ifc-export.js doit conserver le type de réflectance IFC .GLASS.");
}
if (!ifc.includes("el.kind === 'window' ? IFC_GLASS_TRANSPARENCY : 0")) {
  glassFailures.push('Les fenêtres IFC doivent utiliser IFC_GLASS_TRANSPARENCY.');
}
if ((ifc.match(/'window', el\.body, IFC_GLASS_TRANSPARENCY/g) || []).length < 2) {
  glassFailures.push('Les fenêtres de toit et lucarnes doivent utiliser IFC_GLASS_TRANSPARENCY.');
}


const equipmentIfcFailures = [];
if (!ifc.includes("equipmentAssetFaceSets")) {
  equipmentIfcFailures.push('ifc-export.js doit convertir les meshes GLB en géométrie IFC.');
}
if (!ifc.includes('IFCTRIANGULATEDFACESET')) {
  equipmentIfcFailures.push('ifc-export.js doit utiliser IFCTRIANGULATEDFACESET pour les équipements GLB.');
}
if (!ifc.includes("shape(geometryItems, asset ? 'Tessellation' : 'SweptSolid')")) {
  equipmentIfcFailures.push("Les équipements GLB doivent utiliser une représentation IFC 'Tessellation'.");
}
if (!ifc.includes("spec.exactAsset")) {
  equipmentIfcFailures.push('Un équipement doté d’un GLB ne doit jamais retomber silencieusement sur un cube.');
}
if (!ifc.includes("'Smelt_Equipment'")) {
  equipmentIfcFailures.push("ifc-export.js doit conserver le Pset 'Smelt_Equipment'.");
}
if (!ifc.includes("from './equipment-catalog.js'")) {
  equipmentIfcFailures.push("ifc-export.js doit utiliser le catalogue équipements partagé.");
}
const equipmentPlugin = await readFile('src/studio/equipment-plugin.js', 'utf8');
const equipmentCatalog = await readFile('src/studio/equipment-catalog.js', 'utf8');
if (!equipmentPlugin.includes("from './equipment-catalog.js'")) {
  equipmentIfcFailures.push("equipment-plugin.js doit utiliser le catalogue équipements partagé.");
}
for (const asset of [
  'wc.glb',
  'lavabo.glb',
  'douche.glb',
  'evier.glb',
  'baignoire.glb',
  'meuble_bas_60.glb',
  'meuble_haut_60.glb',
  'frigo_60.glb',
  'plaque_60.glb',
  'plan_travail_120.glb',
]) {
  if (!equipmentCatalog.includes(`/assets/equipment/${asset}`)) {
    equipmentIfcFailures.push(`Asset non câblé dans equipment-catalog.js : ${asset}`);
  }
}

if (equipmentIfcFailures.length) {
  failed += equipmentIfcFailures.length;
  console.error('\\nEquipment IFC regression:');
  for (const message of equipmentIfcFailures) console.error(`- ${message}`);
} else {
  console.log('Equipment IFC exact-geometry guard: OK.');
}

if (glassFailures.length) {
  failed += glassFailures.length;
  console.error('\nGlass opacity regression:');
  for (const message of glassFailures) console.error(`- ${message}`);
} else {
  console.log('Glass opacity regression guard: OK.');
}

console.log(`${checked} scripts checked, ${failed} errors.`);
process.exitCode = failed ? 1 : 0;
