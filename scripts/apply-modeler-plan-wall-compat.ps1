$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir '..')
$ModelerPath = Join-Path $RepoRoot 'src\modeler.js'
$Marker = '/* smelt-imported-wall-compat:v6 */'

if (-not (Test-Path $ModelerPath)) {
  Write-Error "Impossible de trouver $ModelerPath. Lance ce script depuis la racine du repo, ou vérifie que src\modeler.js existe."
  exit 1
}

$src = Get-Content -Raw -Encoding UTF8 $ModelerPath
if ($src.Contains($Marker)) {
  Write-Host 'Patch déjà présent dans src/modeler.js'
  exit 0
}

$compat = @'

/* smelt-imported-wall-compat:v6 */
// Compatibilité imported walls : quand on passe par IFC -> GLB -> Modeler,
// les murs sont des meshes classiques. Les outils Door/Window attendent souvent
// des murs créés par l'outil auteur. Ce bloc promeut les meshes muraux importés
// en hôtes d'ouvertures runtime, sans changer leur géométrie ni l'export.
function smeltImportedWallCompatText(mesh) {
  const d = mesh?.userData || {};
  const materialName = mesh?.material?.name || '';
  return [
    mesh?.name, d.name, d.type, d.kind, d.category, d.elementType,
    d.authoringType, d.authoringKind, d.modelerType, d.modelerKind,
    d.smeltIfcType, d.ifcType, d.IFCType, d.ifcClass, d.className,
    d.typeName, d.objectType, materialName
  ].map((v) => String(v || '')).join(' ');
}

function smeltImportedWallCompatLooksLikeWall(mesh) {
  if (!mesh?.isMesh || mesh.userData?.__modelerOverlay) return false;
  const d = mesh.userData || {};
  const text = smeltImportedWallCompatText(mesh);
  const upper = text.toUpperCase();
  if (
    d.smeltDetectedFromPlan ||
    d.smeltSource === 'plan_detector' ||
    d.isWall || d.isAuthoringWall || d.canHostOpenings || d.openingHost ||
    upper.includes('IFCWALL') || upper.includes('IFCWALLSTANDARDCASE') ||
    /(^|[\s_#:\/.-])(wall|walls|mur|murs|cloison|cloisons|partition|partitions)([\s_#:\/.-]|$)/i.test(text)
  ) {
    return true;
  }

  // Fallback géométrique conservateur : objet vertical, long et mince.
  try {
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const height = size.y;
    const planMax = Math.max(size.x, size.z);
    const planMin = Math.min(size.x, size.z);
    return height >= 1.2 && planMax >= 0.45 && planMin > 0.025 && planMin <= 0.70 && (planMax / Math.max(planMin, 0.001)) >= 2.4;
  } catch {
    return false;
  }
}

function smeltImportedWallCompatInferWallData(mesh) {
  const d = mesh.userData || {};
  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const lengthAlongX = size.x >= size.z;
  const halfLen = Math.max(lengthAlongX ? size.x : size.z, 0.001) / 2;
  const inferredThickness = Math.max(Math.min(lengthAlongX ? size.z : size.x, lengthAlongX ? size.x : size.z), 0.03);
  const height = Math.max(size.y, Number(d.wallHeight || d.height || state?.authoring?.wallHeight || 3) || 3);

  const start = lengthAlongX
    ? { x: center.x - halfLen, y: box.min.y, z: center.z }
    : { x: center.x, y: box.min.y, z: center.z - halfLen };
  const end = lengthAlongX
    ? { x: center.x + halfLen, y: box.min.y, z: center.z }
    : { x: center.x, y: box.min.y, z: center.z + halfLen };

  const srcLine = d.centerline || d.baseline || d.wallLine || d.authoring?.centerline || d.authoring?.baseline || null;
  const hasXzLine = srcLine && Number.isFinite(Number(srcLine.x1)) && Number.isFinite(Number(srcLine.z1)) && Number.isFinite(Number(srcLine.x2)) && Number.isFinite(Number(srcLine.z2));
  const line = hasXzLine
    ? {
        x1: Number(srcLine.x1), y1: Number(srcLine.y1 ?? box.min.y), z1: Number(srcLine.z1),
        x2: Number(srcLine.x2), y2: Number(srcLine.y2 ?? box.min.y), z2: Number(srcLine.z2),
      }
    : { x1: start.x, y1: start.y, z1: start.z, x2: end.x, y2: end.y, z2: end.z };

  const thickness = Number(d.wallThickness || d.thickness || d.authoring?.wallThickness || d.authoring?.thickness || inferredThickness) || inferredThickness;
  const length = Math.hypot(line.x2 - line.x1, line.z2 - line.z1);

  return {
    type: 'wall',
    kind: 'wall',
    elementType: 'wall',
    category: 'wall',
    modelerType: 'wall',
    modelerKind: 'wall',
    authoringType: 'wall',
    authoringKind: 'wall',
    authoringElementType: 'wall',
    smeltAuthoringType: 'wall',
    smeltObjectType: 'wall',
    smeltIfcType: d.smeltIfcType || d.ifcType || d.IFCType || 'IFCWALL',
    ifcType: d.ifcType || d.smeltIfcType || d.IFCType || 'IFCWALL',
    IFCType: d.IFCType || d.ifcType || d.smeltIfcType || 'IFCWALL',
    isWall: true,
    isAuthoring: true,
    isAuthoringWall: true,
    authoringElement: true,
    isAuthoringElement: true,
    authoringWall: true,
    openingHost: true,
    hostOpenings: true,
    canHostOpenings: true,
    smeltOpeningHost: true,
    wallHeight: height,
    height,
    wallThickness: thickness,
    thickness,
    wallLength: length,
    length,
    baseline: line,
    centerline: line,
    wallLine: line,
    start: { x: line.x1, y: line.y1, z: line.z1 },
    end: { x: line.x2, y: line.y2, z: line.z2 },
    storeyId: d.storeyId || state?.authoring?.activeStoreyId || 'storey-0',
    storeyElevation: Number(d.storeyElevation ?? box.min.y ?? 0) || 0,
  };
}

function smeltImportedWallCompatPromote(options = {}) {
  if (!state?.meshes?.length) return 0;
  let count = 0;
  for (const mesh of state.meshes) {
    if (!smeltImportedWallCompatLooksLikeWall(mesh)) continue;
    const authoring = smeltImportedWallCompatInferWallData(mesh);
    mesh.userData = {
      ...mesh.userData,
      ...authoring,
      authoring,
      smeltAuthoring: authoring,
      wall: authoring,
      smeltImportedWallPromoted: true,
    };
    count += 1;
  }
  if (count && !options.silent) {
    setStatus?.(String(count) + ' murs importés activés comme hôtes Door/Window.', 'ok');
  }
  renderTree?.();
  renderProperties?.();
  updateUiEnabled?.();
  return count;
}

try {
  const originalLoadFile = loadFile;
  loadFile = async function smeltImportedWallCompatLoadFile(...args) {
    const result = await originalLoadFile.apply(this, args);
    setTimeout(() => smeltImportedWallCompatPromote({ silent: false }), 80);
    setTimeout(() => smeltImportedWallCompatPromote({ silent: true }), 800);
    return result;
  };
} catch (error) {
  console.warn('[smelt-imported-wall-compat] impossible de wrapper loadFile', error);
}

try {
  const originalSetAuthoringTool = setAuthoringTool;
  setAuthoringTool = function smeltImportedWallCompatSetAuthoringTool(tool, ...rest) {
    if (tool === 'door' || tool === 'window' || tool === 'wall' || tool === 'partition') {
      smeltImportedWallCompatPromote({ silent: true });
    }
    return originalSetAuthoringTool.call(this, tool, ...rest);
  };
} catch (error) {
  console.warn('[smelt-imported-wall-compat] impossible de wrapper setAuthoringTool', error);
}

window.smeltImportedWallCompatPromote = smeltImportedWallCompatPromote;
setTimeout(() => smeltImportedWallCompatPromote({ silent: true }), 250);
'@

Set-Content -Path $ModelerPath -Value ($src + $compat) -Encoding UTF8
Write-Host 'Patch ajouté à src/modeler.js'
Write-Host 'Relance ensuite le serveur puis recharge modeler.html sans cache (Ctrl+Shift+R).'
Write-Host 'Dans la console navigateur, window.smeltImportedWallCompatPromote() permet de relancer la promotion manuellement.'
