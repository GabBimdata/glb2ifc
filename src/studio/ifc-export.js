// Smelt Studio — export IFC4 (STEP) directement depuis le modèle sémantique.
// Murs, planchers, espaces : solides extrudés. Portes et fenêtres : IfcOpeningElement + remplissage.
import { buildElements } from './build.js';
import { levelElevation, wallHeight } from './model.js';
import { COLORS } from './catalog.js';

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
  w.add(`IFCRELAGGREGATES(${guid('rel-site-building')},${oh},$,$,${site},(${building}))`);

  // Styles de surface
  const styles = {};
  const styleFor = (key, transparency = 0) => {
    if (styles[key]) return styles[key];
    const [r, g, b] = hexToRgb(COLORS[key] || '#cccccc');
    const col = w.add(`IFCCOLOURRGB($,${num(r)},${num(g)},${num(b)})`);
    const shading = w.add(`IFCSURFACESTYLESHADING(${col},${num(transparency)})`);
    const style = w.add(`IFCSURFACESTYLE(${stepString(key)},.BOTH.,(${shading}))`);
    styles[key] = style;
    return style;
  };
  const styled = (item, key, transparency) => {
    w.add(`IFCSTYLEDITEM(${item},(${styleFor(key, transparency)}),$)`);
    return item;
  };

  // Géométries
  const profilePolyline = (poly, dx = 0, dy = 0) => {
    const pts = poly.map((p) => w.add(`IFCCARTESIANPOINT((${num(p[0] - dx)},${num(-(p[1] - dy))}))`));
    pts.push(pts[0]);
    const pl = w.add(`IFCPOLYLINE((${pts.join(',')}))`);
    return w.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${pl})`);
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
  const storeys = {};
  const contained = {};
  const spacesByStorey = {};

  project.levels.forEach((level, i) => {
    const z = levelElevation(project, level.id);
    const pl = placement(bldPl, 0, 0, z);
    const st = w.add(`IFCBUILDINGSTOREY(${guid(`storey-${level.id}`)},${oh},${stepString(level.name)},$,$,${pl},$,$,.ELEMENT.,${num(z)})`);
    storeys[level.id] = { entity: st, placement: pl, z };
    contained[level.id] = [];
    spacesByStorey[level.id] = [];
    props(`storey-${level.id}`, st, 'Pset_BuildingStoreyCommon', [['EntranceLevel', 'bool', i === 0], ['AboveGround', 'bool', true]]);
  });

  const roofParts = [];

  for (const el of elements) {
    const st = storeys[el.level.id];
    const key = el.key;
    if (el.kind === 'wall') {
      const pl = placement(st.placement);
      const solid = styled(extrusion(profilePolyline(el.profile), el.depth), el.wallType.category || 'interior');
      const predefined = el.wallType.category === 'partition' ? '.PARTITIONING.' : '.STANDARD.';
      const ent = w.add(`IFCWALL(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([solid])},$,${predefined})`);
      contained[el.level.id].push(ent);
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
      const solid = styled(extrusion(profilePolyline(el.profile), el.depth, -el.depth), 'slab');
      const ent = w.add(`IFCSLAB(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([solid])},$,.FLOOR.)`);
      contained[el.level.id].push(ent);
      props(key, ent, 'Pset_SlabCommon', [['IsExternal', 'bool', false], ['LoadBearing', 'bool', true]]);
      linkMaterial('Béton', ent);
    } else if (el.kind === 'space') {
      const pl = placement(st.placement);
      const solid = extrusion(profilePolyline(el.profile), el.depth);
      const ent = w.add(`IFCSPACE(${guid(key)},${oh},${stepString(String(spacesByStorey[el.level.id].length + 1))},$,$,${pl},${shape([solid])},${stepString(el.name)},.ELEMENT.,.INTERNAL.,$)`);
      spacesByStorey[el.level.id].push(ent);
      quantities(key, ent, 'Qto_SpaceBaseQuantities', [
        ['NetFloorArea', 'area', el.area], ['Height', 'length', el.depth], ['NetVolume', 'volume', el.area * el.depth],
      ]);
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
      const frame = styled(faceSet(el.frame, st.z), 'frame');
      const panel = styled(faceSet(el.panel, st.z), el.kind, el.kind === 'window' ? 0.6 : 0);
      const rep = shape([frame, panel], 'Tessellation');
      const o = el.opening;
      const ent = el.kind === 'door'
        ? w.add(`IFCDOOR(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${rep},$,${num(o.height)},${num(o.width)},.DOOR.,.SINGLE_SWING_LEFT.,$)`)
        : w.add(`IFCWINDOW(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${rep},$,${num(o.height)},${num(o.width)},.WINDOW.,.SINGLE_PANEL.,$)`);
      w.add(`IFCRELFILLSELEMENT(${guid(`relfill-${key}`)},${oh},$,$,${opening},${ent})`);
      contained[el.level.id].push(ent);
      const exterior = el.wall && (el.wall.type || '').startsWith('ext');
      props(key, ent, el.kind === 'door' ? 'Pset_DoorCommon' : 'Pset_WindowCommon', [['IsExternal', 'bool', !!exterior]]);
      linkMaterial(el.kind === 'door' ? 'Bois' : 'Vitrage', ent);
    } else if (el.kind === 'roof') {
      const pl = placement(st.placement);
      let item;
      if (el.profile) item = styled(extrusion(profilePolyline(el.profile), el.depth, el.z0 - st.z), 'roof');
      else item = styled(faceSet(el.mesh, st.z), 'roof');
      const ent = w.add(`IFCSLAB(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([item], el.profile ? 'SweptSolid' : 'Tessellation')},$,.ROOF.)`);
      roofParts.push({ ent, level: el.level });
    } else if (el.kind === 'gable') {
      const pl = placement(st.placement);
      const item = styled(faceSet(el.mesh, st.z), 'gable');
      const ent = w.add(`IFCWALL(${guid(key)},${oh},${stepString(el.name)},$,$,${pl},${shape([item], 'Tessellation')},$,.STANDARD.)`);
      contained[el.level.id].push(ent);
      props(key, ent, 'Pset_WallCommon', [['IsExternal', 'bool', true], ['LoadBearing', 'bool', true]]);
      linkMaterial('Maçonnerie', ent);
    }
  }

  if (roofParts.length) {
    const level = roofParts[0].level;
    const st = storeys[level.id];
    const pl = placement(st.placement);
    const typeEnum = { gable: '.GABLE_ROOF.', hip: '.HIP_ROOF.', shed: '.SHED_ROOF.', flat: '.FLAT_ROOF.' }[project.roof.type] || '.NOTDEFINED.';
    const roof = w.add(`IFCROOF(${guid('roof')},${oh},'Toiture',$,$,${pl},$,$,${typeEnum})`);
    w.add(`IFCRELAGGREGATES(${guid('rel-roof')},${oh},$,$,${roof},(${roofParts.map((r) => r.ent).join(',')}))`);
    contained[level.id].push(roof);
    linkMaterial('Couverture', roof);
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
