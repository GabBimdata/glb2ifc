import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const modelerPath = path.join(repoRoot, 'src', 'modeler.js');
const marker = '/* smelt-plan-wall-compat:v5 */';

if (!fs.existsSync(modelerPath)) {
  console.error('Impossible de trouver ' + modelerPath);
  process.exit(1);
}

let src = fs.readFileSync(modelerPath, 'utf8');
if (src.includes(marker)) {
  console.log('Patch déjà présent dans src/modeler.js');
  process.exit(0);
}

const compat = String.raw`

/* smelt-plan-wall-compat:v5 */
// Compatibilité plan_detector v5 : les murs importés depuis /plan2glb sont des
// meshes GLB existants. Les outils Door/Window du modeler attendent souvent des
// murs créés dans la session courante. Ce bloc promeut ces meshes importés en
// hôtes d'ouvertures runtime sans modifier leur géométrie.
function smeltPlanWallCompatLooksLikeWall(mesh) {
  if (!mesh?.isMesh || mesh.userData?.__modelerOverlay) return false;
  const d = mesh.userData || {};
  const text = String(mesh.name || '') + ' ' + String(d.name || '') + ' ' + String(d.type || '') + ' ' + String(d.kind || '') + ' ' + String(d.authoringType || '') + ' ' + String(d.smeltIfcType || '') + ' ' + String(d.ifcType || '');
  return Boolean(
    d.smeltDetectedFromPlan ||
    d.smeltSource === 'plan_detector' ||
    d.isWall || d.isAuthoringWall || d.canHostOpenings ||
    d.smeltIfcType === 'IFCWALL' || d.ifcType === 'IFCWALL' ||
    /(^|[\s_#-])(wall|walls|mur|murs|cloison|cloisons)([\s_#-]|$)/i.test(text)
  );
}

function smeltPlanWallCompatInferWallData(mesh) {
  const d = mesh.userData || {};
  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const lengthAlongX = size.x >= size.z;
  const halfLen = Math.max(lengthAlongX ? size.x : size.z, 0.001) / 2;
  const thickness = Math.max(Math.min(lengthAlongX ? size.z : size.x, lengthAlongX ? size.x : size.z), 0.03);
  const height = Math.max(size.y, Number(d.wallHeight || d.height || state?.authoring?.wallHeight || 3) || 3);

  const start = lengthAlongX
    ? { x: center.x - halfLen, y: box.min.y, z: center.z }
    : { x: center.x, y: box.min.y, z: center.z - halfLen };
  const end = lengthAlongX
    ? { x: center.x + halfLen, y: box.min.y, z: center.z }
    : { x: center.x, y: box.min.y, z: center.z + halfLen };

  const srcLine = d.centerline || d.baseline || d.wallLine || null;
  const hasXzLine = srcLine && Number.isFinite(Number(srcLine.x1)) && Number.isFinite(Number(srcLine.z1)) && Number.isFinite(Number(srcLine.x2)) && Number.isFinite(Number(srcLine.z2));
  const line = hasXzLine
    ? {
        x1: Number(srcLine.x1), y1: Number(srcLine.y1 ?? box.min.y), z1: Number(srcLine.z1),
        x2: Number(srcLine.x2), y2: Number(srcLine.y2 ?? box.min.y), z2: Number(srcLine.z2),
      }
    : { x1: start.x, y1: start.y, z1: start.z, x2: end.x, y2: end.y, z2: end.z };

  return {
    type: 'wall',
    kind: 'wall',
    elementType: 'wall',
    category: 'wall',
    isWall: true,
    isAuthoring: true,
    isAuthoringWall: true,
    authoringElement: true,
    isAuthoringElement: true,
    openingHost: true,
    hostOpenings: true,
    canHostOpenings: true,
    wallHeight: height,
    height,
    wallThickness: Number(d.wallThickness || d.thickness || thickness) || thickness,
    thickness: Number(d.wallThickness || d.thickness || thickness) || thickness,
    wallLength: Math.hypot(line.x2 - line.x1, line.z2 - line.z1),
    length: Math.hypot(line.x2 - line.x1, line.z2 - line.z1),
    baseline: line,
    centerline: line,
    wallLine: line,
    start: { x: line.x1, y: line.y1, z: line.z1 },
    end: { x: line.x2, y: line.y2, z: line.z2 },
    storeyId: d.storeyId || state?.authoring?.activeStoreyId || 'storey-0',
    storeyElevation: Number(d.storeyElevation ?? box.min.y ?? 0) || 0,
  };
}

function smeltPlanWallCompatPromoteImportedWalls(options = {}) {
  if (!state?.meshes?.length) return 0;
  let count = 0;
  for (const mesh of state.meshes) {
    if (!smeltPlanWallCompatLooksLikeWall(mesh)) continue;
    const authoring = smeltPlanWallCompatInferWallData(mesh);
    mesh.userData = {
      ...mesh.userData,
      ...authoring,
      smeltSource: mesh.userData?.smeltSource || 'plan_detector',
      smeltDetectedFromPlan: mesh.userData?.smeltDetectedFromPlan ?? true,
      smeltIfcType: mesh.userData?.smeltIfcType || 'IFCWALL',
      ifcType: mesh.userData?.ifcType || 'IFCWALL',
      IFCType: mesh.userData?.IFCType || 'IFCWALL',
      authoringType: 'wall',
      authoringKind: 'wall',
      authoringElementType: 'wall',
      modelerType: 'wall',
      modelerKind: 'wall',
      smeltAuthoringType: 'wall',
      smeltObjectType: 'wall',
      isWall: true,
      isAuthoringWall: true,
      authoringWall: true,
      openingHost: true,
      smeltOpeningHost: true,
      canHostOpenings: true,
      authoring,
      smeltAuthoring: authoring,
      wall: authoring,
    };
    count += 1;
  }
  if (count && !options.silent) {
    setStatus?.(String(count) + ' murs importés promus comme hôtes Door/Window.', 'ok');
  }
  renderTree?.();
  renderProperties?.();
  updateUiEnabled?.();
  return count;
}

try {
  const originalLoadFile = loadFile;
  loadFile = async function smeltPlanWallCompatLoadFile(...args) {
    const result = await originalLoadFile.apply(this, args);
    setTimeout(() => smeltPlanWallCompatPromoteImportedWalls({ silent: false }), 80);
    setTimeout(() => smeltPlanWallCompatPromoteImportedWalls({ silent: true }), 800);
    return result;
  };
} catch (error) {
  console.warn('[smelt-plan-wall-compat] impossible de wrapper loadFile', error);
}

try {
  const originalSetAuthoringTool = setAuthoringTool;
  setAuthoringTool = function smeltPlanWallCompatSetAuthoringTool(tool, ...rest) {
    if (tool === 'door' || tool === 'window' || tool === 'wall' || tool === 'partition') {
      smeltPlanWallCompatPromoteImportedWalls({ silent: true });
    }
    return originalSetAuthoringTool.call(this, tool, ...rest);
  };
} catch (error) {
  console.warn('[smelt-plan-wall-compat] impossible de wrapper setAuthoringTool', error);
}

window.smeltPlanWallCompatPromoteImportedWalls = smeltPlanWallCompatPromoteImportedWalls;
setTimeout(() => smeltPlanWallCompatPromoteImportedWalls({ silent: true }), 250);
`;

src += compat;
fs.writeFileSync(modelerPath, src);
console.log('Patch ajouté à src/modeler.js');
console.log('Relance ensuite le serveur puis recharge modeler.html sans cache (Ctrl/Cmd+Shift+R).');
