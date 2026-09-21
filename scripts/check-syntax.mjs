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
// Les équipements sont générés par le code (equipment-models.js) : l'export IFC
// ne doit dépendre d'aucun fichier chargé dans le navigateur.
if (!ifc.includes("from './equipment-models.js'")) {
  equipmentIfcFailures.push('ifc-export.js doit générer la géométrie des équipements via equipment-models.js.');
}
if (!ifc.includes('IFCTRIANGULATEDFACESET')) {
  equipmentIfcFailures.push('ifc-export.js doit utiliser IFCTRIANGULATEDFACESET pour les équipements.');
}
if (!ifc.includes("shape(geometryItems, 'Tessellation')")) {
  equipmentIfcFailures.push("Les équipements doivent utiliser une représentation IFC 'Tessellation'.");
}
if (!ifc.includes("'Smelt_Equipment'")) {
  equipmentIfcFailures.push("ifc-export.js doit conserver le Pset 'Smelt_Equipment'.");
}
if (!ifc.includes("from './equipment-catalog.js'")) {
  equipmentIfcFailures.push("ifc-export.js doit utiliser le catalogue équipements partagé.");
}
if (/IFCSURFACESTYLESHADING\(\$\{col\}\)/.test(ifc)) {
  equipmentIfcFailures.push('IfcSurfaceStyleShading demande deux attributs en IFC4 (couleur, transparence).');
}
// Les équipements sont natifs : construits par build.js, édités par l'éditeur, étape déclarée dans main.js.
const studioBuild = await readFile('src/studio/build.js', 'utf8');
const studioEditor = await readFile('src/studio/editor2d.js', 'utf8');
const studioMain = await readFile('src/studio/main.js', 'utf8');
const studioHtml = await readFile('public/studio.html', 'utf8');
if (!studioBuild.includes("from './equipment-models.js'")) {
  equipmentIfcFailures.push('build.js doit construire les équipements (equipment-models.js).');
}
if (!studioEditor.includes('equipmentClick')) {
  equipmentIfcFailures.push("L'éditeur doit porter l'outil de pose des équipements.");
}
if (!studioMain.includes("id: 'equipment'")) {
  equipmentIfcFailures.push("L'étape « Équiper les pièces » doit être déclarée dans le parcours (main.js).");
}
if (studioHtml.includes('equipment-plugin.js')) {
  equipmentIfcFailures.push("studio.html ne doit plus charger equipment-plugin.js (remplacé par l'intégration native).");
}

if (equipmentIfcFailures.length) {
  failed += equipmentIfcFailures.length;
  console.error('\\nEquipment IFC regression:');
  for (const message of equipmentIfcFailures) console.error(`- ${message}`);
} else {
  console.log('Equipment generated-geometry guard: OK.');
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
