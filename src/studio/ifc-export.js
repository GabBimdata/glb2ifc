// Smelt Studio — export IFC4 (STEP) directement depuis le modèle sémantique.
// Murs, planchers, espaces : solides extrudés. Portes et fenêtres : IfcOpeningElement + remplissage.
import { buildElements } from './build.js';
import { levelElevation, wallHeight } from './model.js';
import { colorsOf, IFC_GLASS_TRANSPARENCY } from './catalog.js';
import { equipmentIfcSpec, EQUIPMENT_TYPES } from './equipment-catalog.js';
import { equipmentParts, EQUIPMENT_MATERIALS } from './equipment-models.js';

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

function hash128(str) {
  // deux FNV-1a 64 bits simplifiés (BigInt) → 128 bits déterministes
  let h1 = 0xcbf29ce484222325n, h2 = 0x84222325cbf29ce4n;
  const p = 0x100000001b3n, m = (1n << 64n) - 1n;
  for (let i = 0; i < str.length; i++) {
    const c = BigInt(str.charCodeAt(i));
    h1 = ((h1 ^ c) * p) & m;
    h2 = ((h2 ^ (c + 31n)) * p) & m;
    h2 = ((h2 << 7n) | (h2 >> 57n)) & m;
  }
  return (h1 << 64n) | h2;
}

export function ifcGuid(seed) {
  let n = hash128(seed);
  const chars = [];
  for (let i = 0; i < 22; i++) {
    chars.push(B64[Number(n & 63n)]);
    n >>= 6n;
  }
  chars.reverse();
  chars[0] = B64[B64.indexOf(chars[0]) % 4];
  return chars.join('');
}

export function stepString(s) {
  if (s === null || s === undefined) return '$';
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (code >= 32 && code <= 126) out += ch;
    else if (code <= 0xffff) out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
    else out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
  }
  return `'${out}'`;
}

const num = (v) => {
  if (!Number.isFinite(v)) return '0.';
  const s = (Math.round(v * 1e6) / 1e6).toString();
  return s.includes('.') || s.includes('e') ? s : `${s}.`;
};

class StepWriter {
  constructor() { this.lines = []; this.id = 0; }
  add(entity) { this.id += 1; this.lines.push(`#${this.id}=${entity};`); return `#${this.id}`; }
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function positiveDimension(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function exportIfc(project) {
  const w = new StepWriter();
  const seed = project.uid || project.name || 'smelt';
  const guid = (key) => stepString(ifcGuid(`${seed}:${key}`));
  const now = Math.floor(Date.now() / 1000);
  const P = (x, y, z) => `(${num(x)},${num(-y)},${num(z)})`; // plan (y vers le bas) → IFC (Y vers le haut)

  // En-tête commun
  const person = w.add(`IFCPERSON($,$,'Smelt',$,$,$,$,$)`);
  const org = w.add(`IFCORGANIZATION($,'Smelt',$,$,$)`);
  const pao = w.add(`IFCPERSONANDORGANIZATION(${person},${org},$)`);
  const app = w.add(`IFCAPPLICATION(${org},'1.0','Smelt Studio','SmeltStudio')`);
  const owner = w.add(`IFCOWNERHISTORY(${pao},${app},$,.ADDED.,${now},${pao},${app},${now})`);
  const oh = owner;

  const uLen = w.add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`);
  const uArea = w.add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
  const uVol = w.add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
  const uAng = w.add(`IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)`);
  const units = w.add(`IFCUNITASSIGNMENT((${uLen},${uArea},${uVol},${uAng}))`);

  const origin = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
  const zDir = w.add(`IFCDIRECTION((0.,0.,1.))`);
  const xDir = w.add(`IFCDIRECTION((1.,0.,0.))`);
  const worldAxis = w.add(`IFCAXIS2PLACEMENT3D(${origin},${zDir},${xDir})`);
  const trueNorth = w.add(`IFCDIRECTION((0.,1.))`);
  const context = w.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${worldAxis},${trueNorth})`);
  const body = w.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${context},$,.MODEL_VIEW.,$)`);

  const projectId = w.add(`IFCPROJECT(${guid('project')},${oh},${stepString(project.name)},$,$,$,$,(${context}),${units})`);

  const placement = (rel, x = 0, y = 0, z = 0, dir = null) => {
    const pt = w.add(`IFCCARTESIANPOINT(${P(x, y, z)})`);
    const ref = dir ? w.add(`IFCDIRECTION((${num(dir[0])},${num(-dir[1])},0.))`) : '$';
    const ax = w.add(`IFCAXIS2PLACEMENT3D(${pt},${dir ? zDir : '$'},${ref})`);
    return w.add(`IFCLOCALPLACEMENT(${rel},${ax})`);
  };

  const sitePl = placement('$');
  const site = w.add(`IFCSITE(${guid('site')},${oh},'Terrain',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = placement(sitePl);
  const building = w.add(`IFCBUILDING(${guid('building')},${oh},${stepString(project.name)},$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  w.add(`IFCRELAGGREGATES(${guid('rel-project-site')},${oh},$,$,${projectId},(${site}))`);
  const siteContained = [];  // terrain, surfaces, végétation
  const siteSpaces = [];     // places de stationnement (espaces extérieurs de la parcelle)

  // Styles de surface
  const styles = {};
  const styleFor = (key, colour, transparency = 0) => {
    const id = `${key}-${colour}-${transparency}`;
    if (styles[id]) return styles[id];
    const [r, g, b] = hexToRgb(colour || '#cccccc');
    const col = w.add(`IFCCOLOURRGB($,${num(r)},${num(g)},${num(b)})`);

    // Pour les matériaux transparents, IfcSurfaceStyleRendering est mieux
    // interprété par les viewers IFC que la transparence portée uniquement
    // par IfcSurfaceStyleShading.
    // IFC : 0 = opaque, 1 = totalement transparent.
    const surface = transparency > 0
      ? w.add(`IFCSURFACESTYLERENDERING(${col},${num(transparency)},$,$,$,$,$,$,.GLASS.)`)
      : w.add(`IFCSURFACESTYLESHADING(${col},0.)`); // IFC4 : couleur et transparence

    const style = w.add(`IFCSURFACESTYLE(${stepString(key)},.BOTH.,(${surface}))`);
    styles[id] = style;
    return style;
  };
  const styled = (item, key, body, transparency) => {
    w.add(`IFCSTYLEDITEM(${item},(${styleFor(key, colorsOf(project, body)[key], transparency)}),$)`);
    return item;
  };

  // Géométries
  const profilePolyline = (poly, dx = 0, dy = 0) => {
    const pts = poly.map((p) => w.add(`IFCCARTESIANPOINT((${num(p[0] - dx)},${num(-(p[1] - dy))}))`));
    pts.push(pts[0]);
    const pl = w.add(`IFCPOLYLINE((${pts.join(',')}))`);
    return w.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${pl})`);
  };
  // profil avec vides (terrasse en anneau)
  const profileWithVoids = (outer, holes) => {
    if (!holes?.length) return profilePolyline(outer);
    const loop = (poly) => {
      const pts = poly.map((p) => w.add(`IFCCARTESIANPOINT((${num(p[0])},${num(-p[1])}))`));
      pts.push(pts[0]);
      return w.add(`IFCPOLYLINE((${pts.join(',')}))`);
    };
    return w.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,${loop(outer)},(${holes.map(loop).join(',')}))`);
  };
  const extrusion = (profile, depth, zOffset = 0) => {
    const pt = w.add(`IFCCARTESIANPOINT((0.,0.,${num(zOffset)}))`);
    const pos = w.add(`IFCAXIS2PLACEMENT3D(${pt},$,$)`);
    return w.add(`IFCEXTRUDEDAREASOLID(${profile},${pos},${zDir},${num(depth)})`);
  };
  const shape = (items, type = 'SweptSolid') => {
    const rep = w.add(`IFCSHAPEREPRESENTATION(${body},'Body',${stepString(type)},(${items.join(',')}))`);
    return w.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
  };
  const faceSet = (mesh, zBase) => {
    const coords = mesh.positions.map((p) => `(${num(p[0])},${num(-p[1])},${num(p[2] - zBase)})`).join(',');
    const list = w.add(`IFCCARTESIANPOINTLIST3D((${coords}),$)`);
    // Y inversé → on inverse l'ordre des sommets pour conserver l'orientation
    const idx = mesh.triangles.map((t) => `(${t[0] + 1},${t[2] + 1},${t[1] + 1})`).join(',');
    return w.add(`IFCTRIANGULATEDFACESET(${list},$,.T.,(${idx}),$)`);
  };



  // Propriétés
  const props = (key, target, psetName, values) => {
    const items = values.map(([name, type, value]) => {
      let v;
      if (type === 'bool') v = `IFCBOOLEAN(${value ? '.T.' : '.F.'})`;
      else if (type === 'label') v = `IFCLABEL(${stepString(value)})`;
      else if (type === 'length') v = `IFCLENGTHMEASURE(${num(value)})`;
      else if (type === 'ratio') v = `IFCPOSITIVERATIOMEASURE(${num(value)})`;
      else if (type === 'area') v = `IFCAREAMEASURE(${num(value)})`;
      else if (type === 'count') v = `IFCCOUNTMEASURE(${Math.round(value)})`;
      return w.add(`IFCPROPERTYSINGLEVALUE(${stepString(name)},$,${v},$)`);
    });
    const pset = w.add(`IFCPROPERTYSET(${guid(`pset-${key}`)},${oh},${stepString(psetName)},$,(${items.join(',')}))`);
    w.add(`IFCRELDEFINESBYPROPERTIES(${guid(`relpset-${key}`)},${oh},$,$,(${target}),${pset})`);
  };
  const quantities = (key, target, qtoName, values) => {
    const items = values.map(([name, type, value]) => {
      if (type === 'length') return w.add(`IFCQUANTITYLENGTH(${stepString(name)},$,$,${num(value)},$)`);
      if (type === 'area') return w.add(`IFCQUANTITYAREA(${stepString(name)},$,$,${num(value)},$)`);
      return w.add(`IFCQUANTITYVOLUME(${stepString(name)},$,$,${num(value)},$)`);
    });
    const q = w.add(`IFCELEMENTQUANTITY(${guid(`qto-${key}`)},${oh},${stepString(qtoName)},$,$,(${items.join(',')}))`);
    w.add(`IFCRELDEFINESBYPROPERTIES(${guid(`relqto-${key}`)},${oh},$,$,(${target}),${q})`);
  };

  const materials = {};
  const materialLinks = {};
  const linkMaterial = (name, target) => {
    if (!materials[name]) materials[name] = w.add(`IFCMATERIAL(${stepString(name)},$,$)`);
    (materialLinks[name] ||= []).push(target);
  };

  const { elements } = buildElements(project);
  const multiBody = project.bodies.length > 1;
  const zoneSpaces = {};   // corps → espaces
  const bodyElements = {}; // corps → éléments construits
  const storeys = {};
  const contained = {};
  const spacesByStorey = {};
  const spaceByRoom = {};
  const equipmentByRoom = {};

  project.levels.forEach((level, i) => {
    const z = levelElevation(project, level.id);
    const pl = placement(bldPl, 0, 0, z);
    const st = w.add(`IFCBUILDINGSTOREY(${guid(`storey-${level.id}`)},${oh},${stepString(level.name)},$,$,${pl},$,$,.ELEMENT.,${num(z)})`);
    storeys[level.id] = { entity: st, placement: pl, z };
    contained[level.id] = [];
    spacesByStorey[level.id] = [];
    spaceByRoom[level.id] = {};
    equipmentByRoom[level.id] = {};
    props(`storey-${level.id}`, st, 'Pset_BuildingStoreyCommon', [['EntranceLevel', 'bool', i === 0], ['AboveGround', 'bool', true]]);
  });

  const roofEntities = {};

  const noteBody = (el, entity) => {
    if (!multiBody || !el.body) return entity;
    (bodyElements[el.body.id] ||= { body: el.body, items: [] }).items.push(entity);
    return entity;
  };

  for (const el of elements) {
    const st = storeys[el.level.id];
    const key = el.key;
    if (el.kind === 'wall') {
      const pl = placement(st.placement);
      const solid = el.tessellated
        ? styled(faceSet(el.mesh, st.z), el.wallType.category || 'interior', el.body)
        : styled(extrusion(profilePolyline(el.profile), el.depth, el.z0 - st.z), el.wallType.category || 'interior', el.body);
      const predefined = el.wallType.category === 'partition' ? '.PARTITIONING.' : '.STANDARD.';
      const ent = w.add(`IFCWALL(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([solid], el.tessellated ? 'Tessellation' : 'SweptSolid')},$,${predefined})`);
      contained[el.level.id].push(noteBody(el, ent));
      el._ifc = { entity: ent, placement: pl };
      const L = Math.hypot(el.level.nodes[el.wall.b][0] - el.level.nodes[el.wall.a][0], el.level.nodes[el.wall.b][1] - el.level.nodes[el.wall.a][1]);
      props(key, ent, 'Pset_WallCommon', [
        ['Reference', 'label', el.wallType.label],
        ['IsExternal', 'bool', el.wallType.category === 'exterior'],
        ['LoadBearing', 'bool', el.wallType.category !== 'partition'],
      ]);
      quantities(key, ent, 'Qto_WallBaseQuantities', [
        ['Length', 'length', L], ['Width', 'length', el.wall.thickness], ['Height', 'length', el.depth],
        ['GrossSideArea', 'area', L * el.depth],
      ]);
      if (el.wallType.material) linkMaterial(el.wallType.material, ent);
    } else if (el.kind === 'slab') {
      const pl = placement(st.placement);
      const pieces = el.pieces || [{ outer: el.profile, holes: [] }];
      const solids = pieces.map((pc) => styled(extrusion(profileWithVoids(pc.outer, pc.holes), el.depth, el.z0 - st.z), 'slab', el.body));
      const ent = w.add(`IFCSLAB(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape(solids)},$,.FLOOR.)`);
      contained[el.level.id].push(noteBody(el, ent));
      props(key, ent, 'Pset_SlabCommon', [['IsExternal', 'bool', false], ['LoadBearing', 'bool', true]]);
      linkMaterial('Béton', ent);
    } else if (el.kind === 'ceiling') {
      const pl = placement(st.placement);
      const solid = el.tessellated
        ? styled(faceSet(el.mesh, st.z), 'ceiling', el.body)
        : styled(extrusion(profilePolyline(el.profile), el.depth, el.z0 - st.z), 'ceiling', el.body);
      const ent = w.add(`IFCCOVERING(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([solid], el.tessellated ? 'Tessellation' : 'SweptSolid')},$,.CEILING.)`);
      contained[el.level.id].push(noteBody(el, ent));
      props(key, ent, 'Pset_CoveringCommon', [['IsExternal', 'bool', false]]);
      linkMaterial('Plaque de plâtre', ent);
    } else if (el.kind === 'space') {
      const pl = placement(st.placement);
      // pièce sous les rampants : volume découpé ; sinon prisme posé sur le sol de son corps
      const solid = el.tessellated ? faceSet(el.mesh, st.z) : extrusion(profilePolyline(el.profile), el.depth, el.z0 - st.z);
      const ent = w.add(`IFCSPACE(${guid(key)},${oh},${stepString(String(spacesByStorey[el.level.id].length + 1))},$,$,${pl},${shape([solid], el.tessellated ? 'Tessellation' : 'SweptSolid')},${stepString(el.name)},.ELEMENT.,.INTERNAL.,$)`);
      spacesByStorey[el.level.id].push(ent);
      if (el.room?.id) spaceByRoom[el.level.id][el.room.id] = ent;
      if (multiBody && el.body) (zoneSpaces[el.body.id] ||= { body: el.body, items: [] }).items.push(ent);
      quantities(key, ent, 'Qto_SpaceBaseQuantities', [
        ['NetFloorArea', 'area', el.area], ['Height', 'length', el.depth],
        ...(el.tessellated ? [] : [['NetVolume', 'volume', el.area * el.depth]]),
      ]);
      if (el.areaHabitable !== undefined) {
        // sous toiture : la surface habitable ne compte que la hauteur d'au moins 1,80 m
        props(`surf-${key}`, ent, 'Smelt_Surfaces', [
          ['SurfaceAuSol', 'area', el.area],
          ['SurfaceHabitable', 'area', el.areaHabitable],
          ['HauteurMinimaleHabitable', 'length', 1.8],
        ]);
      }
    } else if (el.kind === 'door' || el.kind === 'window') {
      const host = elements.find((x) => x.kind === 'wall' && x.wall === el.wall);
      if (!host?._ifc) continue;
      const v = el.voidProfile;
      // Ouverture (vide)
      const opPl = placement(st.placement, v.center[0], v.center[1], v.z0 - st.z, v.u);
      const c2 = w.add(`IFCCARTESIANPOINT((0.,0.))`);
      const ax2 = w.add(`IFCAXIS2PLACEMENT2D(${c2},$)`);
      const rect = w.add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${ax2},${num(v.width)},${num(v.depth)})`);
      const voidSolid = extrusion(rect, v.height);
      const opening = w.add(`IFCOPENINGELEMENT(${guid(`void-${key}`)},${oh},'Ouverture',$,$,${opPl},${shape([voidSolid])},$,.OPENING.)`);
      w.add(`IFCRELVOIDSELEMENT(${guid(`relvoid-${key}`)},${oh},$,$,${host._ifc.entity},${opening})`);
      // Menuiserie
      const pl = placement(st.placement);
      const frame = styled(faceSet(el.frame, st.z), 'frame', el.body);
      const panel = styled(faceSet(el.panel, st.z), el.kind, el.body, el.kind === 'window' ? IFC_GLASS_TRANSPARENCY : 0);
      const rep = shape([frame, panel], 'Tessellation');
      const o = el.opening;
      const ent = el.kind === 'door'
        ? w.add(`IFCDOOR(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${rep},$,${num(o.height)},${num(o.width)},.DOOR.,${o.type === 'garageDoor' ? '.ROLLINGUP.' : '.SINGLE_SWING_LEFT.'},$)`)
        : w.add(`IFCWINDOW(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${rep},$,${num(o.height)},${num(o.width)},.WINDOW.,.SINGLE_PANEL.,$)`);
      w.add(`IFCRELFILLSELEMENT(${guid(`relfill-${key}`)},${oh},$,$,${opening},${ent})`);
      contained[el.level.id].push(noteBody(el, ent));
      const exterior = el.wall && (el.wall.type || '').startsWith('ext');
      props(key, ent, el.kind === 'door' ? 'Pset_DoorCommon' : 'Pset_WindowCommon', [['IsExternal', 'bool', !!exterior]]);
      linkMaterial(el.kind === 'door' ? 'Bois' : 'Vitrage', ent);
    } else if (el.kind === 'roof') {
      const pl = placement(st.placement);
      let item;
      if (el.profile) item = styled(extrusion(profilePolyline(el.profile), el.depth, el.z0 - st.z), 'roof', el.body);
      else item = styled(faceSet(el.mesh, st.z), 'roof', el.body);
      // La géométrie est portée directement par l'IfcRoof (et non par des IfcSlab .ROOF.
      // regroupés) : les visionneuses l'identifient alors comme une toiture.
      const typeEnum = { gable: '.GABLE_ROOF.', hip: '.HIP_ROOF.', shed: '.SHED_ROOF.', flat: '.FLAT_ROOF.' }[el.body?.roof?.type] || '.NOTDEFINED.';
      const ent = w.add(`IFCROOF(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([item], el.profile ? 'SweptSolid' : 'Tessellation')},$,${typeEnum})`);
      contained[el.level.id].push(noteBody(el, ent));
      linkMaterial('Couverture', ent);
      roofEntities[el.key] = ent;
    } else if (el.kind === 'skylight') {
      const host = roofEntities[el.hostKey];
      const pl = placement(st.placement);
      const voidSolid = extrusion(profilePolyline(el.voidPoly), el.voidZ1 - el.voidZ0, el.voidZ0 - st.z);
      const opening = w.add(`IFCOPENINGELEMENT(${guid(`void-${key}`)},${oh},'Ouverture de toiture',$,$,${pl},${shape([voidSolid])},$,.OPENING.)`);
      if (host) w.add(`IFCRELVOIDSELEMENT(${guid(`relvoid-${key}`)},${oh},$,$,${host},${opening})`);
      const frame = styled(faceSet(el.frame, st.z), 'frame', el.body);
      const panel = styled(faceSet(el.panel, st.z), 'window', el.body, IFC_GLASS_TRANSPARENCY);
      const it = el.roofOpening.item;
      const ent = w.add(`IFCWINDOW(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([frame, panel], 'Tessellation')},$,${num(it.height ?? el.roofOpening.preset.height)},${num(it.width ?? el.roofOpening.preset.width)},.SKYLIGHT.,.SINGLE_PANEL.,$)`);
      w.add(`IFCRELFILLSELEMENT(${guid(`relfill-${key}`)},${oh},$,$,${opening},${ent})`);
      contained[el.level.id].push(noteBody(el, ent));
      props(key, ent, 'Pset_WindowCommon', [['IsExternal', 'bool', true], ['Reference', 'label', 'Fenêtre de toit']]);
      linkMaterial('Vitrage', ent);
    } else if (el.kind === 'dormer') {
      const host = roofEntities[el.hostKey];
      const pl = placement(st.placement);
      const voidSolid = extrusion(profilePolyline(el.voidPoly), el.voidZ1 - el.voidZ0, el.voidZ0 - st.z);
      const opening = w.add(`IFCOPENINGELEMENT(${guid(`void-${key}`)},${oh},'Percement de lucarne',$,$,${pl},${shape([voidSolid])},$,.OPENING.)`);
      if (host) w.add(`IFCRELVOIDSELEMENT(${guid(`relvoid-${key}`)},${oh},$,$,${host},${opening})`);
      const walls = w.add(`IFCWALL(${guid(`walls-${key}`)},${oh},${stepString(`${el.name} — joues et façade`)},$,$,${pl},${shape([styled(faceSet(el.walls, st.z), 'exterior', el.body)], 'Tessellation')},$,.STANDARD.)`);
      const dormerRoofType = { dormerGable: '.GABLE_ROOF.', dormerHip: '.HIP_ROOF.', dormerShed: '.SHED_ROOF.' }[el.roofOpening?.item?.type] || '.NOTDEFINED.';
      const cover = w.add(`IFCROOF(${guid(`roof-${key}`)},${oh},${stepString(`${el.name} — couverture`)},$,$,${pl},${shape([styled(faceSet(el.roofMesh, st.z), 'roof', el.body)], 'Tessellation')},$,${dormerRoofType})`);
      const frame = styled(faceSet(el.frame, st.z), 'frame', el.body);
      const panel = styled(faceSet(el.panel, st.z), 'window', el.body, IFC_GLASS_TRANSPARENCY);
      const win = w.add(`IFCWINDOW(${guid(key)},${oh},${stepString(`${el.name} — baie`)},$,$,${pl},${shape([frame, panel], 'Tessellation')},$,${num(el.window.height)},${num(el.window.width)},.WINDOW.,.SINGLE_PANEL.,$)`);
      for (const ent of [walls, cover, win]) contained[el.level.id].push(noteBody(el, ent));
      linkMaterial('Maçonnerie', walls);
      linkMaterial('Couverture', cover);
      linkMaterial('Vitrage', win);
      props(key, win, 'Pset_WindowCommon', [['IsExternal', 'bool', true], ['Reference', 'label', el.name]]);
    } else if (el.kind === 'terrace' || el.kind === 'balcony') {
      const pl = placement(st.placement);
      const isRoof = el.kind === 'terrace' && el.mode === 'roof';
      const solids = el.pieces.map((pc) => styled(extrusion(profileWithVoids(pc.outer, pc.holes), el.depth, el.z0 - st.z), isRoof ? 'slab' : 'balcony', el.body));
      const label = el.kind === 'balcony' ? 'Balcon' : isRoof ? 'Toiture-terrasse' : 'Terrasse';
      // une toiture-terrasse est une toiture (IfcRoof), une terrasse ou un balcon une dalle
      const slab = isRoof
        ? w.add(`IFCROOF(${guid(key)},${oh},${stepString(el.name)},$,${stepString(label)},${pl},${shape(solids)},$,.FLAT_ROOF.)`)
        : w.add(`IFCSLAB(${guid(key)},${oh},${stepString(el.name)},$,${stepString(label)},${pl},${shape(solids)},$,.FLOOR.)`);
      contained[el.level.id].push(noteBody(el, slab));
      props(key, slab, isRoof ? 'Pset_RoofCommon' : 'Pset_SlabCommon', isRoof
        ? [['IsExternal', 'bool', true], ['Reference', 'label', label]]
        : [['IsExternal', 'bool', true], ['LoadBearing', 'bool', true], ['Reference', 'label', label]]);
      linkMaterial(isRoof ? 'Couverture' : 'Béton', slab);
      if (el.railParts?.length) {
        const byKey = new Map();
        for (const rp of el.railParts) {
          if (!byKey.has(rp.key)) byKey.set(rp.key, []);
          byKey.get(rp.key).push(rp.mesh);
        }
        const items = [];
        for (const [k2, meshes] of byKey) {
          const merged = { positions: [], triangles: [] };
          for (const m of meshes) {
            const off = merged.positions.length;
            merged.positions.push(...m.positions);
            for (const t of m.triangles) merged.triangles.push([t[0] + off, t[1] + off, t[2] + off]);
          }
          items.push(styled(faceSet(merged, st.z), k2, el.body, k2 === 'window' ? 0.6 : 0));
        }
        const height = el.kind === 'balcony' ? (el.item.railingHeight || 1) : (el.level.terrace?.railingHeight || 1);
        const rail = w.add(`IFCRAILING(${guid(`rail-${key}`)},${oh},${stepString(`Garde-corps ${label.toLowerCase()}`)},$,$,${pl},${shape(items, 'Tessellation')},$,.GUARDRAIL.)`);
        contained[el.level.id].push(noteBody(el, rail));
        props(`rail-${key}`, rail, 'Pset_RailingCommon', [['IsExternal', 'bool', true], ['Height', 'length', height]]);
        linkMaterial('Métal', rail);
      }
      if (!isRoof) {
        // espace extérieur, pour les surfaces annexes
        const spaceSolids = el.pieces.map((pc) => extrusion(profileWithVoids(pc.outer, pc.holes), 2.5, el.top - st.z));
        const sp = w.add(`IFCSPACE(${guid(`space-${key}`)},${oh},${stepString(label)},$,$,${pl},${shape(spaceSolids)},${stepString(label)},.ELEMENT.,.EXTERNAL.,$)`);
        spacesByStorey[el.level.id].push(sp);
        quantities(`space-${key}`, sp, 'Qto_SpaceBaseQuantities', [['NetFloorArea', 'area', el.area]]);
      }
    } else if (['terrain', 'siteSurface', 'parking', 'tree', 'hedge'].includes(el.kind)) {
      // Abords : posés dans l'IfcSite, hors du bâtiment
      const pl = placement(sitePl);
      const color = (k) => el.siteParts.find((p) => p.key === k)?.color || '#999999';
      if (el.kind === 'terrain') {
        const solid = extrusion(profilePolyline(el.poly), el.depth, el.z0);
        w.add(`IFCSTYLEDITEM(${solid},(${styleFor('site-terrain', color('terrain'), 0)}),$)`);
        const ent = w.add(`IFCGEOGRAPHICELEMENT(${guid(key)},${oh},'Terrain',$,$,${pl},${shape([solid])},$,.TERRAIN.)`);
        siteContained.push(ent);
        quantities(key, ent, 'Qto_SiteBaseQuantities', [['GrossArea', 'area', el.area]]);
      } else if (el.kind === 'siteSurface') {
        const cat = el.category;
        const solid = extrusion(profilePolyline(el.poly), el.depth, el.z0);
        w.add(`IFCSTYLEDITEM(${solid},(${styleFor(`site-${el.surface.type}`, color(el.surface.type), 0)}),$)`);
        const ent = cat.ifc === 'slab'
          ? w.add(`IFCSLAB(${guid(key)},${oh},${stepString(cat.label)},$,${stepString(cat.objectType)},${pl},${shape([solid])},$,.USERDEFINED.)`)
          : w.add(`IFCGEOGRAPHICELEMENT(${guid(key)},${oh},${stepString(cat.label)},$,${stepString(cat.objectType)},${pl},${shape([solid])},$,.USERDEFINED.)`);
        siteContained.push(ent);
        quantities(key, ent, cat.ifc === 'slab' ? 'Qto_SlabBaseQuantities' : 'Qto_SiteBaseQuantities', [[cat.ifc === 'slab' ? 'NetArea' : 'GrossArea', 'area', el.area]]);
      } else if (el.kind === 'parking') {
        // place de stationnement : un espace extérieur de type PARKING, avec son marquage
        const vol = extrusion(profilePolyline(el.poly), 2.0, el.top);
        const sp = w.add(`IFCSPACE(${guid(key)},${oh},${stepString(`P${siteSpaces.length + 1}`)},$,$,${pl},${shape([vol])},'Place de stationnement',.ELEMENT.,.PARKING.,$)`);
        siteSpaces.push(sp);
        quantities(key, sp, 'Qto_SpaceBaseQuantities', [['NetFloorArea', 'area', el.area]]);
        const mark = w.add(`IFCBUILDINGELEMENTPROXY(${guid(`mark-${key}`)},${oh},'Marquage au sol',$,'Marquage',${pl},${shape([faceSet(el.siteParts[0].mesh, 0)], 'Tessellation')},$,.NOTDEFINED.)`);
        siteContained.push(mark);
      } else {
        const items = el.siteParts.map((p) => {
          const it = faceSet(p.mesh, 0);
          w.add(`IFCSTYLEDITEM(${it},(${styleFor(`site-${p.key}`, p.color, 0)}),$)`);
          return it;
        });
        const label = el.kind === 'hedge' ? 'Haie' : el.name;
        const ent = w.add(`IFCGEOGRAPHICELEMENT(${guid(key)},${oh},${stepString(label)},$,${stepString(el.kind === 'hedge' ? 'Haie' : 'Arbre')},${pl},${shape(items, 'Tessellation')},$,.USERDEFINED.)`);
        siteContained.push(ent);
        if (el.kind === 'tree') props(key, ent, 'Smelt_Vegetation', [['Hauteur', 'length', el.tree.height || 7], ['DiametreHouppier', 'length', el.tree.diameter || 4], ['Essence', 'label', el.name]]);
        else props(key, ent, 'Smelt_Vegetation', [['Hauteur', 'length', el.hedge.height || 1.6], ['Longueur', 'length', el.length]]);
      }
    } else if (el.kind === 'stair') {
      // IfcStair regroupe ses volées (avec leurs marches et limons), son palier et sa main courante
      const pl = placement(st.placement);
      const info = el.layout.info;
      const mergeKey = (keys, flightIndex = null) => {
        const m = { positions: [], triangles: [] };
        for (const p of el.parts.filter((x) => keys.includes(x.key) && (flightIndex === null || x.flight === flightIndex))) {
          const off = m.positions.length;
          m.positions.push(...p.mesh.positions);
          for (const t of p.mesh.triangles) m.triangles.push([t[0] + off, t[1] + off, t[2] + off]);
        }
        return m.triangles.length ? m : null;
      };
      const quarter = el.stair.type === 'quarter';
      const winding = el.stair.type === 'winder';
      const stair = w.add(`IFCSTAIR(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},$,$,${winding ? '.QUARTER_WINDING_STAIR.' : quarter ? '.QUARTER_TURN_STAIR.' : '.STRAIGHT_RUN_STAIR.'})`);
      const children = [];
      // Un palier sépare deux volées droites ; sans palier, le quart tournant
      // constitue une seule volée de type WINDER, incluant les marches en éventail.
      const flights = quarter ? info.flights.map((treads, index) => ({ index, treads, risers: treads + 1 }))
        : [{ index: null, treads: info.treads, risers: info.risers }];
      for (const f of flights) {
        const flightMesh = mergeKey(['tread', 'stringer'], f.index);
        if (!flightMesh) continue;
        const fl = w.add(`IFCSTAIRFLIGHT(${guid(`flight-${key}-${f.index ?? 'all'}`)},${oh},${stepString(quarter ? `Volée ${f.index + 1}` : 'Volée')},$,$,${pl},${shape([styled(faceSet(flightMesh, st.z), 'stair', el.body)], 'Tessellation')},$,${f.risers},${f.treads},${num(info.riser)},${num(info.going)},${winding ? '.WINDER.' : '.STRAIGHT.'})`);
        children.push(fl);
      }
      const landingMesh = mergeKey(['landing']);
      if (landingMesh) {
        children.push(w.add(`IFCSLAB(${guid(`landing-${key}`)},${oh},'Palier',$,$,${pl},${shape([styled(faceSet(landingMesh, st.z), 'stair', el.body)], 'Tessellation')},$,.LANDING.)`));
      }
      const railMesh = mergeKey(['rail']);
      if (railMesh) {
        children.push(w.add(`IFCRAILING(${guid(`handrail-${key}`)},${oh},'Main courante',$,$,${pl},${shape([styled(faceSet(railMesh, st.z), 'railing', el.body)], 'Tessellation')},$,.HANDRAIL.)`));
      }
      w.add(`IFCRELAGGREGATES(${guid(`rel-${key}`)},${oh},$,$,${stair},(${children.join(',')}))`);
      contained[el.level.id].push(noteBody(el, stair));
      props(key, stair, 'Pset_StairCommon', [
        ['NumberOfRiser', 'count', info.risers],
        ['NumberOfTreads', 'count', info.treads],
        ['RiserHeight', 'length', info.riser],
        ['TreadLength', 'length', info.going],
      ]);
      linkMaterial('Bois', stair);
    } else if (el.kind === 'tremieRail') {
      if (!el.railParts.length) continue;
      const pl = placement(st.placement);
      const m = { positions: [], triangles: [] };
      for (const rp of el.railParts) {
        const off = m.positions.length;
        m.positions.push(...rp.mesh.positions);
        for (const t of rp.mesh.triangles) m.triangles.push([t[0] + off, t[1] + off, t[2] + off]);
      }
      const rail = w.add(`IFCRAILING(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([styled(faceSet(m, st.z), 'railing', el.body)], 'Tessellation')},$,.GUARDRAIL.)`);
      contained[el.level.id].push(noteBody(el, rail));
      props(key, rail, 'Pset_RailingCommon', [['IsExternal', 'bool', false], ['Height', 'length', 1.0]]);
      linkMaterial('Métal', rail);
    } else if (el.kind === 'gable') {
      const pl = placement(st.placement);
      const item = styled(faceSet(el.mesh, st.z), 'gable', el.body);
      const ent = w.add(`IFCWALL(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([item], 'Tessellation')},$,.STANDARD.)`);
      contained[el.level.id].push(noteBody(el, ent));
      props(key, ent, 'Pset_WallCommon', [['IsExternal', 'bool', true], ['LoadBearing', 'bool', true]]);
      linkMaterial('Maçonnerie', ent);
    }
  }


  // Équipements de pièces.
  // Équipements : même géométrie générée que la vue 3D, dans le repère local de l'objet.
  // La pièce et le corps de bâtiment sont ceux calculés par la construction du modèle.
  for (const level of project.levels) {
    const st = storeys[level.id];

    for (const el of elements.filter((x) => x.kind === 'equipment' && x.level.id === level.id)) {
      const item = el.item;
      const spec = equipmentIfcSpec(item);
      const width = positiveDimension(item.width, spec.width);
      const depth = positiveDimension(item.depth, spec.depth);
      const height = positiveDimension(item.height, spec.height);
      const zOffset = Number.isFinite(Number(item.zOffset)) ? Number(item.zOffset) : 0;
      const rotation = Number.isFinite(Number(item.rotation)) ? Number(item.rotation) : 0;
      const x = Number.isFinite(Number(item.x)) ? Number(item.x) : 0;
      const y = Number.isFinite(Number(item.y)) ? Number(item.y) : 0;

      const angle = rotation * Math.PI / 180;
      const dir = [Math.cos(angle), Math.sin(angle)];

      const room = el.room;
      const equipBody = el.body;
      const key = `equipment-${item.id}`;

      // posé sur le sol du corps de bâtiment de la pièce, et non sur le plancher du niveau
      const pl = placement(st.placement, x, y, (equipBody?.elevation || 0) + zOffset, dir);

      const cat = EQUIPMENT_TYPES[item.type];
      let geometryItems = [];
      {
        // modèle généré : même géométrie que la vue 3D, dans le repère local de l'équipement
        const parts = equipmentParts({ ...item, width, depth, height, model: cat?.model });
        const byMat = new Map();
        for (const p of parts) {
          if (!byMat.has(p.mat)) byMat.set(p.mat, []);
          byMat.get(p.mat).push(p.mesh);
        }
        for (const [mat, meshes] of byMat) {
          const merged = { positions: [], triangles: [] };
          for (const m of meshes) {
            const off = merged.positions.length;
            merged.positions.push(...m.positions);
            for (const t of m.triangles) merged.triangles.push([t[0] + off, t[1] + off, t[2] + off]);
          }
          const matSpec = EQUIPMENT_MATERIALS[mat] || EQUIPMENT_MATERIALS.cabinet;
          const item3d = faceSet(merged, 0);
          w.add(`IFCSTYLEDITEM(${item3d},(${styleFor(`equipment-${mat}`, matSpec.color, 1 - (matSpec.opacity ?? 1))}),$)`);
          geometryItems.push(item3d);
        }
      }

      if (!geometryItems.length) {
        throw new Error(`L'équipement « ${spec.label} » n'a produit aucune géométrie.`);
      }

      const rep = shape(geometryItems, 'Tessellation');

      const name = stepString(spec.label);
      const tag = stepString(item.id);
      const predefined = `.${spec.predefined}.`;
      // IfcSanitaryTerminal, IfcElectricAppliance et IfcFurniture partagent la même signature IFC4
      const entity = ['IFCSANITARYTERMINAL', 'IFCELECTRICAPPLIANCE', 'IFCFURNITURE'].includes(spec.entity) ? spec.entity : 'IFCFURNITURE';
      const ent = w.add(`${entity}(${guid(key)},${oh},${name},$,$,${pl},${rep},${tag},${predefined})`);

      noteBody({ body: equipBody }, ent);

      props(key, ent, 'Smelt_Equipment', [
        ['SmeltType', 'label', item.type || 'unknown'],
        ['SmeltId', 'label', item.id || ''],
        ['RoomId', 'label', room?.id || ''],
        ['Room', 'label', room?.name || ''],
        ['Width', 'length', width],
        ['Depth', 'length', depth],
        ['Height', 'length', height],
        ['Elevation', 'length', zOffset],
        ['Rotation', 'label', `${rotation} deg`],
      ]);

      const roomSpace = room?.id ? spaceByRoom[level.id][room.id] : null;
      if (roomSpace) {
        (equipmentByRoom[level.id][room.id] ||= []).push(ent);
      } else {
        contained[level.id].push(ent);
      }
    }
  }

  w.add(`IFCRELAGGREGATES(${guid('rel-site-building')},${oh},$,$,${site},(${[building, ...siteSpaces].join(',')}))`);
  if (siteContained.length) {
    w.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid('contain-site')},${oh},$,$,(${siteContained.join(',')}),${site})`);
  }

  // Corps de bâtiment : une IfcZone par corps (espaces) et un groupe pour les ouvrages
  if (multiBody) {
    for (const [id, z] of Object.entries(zoneSpaces)) {
      const zone = w.add(`IFCZONE(${guid(`zone-${id}`)},${oh},${stepString(z.body.name)},'Corps de bâtiment',$,$)`);
      w.add(`IFCRELASSIGNSTOGROUP(${guid(`relzone-${id}`)},${oh},$,$,(${z.items.join(',')}),$,${zone})`);
    }
    for (const [id, g] of Object.entries(bodyElements)) {
      const prop = w.add(`IFCPROPERTYSINGLEVALUE('Corps',$,IFCLABEL(${stepString(g.body.name)}),$)`);
      const pset = w.add(`IFCPROPERTYSET(${guid(`pset-body-${id}`)},${oh},'Smelt_Corps',$,(${prop}))`);
      w.add(`IFCRELDEFINESBYPROPERTIES(${guid(`relbody-${id}`)},${oh},$,$,(${g.items.join(',')}),${pset})`);
    }
  }

  for (const level of project.levels) {
    for (const [roomId, items] of Object.entries(equipmentByRoom[level.id] || {})) {
      const space = spaceByRoom[level.id]?.[roomId];
      if (space && items.length) {
        w.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid(`contain-equipment-${level.id}-${roomId}`)},${oh},$,$,(${items.join(',')}),${space})`);
      }
    }
  }

  for (const level of project.levels) {
    const st = storeys[level.id];
    if (contained[level.id].length) {
      w.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid(`contain-${level.id}`)},${oh},$,$,(${contained[level.id].join(',')}),${st.entity})`);
    }
    if (spacesByStorey[level.id].length) {
      w.add(`IFCRELAGGREGATES(${guid(`spaces-${level.id}`)},${oh},$,$,${st.entity},(${spacesByStorey[level.id].join(',')}))`);
    }
  }
  w.add(`IFCRELAGGREGATES(${guid('rel-building-storeys')},${oh},$,$,${building},(${project.levels.map((l) => storeys[l.id].entity).join(',')}))`);

  for (const [name, targets] of Object.entries(materialLinks)) {
    w.add(`IFCRELASSOCIATESMATERIAL(${guid(`mat-${name}`)},${oh},$,$,(${targets.join(',')}),${materials[name]})`);
  }

  const date = new Date().toISOString().slice(0, 19);
  const header = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${stepString(`${project.name}.ifc`)},'${date}',('Smelt'),('Smelt'),'Smelt Studio','Smelt Studio','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
  ];
  return [...header, ...w.lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}

// utilitaire pour d'éventuels usages externes
export { wallHeight };
