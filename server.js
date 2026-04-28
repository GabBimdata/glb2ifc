import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3737;

// Storage temporaire pour les uploads
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
});

// Créer les dossiers s'ils n'existent pas
['uploads', 'outputs'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

app.use(express.static(path.join(__dirname, 'public')));

/**
 * Échappe une chaîne pour le format STEP-21 (utilisé par IFC).
 * Règles spec STEP-21 (ISO 10303-21) :
 *   - L'apostrophe se double : ' → ''
 *   - Le backslash se double : \ → \\
 *   - Les caractères non-ASCII devraient être encodés en \X2\...\X0\
 *     (on simplifie en les remplaçant par '_' pour éviter tout problème)
 */
function escapeIFCString(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\/g, '\\\\')      // \  → \\
    .replace(/'/g, "''")         // '  → ''
    .replace(/[^\x20-\x7E]/g, '_'); // non-ASCII → _
}

/**
 * Analyse un mesh pour deviner son type IFC selon ses dimensions et son orientation.
 * Retourne 'wall', 'slab', ou 'proxy'.
 */
function classifyMesh(bbox) {
  const [minX, minY, minZ] = bbox.min;
  const [maxX, maxY, maxZ] = bbox.max;
  const sizeX = maxX - minX;
  const sizeY = maxY - minY; // Y vertical en glTF
  const sizeZ = maxZ - minZ;

  const horizontalSpan = Math.max(sizeX, sizeZ);
  const verticalSpan = sizeY;

  // Heuristique :
  // - Slab/Ceiling : très plat verticalement, large horizontalement
  // - Wall : haut, fin sur un axe horizontal, long sur l'autre
  // - Proxy : tout le reste (meubles, etc.)

  // Slab : épaisseur verticale faible vs étendue horizontale
  if (verticalSpan < 0.5 && horizontalSpan > 1.0 && verticalSpan / horizontalSpan < 0.2) {
    return 'slab';
  }

  // Wall : hauteur significative, et un des axes horizontaux est fin
  const minHorizontal = Math.min(sizeX, sizeZ);
  if (verticalSpan > 1.0 && minHorizontal < 0.6 && horizontalSpan / minHorizontal > 2) {
    return 'wall';
  }

  return 'proxy';
}

/**
 * Calcule la bounding box d'un mesh à partir de ses positions.
 */
function computeBoundingBox(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < positions.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const v = positions[i + j];
      if (v < min[j]) min[j] = v;
      if (v > max[j]) max[j] = v;
    }
  }

  return { min, max };
}

/**
 * Extrait toutes les meshes utiles d'un fichier GLB.
 */
async function extractMeshesFromGLB(glbPath) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(glbPath);
  const root = document.getRoot();

  const extractedMeshes = [];

  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;

    // Matrice mondiale du node
    const worldMatrix = node.getWorldMatrix();

    for (const primitive of mesh.listPrimitives()) {
      const positionAttr = primitive.getAttribute('POSITION');
      const indicesAccessor = primitive.getIndices();

      if (!positionAttr) continue;

      const positions = positionAttr.getArray();
      const indices = indicesAccessor ? indicesAccessor.getArray() : null;

      // Appliquer la matrice mondiale aux positions
      const transformedPositions = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        transformedPositions[i]     = worldMatrix[0] * x + worldMatrix[4] * y + worldMatrix[8]  * z + worldMatrix[12];
        transformedPositions[i + 1] = worldMatrix[1] * x + worldMatrix[5] * y + worldMatrix[9]  * z + worldMatrix[13];
        transformedPositions[i + 2] = worldMatrix[2] * x + worldMatrix[6] * y + worldMatrix[10] * z + worldMatrix[14];
      }

      const bbox = computeBoundingBox(transformedPositions);
      const classification = classifyMesh(bbox);

      extractedMeshes.push({
        name: node.getName() || mesh.getName() || 'unnamed',
        positions: transformedPositions,
        indices: indices ? Array.from(indices) : null,
        bbox,
        classification
      });
    }
  }

  return extractedMeshes;
}

/**
 * Génère un fichier IFC textuel (STEP/SPF) à partir des meshes extraits.
 * Approche directe : on écrit le fichier IFC nous-mêmes au format STEP-21.
 * C'est plus simple et robuste que d'utiliser web-ifc en mode write,
 * qui demande beaucoup de boilerplate pour l'écriture.
 */
function generateIFC(meshes, originalFilename) {
  const lines = [];
  let id = 0;
  const nextId = () => `#${++id}`;

  // En-tête STEP
  const now = new Date().toISOString();
  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');`,
    `FILE_NAME('${escapeIFCString(originalFilename)}','${now}',(''),(''),'glb2ifc converter','glb2ifc','');`,
    `FILE_SCHEMA(('IFC4'));`,
    'ENDSEC;',
    'DATA;'
  ];

  // Unités (mètres, radians)
  const lenUnit = nextId();
  lines.push(`${lenUnit}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  const angUnit = nextId();
  lines.push(`${angUnit}=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);`);
  const areaUnit = nextId();
  lines.push(`${areaUnit}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);
  const volUnit = nextId();
  lines.push(`${volUnit}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);
  const unitAssignment = nextId();
  lines.push(`${unitAssignment}=IFCUNITASSIGNMENT((${lenUnit},${angUnit},${areaUnit},${volUnit}));`);

  // Axe placement global (origine)
  const cartesianOrigin = nextId();
  lines.push(`${cartesianOrigin}=IFCCARTESIANPOINT((0.,0.,0.));`);
  const dirZ = nextId();
  lines.push(`${dirZ}=IFCDIRECTION((0.,0.,1.));`);
  const dirX = nextId();
  lines.push(`${dirX}=IFCDIRECTION((1.,0.,0.));`);
  const axis2Placement3D = nextId();
  lines.push(`${axis2Placement3D}=IFCAXIS2PLACEMENT3D(${cartesianOrigin},${dirZ},${dirX});`);

  // Représentation contexte
  const geomContext = nextId();
  lines.push(`${geomContext}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${axis2Placement3D},$);`);

  // Owner history (simplifié)
  const person = nextId();
  lines.push(`${person}=IFCPERSON($,$,'glb2ifc',$,$,$,$,$);`);
  const org = nextId();
  lines.push(`${org}=IFCORGANIZATION($,'glb2ifc',$,$,$);`);
  const personOrg = nextId();
  lines.push(`${personOrg}=IFCPERSONANDORGANIZATION(${person},${org},$);`);
  const application = nextId();
  lines.push(`${application}=IFCAPPLICATION(${org},'1.0','glb2ifc','glb2ifc');`);
  const ownerHistory = nextId();
  const timestamp = Math.floor(Date.now() / 1000);
  lines.push(`${ownerHistory}=IFCOWNERHISTORY(${personOrg},${application},$,.ADDED.,${timestamp},${personOrg},${application},${timestamp});`);

  // Helper pour générer un GUID compact IFC (22 caractères base64-like)
  function ifcGuid() {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    let s = '';
    for (let i = 0; i < 22; i++) {
      s += chars[Math.floor(Math.random() * 64)];
    }
    return s;
  }

  // Project
  const project = nextId();
  lines.push(`${project}=IFCPROJECT('${ifcGuid()}',${ownerHistory},'Project',$,$,$,$,(${geomContext}),${unitAssignment});`);

  // Site
  const sitePlacement = nextId();
  lines.push(`${sitePlacement}=IFCLOCALPLACEMENT($,${axis2Placement3D});`);
  const site = nextId();
  lines.push(`${site}=IFCSITE('${ifcGuid()}',${ownerHistory},'Site',$,$,${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$);`);

  // Building
  const buildingPlacement = nextId();
  lines.push(`${buildingPlacement}=IFCLOCALPLACEMENT(${sitePlacement},${axis2Placement3D});`);
  const building = nextId();
  lines.push(`${building}=IFCBUILDING('${ifcGuid()}',${ownerHistory},'Building',$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$);`);

  // Storey
  const storeyPlacement = nextId();
  lines.push(`${storeyPlacement}=IFCLOCALPLACEMENT(${buildingPlacement},${axis2Placement3D});`);
  const storey = nextId();
  lines.push(`${storey}=IFCBUILDINGSTOREY('${ifcGuid()}',${ownerHistory},'Storey',$,$,${storeyPlacement},$,$,.ELEMENT.,0.);`);

  // Relations d'agrégation
  lines.push(`${nextId()}=IFCRELAGGREGATES('${ifcGuid()}',${ownerHistory},$,$,${project},(${site}));`);
  lines.push(`${nextId()}=IFCRELAGGREGATES('${ifcGuid()}',${ownerHistory},$,$,${site},(${building}));`);
  lines.push(`${nextId()}=IFCRELAGGREGATES('${ifcGuid()}',${ownerHistory},$,$,${building},(${storey}));`);

  // Generate elements
  const elementIds = [];
  const stats = { wall: 0, slab: 0, proxy: 0 };

  for (const mesh of meshes) {
    // Skip si pas d'indices : on ne sait pas reconstruire les faces sans ça
    if (!mesh.indices || mesh.indices.length === 0) continue;

    stats[mesh.classification]++;

    // Construire la liste de coordonnées (conversion Y-up glTF → Z-up IFC)
    const coords = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i];
      const y = mesh.positions[i + 1];
      const z = mesh.positions[i + 2];
      coords.push(`(${x.toFixed(6)},${(-z).toFixed(6)},${y.toFixed(6)})`);
    }

    const pointListId = nextId();
    lines.push(`${pointListId}=IFCCARTESIANPOINTLIST3D((${coords.join(',')}));`);

    // Faces (triangles depuis indices)
    const faceList = [];
    for (let i = 0; i < mesh.indices.length; i += 3) {
      // Indices IFC sont 1-based
      faceList.push(`(${mesh.indices[i] + 1},${mesh.indices[i + 1] + 1},${mesh.indices[i + 2] + 1})`);
    }

    const faceSet = nextId();
    lines.push(`${faceSet}=IFCTRIANGULATEDFACESET(${pointListId},$,$,(${faceList.join(',')}),$);`);

    // Shape representation
    const shapeRep = nextId();
    lines.push(`${shapeRep}=IFCSHAPEREPRESENTATION(${geomContext},'Body','Tessellation',(${faceSet}));`);

    const productDefShape = nextId();
    lines.push(`${productDefShape}=IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}));`);

    // Placement local (identité, géométrie déjà en world)
    const elementPlacement = nextId();
    lines.push(`${elementPlacement}=IFCLOCALPLACEMENT(${storeyPlacement},${axis2Placement3D});`);

    // Element selon classification
    // Spec IFC4 : 9 attributs (GlobalId, OwnerHistory, Name, Description, ObjectType,
    //                          ObjectPlacement, Representation, Tag, PredefinedType)
    const elemId = nextId();
    const safeName = escapeIFCString(mesh.name || 'Element');
    let ifcClass;
    let predefinedType;
    if (mesh.classification === 'wall') {
      ifcClass = 'IFCWALL';
      predefinedType = '.STANDARD.';
    } else if (mesh.classification === 'slab') {
      ifcClass = 'IFCSLAB';
      predefinedType = '.FLOOR.';
    } else {
      ifcClass = 'IFCBUILDINGELEMENTPROXY';
      predefinedType = '.NOTDEFINED.';
    }

    lines.push(`${elemId}=${ifcClass}('${ifcGuid()}',${ownerHistory},'${safeName}',$,$,${elementPlacement},${productDefShape},$,${predefinedType});`);
    elementIds.push(elemId);
  }

  // Relation contains : tous les éléments sont dans le storey
  if (elementIds.length > 0) {
    lines.push(`${nextId()}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',${ownerHistory},$,$,(${elementIds.join(',')}),${storey});`);
  }

  const footer = ['ENDSEC;', 'END-ISO-10303-21;'];

  return {
    content: [...header, ...lines, ...footer].join('\n'),
    stats
  };
}

// Endpoint de conversion
app.post('/api/convert', upload.single('glb'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const glbPath = req.file.path;
  const originalName = req.file.originalname;

  try {
    console.log(`[${new Date().toISOString()}] Processing ${originalName}`);

    const meshes = await extractMeshesFromGLB(glbPath);
    console.log(`  Extracted ${meshes.length} meshes`);

    if (meshes.length === 0) {
      throw new Error('No meshes found in GLB file');
    }

    const { content, stats } = generateIFC(meshes, originalName);
    console.log(`  Classified: ${stats.wall} walls, ${stats.slab} slabs, ${stats.proxy} proxies`);

    const outputName = originalName.replace(/\.glb$/i, '') + '.ifc';

    res.setHeader('Content-Type', 'application/x-step');
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('X-Conversion-Stats', JSON.stringify({ ...stats, total: meshes.length }));
    res.send(content);

  } catch (err) {
    console.error('Conversion error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Nettoyage du fichier uploadé
    fs.unlink(glbPath, () => {});
  }
});

app.listen(PORT, () => {
  console.log(`\n  GLB → IFC converter`);
  console.log(`  ───────────────────`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
