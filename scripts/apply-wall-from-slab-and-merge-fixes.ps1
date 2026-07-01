param(
  [string]$RepoRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

function Read-Text($Path) {
  if (-not (Test-Path $Path)) { throw "Fichier introuvable: $Path" }
  return Get-Content -Path $Path -Raw -Encoding UTF8
}

function Write-Text($Path, $Content) {
  Set-Content -Path $Path -Value $Content -Encoding UTF8 -NoNewline
}

$repo = (Resolve-Path $RepoRoot).Path
$modelerHtmlPath = Join-Path $repo "public\modeler.html"
$modelerJsPath = Join-Path $repo "src\modeler.js"

if (-not (Test-Path $modelerHtmlPath)) { throw "public\modeler.html introuvable. Lance ce script depuis la racine du repo glb2ifc." }
if (-not (Test-Path $modelerJsPath)) { throw "src\modeler.js introuvable. Lance ce script depuis la racine du repo glb2ifc." }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $modelerHtmlPath "$modelerHtmlPath.bak-wall-slab-$stamp" -Force
Copy-Item $modelerJsPath "$modelerJsPath.bak-wall-slab-$stamp" -Force

# 1) Ajoute le bouton Merge slabs dans le dock auteur.
$html = Read-Text $modelerHtmlPath
if ($html -notmatch 'id="merge-slabs"') {
  $mergeButton = '<button id="merge-slabs" title="Fusionner les slabs de l’étage actif en un seul objet">Merge slabs</button>'
  $pattern = '(<button\s+id="walls-from-slab"[\s\S]*?</button>)'
  $newHtml = [regex]::Replace($html, $pattern, "`$1`n          $mergeButton", 1)
  if ($newHtml -eq $html) {
    throw "Impossible d’injecter le bouton Merge slabs: bouton walls-from-slab non trouvé."
  }
  Write-Text $modelerHtmlPath $newHtml
  Write-Host "✓ public/modeler.html patché: bouton Merge slabs ajouté."
} else {
  Write-Host "✓ public/modeler.html: bouton Merge slabs déjà présent."
}

# 2) Ajoute le patch JS dans src/modeler.js.
$js = Read-Text $modelerJsPath
$marker = 'SMELT_WALL_SLAB_FIX_V1'
if ($js -match $marker) {
  Write-Host "✓ src/modeler.js: patch déjà présent."
} else {
  $patch = @'

// --- SMELT_WALL_SLAB_FIX_V1 -------------------------------------------------
// Fix 1: les murs issus de "Walls from slab" pouvaient perdre les changements
// longueur/épaisseur/hauteur lors de la pose d'une porte/fenêtre, car wallPath
// restait sur les dimensions d'origine. On resynchronise wallPath depuis la
// géométrie actuelle avant toute opération d'ouverture et après édition.
// Fix 2: bouton "Merge slabs" pour fusionner les slabs de l'étage actif.

function smeltPointLikeToVector3(value) {
  return new THREE.Vector3(
    Number(value?.x || 0),
    Number(value?.y || 0),
    Number(value?.z || 0),
  );
}

function smeltIsWallLikeMesh(mesh) {
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
    /\b(wall|walls|mur|murs|cloison|cloisons|partition|ifcwall|ifcwallstandardcase)\b/i.test(haystack)
  );
}

function smeltIsSlabLikeMesh(mesh) {
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
    /\b(slab|slabs|dalle|dalles|plancher|ifcslab)\b/i.test(haystack) ||
    /^slab[_\s-]?\d*/i.test(String(mesh.name || ''))
  );
}

function smeltStoreyIdOfMesh(mesh) {
  return String(mesh?.userData?.storeyId || mesh?.userData?.wallPath?.storeyId || 'storey-0');
}

function smeltActiveStoreyId() {
  return String(state?.authoring?.activeStoreyId || 'storey-0');
}

function smeltGeometryWorldPoints(mesh) {
  const attr = mesh?.geometry?.attributes?.position;
  if (!attr) return [];
  mesh.updateWorldMatrix(true, false);
  const points = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < attr.count; i += 1) {
    p.fromBufferAttribute(attr, i).applyMatrix4(mesh.matrixWorld);
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      points.push(p.clone());
    }
  }
  return points;
}

function smeltDominantWallAxis(points, fallbackPath) {
  if (fallbackPath?.start && fallbackPath?.end) {
    const s = smeltPointLikeToVector3(fallbackPath.start);
    const e = smeltPointLikeToVector3(fallbackPath.end);
    const d = new THREE.Vector3(e.x - s.x, 0, e.z - s.z);
    if (d.lengthSq() > 1e-8) return d.normalize();
  }

  if (!points.length) return new THREE.Vector3(1, 0, 0);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }

  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  return spanX >= spanZ ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
}

function smeltSyncWallPathFromGeometry(mesh) {
  if (!smeltIsWallLikeMesh(mesh)) return false;
  const points = smeltGeometryWorldPoints(mesh);
  if (points.length < 2) return false;

  const u = mesh.userData || (mesh.userData = {});
  const previousPath = u.wallPath || {};
  const axis = smeltDominantWallAxis(points, previousPath);
  const perp = new THREE.Vector3(-axis.z, 0, axis.x).normalize();

  let minA = Infinity, maxA = -Infinity;
  let minP = Infinity, maxP = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const p of points) {
    const a = p.x * axis.x + p.z * axis.z;
    const q = p.x * perp.x + p.z * perp.z;
    minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    minP = Math.min(minP, q); maxP = Math.max(maxP, q);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }

  if (![minA, maxA, minP, maxP, minY, maxY].every(Number.isFinite)) return false;

  const centerP = (minP + maxP) / 2;
  const start = {
    x: axis.x * minA + perp.x * centerP,
    y: minY,
    z: axis.z * minA + perp.z * centerP,
  };
  const end = {
    x: axis.x * maxA + perp.x * centerP,
    y: minY,
    z: axis.z * maxA + perp.z * centerP,
  };

  const length = Math.max(0, maxA - minA);
  const thickness = Math.max(0.001, maxP - minP);
  const height = Math.max(0.001, maxY - minY);
  const kind = previousPath.kind || u.authoringKind || u.kind || (String(u.authoringType || '').toLowerCase() === 'partition' ? 'partition' : 'wall');
  const storeyId = previousPath.storeyId || u.storeyId || smeltActiveStoreyId();
  const storey = (state?.authoring?.storeys || []).find((s) => String(s.id) === String(storeyId));

  u.wallPath = {
    ...previousPath,
    start,
    end,
    prev: previousPath.prev ?? null,
    next: previousPath.next ?? null,
    height,
    thickness,
    alignment: previousPath.alignment || u.dimensions?.alignment || 'center',
    kind,
    baseElevation: minY,
    storeyId,
    storeyName: previousPath.storeyName || u.storeyName || storey?.name || 'Storey 0',
    openings: Array.isArray(previousPath.openings) ? previousPath.openings : [],
  };

  u.dimensions = {
    ...(u.dimensions || {}),
    length,
    height,
    thickness,
    alignment: u.wallPath.alignment,
    kind,
  };

  u.wallLength = length;
  u.length = length;
  u.wallHeight = height;
  u.height = height;
  u.wallThickness = thickness;
  u.thickness = thickness;
  u.type = u.type || 'wall';
  u.kind = kind;
  u.category = u.category || 'wall';
  u.elementType = u.elementType || 'wall';
  u.modelerType = u.modelerType || 'wall';
  u.modelerKind = u.modelerKind || kind;
  u.authoringType = u.authoringType || 'wall';
  u.authoringKind = u.authoringKind || kind;
  u.smeltIfcType = u.smeltIfcType || 'IfcWall';
  u.ifcType = u.ifcType || 'IfcWall';
  u.isWall = true;
  u.isAuthoringWall = true;
  u.openingHost = true;
  u.canHostOpenings = true;
  u.hostOpenings = true;

  if (mesh.geometry) {
    mesh.geometry.computeBoundingBox?.();
    mesh.geometry.computeBoundingSphere?.();
  }
  return true;
}

function smeltSyncAllWallPathsFromGeometry() {
  let count = 0;
  for (const mesh of state?.meshes || []) {
    if (smeltSyncWallPathFromGeometry(mesh)) count += 1;
  }
  return count;
}

function smeltSelectedOrActiveStoreySlabs() {
  const activeStoreyId = smeltActiveStoreyId();
  const selected = state?.selected && smeltIsSlabLikeMesh(state.selected) ? state.selected : null;
  const selectedStoreyId = selected ? smeltStoreyIdOfMesh(selected) : activeStoreyId;

  return (state?.meshes || []).filter((mesh) => {
    if (!smeltIsSlabLikeMesh(mesh)) return false;
    return smeltStoreyIdOfMesh(mesh) === selectedStoreyId;
  });
}

function smeltMergedNonIndexedGeometry(meshes, parent) {
  const positions = [];
  const parentInv = new THREE.Matrix4();
  parent?.updateWorldMatrix?.(true, false);
  if (parent?.matrixWorld) parentInv.copy(parent.matrixWorld).invert();
  else parentInv.identity();

  for (const mesh of meshes) {
    if (!mesh?.geometry?.attributes?.position) continue;
    mesh.updateWorldMatrix(true, false);
    const transform = new THREE.Matrix4().multiplyMatrices(parentInv, mesh.matrixWorld);
    const g = mesh.geometry.clone();
    g.applyMatrix4(transform);
    const nonIndexed = g.index ? g.toNonIndexed() : g;
    const attr = nonIndexed.attributes.position;
    for (let i = 0; i < attr.count; i += 1) {
      positions.push(attr.getX(i), attr.getY(i), attr.getZ(i));
    }
    if (nonIndexed !== g) nonIndexed.dispose?.();
    g.dispose?.();
  }

  if (positions.length < 9) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function mergeActiveStoreySlabs() {
  const slabs = smeltSelectedOrActiveStoreySlabs();
  if (slabs.length < 2) {
    setStatus?.('Sélectionne un étage avec au moins 2 slabs à fusionner.', 'warning');
    return;
  }

  const parent = state?.modelRoot || slabs[0].parent || state?.scene;
  const geometry = smeltMergedNonIndexedGeometry(slabs, parent);
  if (!geometry) {
    setStatus?.('Merge slabs impossible: géométries invalides.', 'error');
    return;
  }

  const first = slabs[0];
  const material = first.material?.clone ? first.material.clone() : (typeof authoringSlabMaterial !== 'undefined' ? authoringSlabMaterial.clone() : new THREE.MeshStandardMaterial({ color: 0xb6bcc4 }));
  const storeyId = smeltStoreyIdOfMesh(first);
  const storey = (state?.authoring?.storeys || []).find((s) => String(s.id) === String(storeyId));
  const nextId = state.nextModelerId++;
  const mergedName = `Slab_Merged_${String(state.authoring?.slabCount ? ++state.authoring.slabCount : nextId).padStart(3, '0')}`;

  const merged = new THREE.Mesh(geometry, material);
  merged.name = mergedName;
  merged.userData = {
    authoringType: 'slab',
    authoringKind: 'slab',
    smeltAuthoringType: 'slab',
    type: 'slab',
    kind: 'slab',
    category: 'slab',
    elementType: 'slab',
    modelerType: 'slab',
    modelerKind: 'slab',
    ifcHint: 'IfcSlab',
    smeltIfcType: 'IfcSlab',
    ifcType: 'IfcSlab',
    IFCType: 'IfcSlab',
    smeltPredefinedType: '.FLOOR.',
    storeyId,
    storeyName: storey?.name || first.userData?.storeyName || 'Storey 0',
    storeyElevation: Number(storey?.elevation ?? first.userData?.storeyElevation ?? 0),
    dimensions: {
      ...(first.userData?.dimensions || {}),
      kind: 'slab',
      merged: true,
      mergedCount: slabs.length,
    },
    mergedFrom: slabs.map((s) => s.name || s.uuid),
    __modelerId: nextId,
    modelerId: nextId,
  };

  parent?.add?.(merged);

  const slabSet = new Set(slabs);
  for (const slab of slabs) {
    if (slab.parent) slab.parent.remove(slab);
  }
  state.meshes = (state.meshes || []).filter((mesh) => !slabSet.has(mesh));
  state.meshes.push(merged);

  if (typeof selectMesh === 'function') selectMesh(merged);
  if (typeof renderTree === 'function') renderTree();
  if (typeof renderProperties === 'function') renderProperties();
  if (typeof updateUiEnabled === 'function') updateUiEnabled();
  if (typeof markDirty === 'function') markDirty();
  setStatus?.(`Merge slabs OK: ${slabs.length} slabs fusionnées dans ${merged.name}.`, 'ok');
}

function smeltInstallWallSlabFixes() {
  const mergeButton = document.getElementById('merge-slabs');
  mergeButton?.addEventListener('click', mergeActiveStoreySlabs);

  const syncSoon = () => setTimeout(() => {
    try { smeltSyncAllWallPathsFromGeometry(); } catch (error) { console.warn('[smelt wall sync]', error); }
  }, 0);

  properties?.addEventListener('input', syncSoon, true);
  properties?.addEventListener('change', syncSoon, true);
  state?.transform?.addEventListener?.('objectChange', syncSoon);

  const viewport = state?.renderer?.domElement;
  const syncBeforeOpening = () => {
    const tool = String(state?.authoring?.tool || '').toLowerCase();
    if (tool === 'door' || tool === 'window') {
      smeltSyncAllWallPathsFromGeometry();
    }
  };
  viewport?.addEventListener('pointerdown', syncBeforeOpening, true);
  viewport?.addEventListener('pointerup', syncBeforeOpening, true);
  viewport?.addEventListener('click', syncBeforeOpening, true);

  smeltSyncAllWallPathsFromGeometry();
  console.info('[Smelt] wall/slab fixes installed: wallPath sync + Merge slabs.');
}

smeltInstallWallSlabFixes();
// --- /SMELT_WALL_SLAB_FIX_V1 ------------------------------------------------
'@
  Write-Text $modelerJsPath ($js + $patch)
  Write-Host "✓ src/modeler.js patché: wallPath sync + merge slabs."
}

Write-Host ""
Write-Host "Patch appliqué. Redémarre le serveur puis fais Ctrl+Shift+R dans le navigateur."
