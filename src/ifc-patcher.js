/**
 * IFC type reclassification patcher (v2 — catalog-driven).
 *
 * Compared to v1, this version uses the centralized catalog in
 * `ifc-catalog.js` to know which types are supported and how to
 * convert between them. It supports ~80 types (architecture,
 * structure, foundations, MEP, civil, misc).
 *
 * Tiers handled:
 *   - 'standard' : 9-attr swap, change class + PredefinedType
 *   - 'opening'  : 13-attr (Door, Window), compute Height/Width from geom
 *
 * 'unsupported' types are not reachable from the picker.
 *
 * Some catalog entries have `predefined: null`. Those types either don't
 * have a PredefinedType attribute in IFC4, or it's outside the scope of
 * v1. For those, we fall back to '.NOTDEFINED.' or omit the attribute,
 * depending on the IFC schema requirement. To stay safe and broadly
 * compatible, we treat null as an instruction to use '.NOTDEFINED.'.
 */

import { buildIfcCatalog, IFC_TYPES, IFC_CATEGORIES } from './ifc-catalog.js';

const catalog = buildIfcCatalog();

const STANDARD_FALLBACK_PREDEFINED = '.NOTDEFINED.';
const OPENING_THIRD_ATTR = '.NOTDEFINED.'; // OperationType / PartitioningType

const categoryByKey = new Map(IFC_CATEGORIES.map((category) => [category.key, category]));

function ifcGuid() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  let s = '';
  for (let i = 0; i < 22; i++) s += chars[Math.floor(Math.random() * 64)];
  return s;
}

function escapeIFCString(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/[^\x20-\x7EÀ-ÿ]/g, '_');
}

function stepString(value) {
  const text = String(value ?? '').trim();
  return text ? `'${escapeIFCString(text)}'` : '$';
}

function parseStepString(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '$' || text === '*') return '';
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return '';
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readableIfcType(type) {
  return String(type || '')
    .replace(/^IFC/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function genericTermsForEntry(entry) {
  if (!entry) return [];
  return [
    entry.label,
    entry.type,
    entry.type?.replace(/^IFC/i, ''),
    readableIfcType(entry.type),
    ...(entry.aliases || []),
  ]
    .map((value) => normalizeSearchText(value))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function isProxyishName(name) {
  return !name || /^(proxy|ifcbuildingelementproxy|building element proxy|element generique|élément générique)\b/i.test(name.trim());
}

function extractGenericSuffix(currentName, fromEntry) {
  const existing = String(currentName || '').trim();
  if (!existing) return '';

  const normalizedExisting = normalizeSearchText(existing);
  const terms = genericTermsForEntry(fromEntry);

  for (const term of terms) {
    const pattern = new RegExp(`^${escapeRegExp(term)}(?:[\\s_#-]+)?(.*)$`, 'i');
    const match = normalizedExisting.match(pattern);
    if (!match) continue;

    // Slice on the original string approximately after the same term length.
    // Good enough for names like "Wall 017", "Mur_017", "IfcWall #17".
    const suffix = existing.slice(Math.min(existing.length, term.length)).replace(/^[\s_#-]+/, '').trim();
    return suffix || '';
  }

  if (isProxyishName(existing)) {
    return existing.replace(/^(proxy|ifcbuildingelementproxy|building element proxy|element generique|élément générique)[\s_#-]*/i, '').trim();
  }

  return null;
}

function shouldRenameElement(currentName, fromEntry) {
  const existing = String(currentName || '').trim();
  if (!existing) return true;
  if (isProxyishName(existing)) return true;
  return extractGenericSuffix(existing, fromEntry) !== null;
}

function suggestElementName(currentName, fromEntry, targetEntry, targetId) {
  const label = targetEntry?.label || targetEntry?.type || 'Élément';
  const existing = String(currentName || '').trim();

  if (!shouldRenameElement(existing, fromEntry)) return existing;

  const suffix = extractGenericSuffix(existing, fromEntry);
  return suffix ? `${label} ${suffix}` : `${label} #${targetId}`;
}

function enrichCommonArgs(commonArgs, fromEntry, toEntry, targetId) {
  const args = [...commonArgs];
  while (args.length < 8) args.push('$');

  const currentName = parseStepString(args[2]);
  args[2] = stepString(suggestElementName(currentName, fromEntry, toEntry, targetId)); // Name
  args[4] = stepString(toEntry.label || toEntry.type);                                 // ObjectType

  const currentTag = parseStepString(args[7]);
  if (!currentTag || isProxyishName(currentTag) || shouldRenameElement(currentTag, fromEntry)) {
    args[7] = stepString(toEntry.type);                                                 // Tag
  }

  return args;
}

function maxEntityId(lines) {
  let max = 0;
  for (const line of lines) {
    const match = String(line).match(/^#(\d+)=/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function insertIfcLine(lines, line) {
  let endDataIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^ENDSEC;\s*$/i.test(String(lines[i]).trim())) {
      endDataIndex = i;
      break;
    }
  }
  if (endDataIndex >= 0) lines.splice(endDataIndex, 0, line);
  else lines.push(line);
}

function makeAppender(lines) {
  let next = maxEntityId(lines) + 1;
  return {
    nextRef() {
      return `#${next++}`;
    },
    add(line) {
      insertIfcLine(lines, line);
    },
  };
}

function refsFromList(text) {
  return [...String(text || '').matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function refsToIfcList(ids) {
  return `(${[...new Set(ids)].map((id) => `#${Number(id)}`).join(',')})`;
}

function representationRefsForEntity(lines, entityArgs) {
  const repId = refId(entityArgs[6]);
  if (!repId) return [];

  const productShape = findEntity(lines, repId);
  if (!productShape || productShape.type !== 'IFCPRODUCTDEFINITIONSHAPE') {
    return [repId];
  }

  const shapeReps = refsFromList(productShape.args[2]);
  return shapeReps.length ? shapeReps : [repId];
}

function removeFromExistingPresentationLayers(lines, layeredItemIds) {
  const remove = new Set(layeredItemIds.map(Number));

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i]);
    const match = line.match(/^#(\d+)=IFCPRESENTATIONLAYERASSIGNMENT\(([\s\S]*)\);$/i);
    if (!match) continue;

    const args = splitIfcArgs(match[2]);
    const assigned = refsFromList(args[2]);
    const kept = assigned.filter((id) => !remove.has(Number(id)));

    if (kept.length === assigned.length) continue;

    if (kept.length === 0) {
      lines[i] = null;
    } else {
      args[2] = refsToIfcList(kept);
      lines[i] = `#${match[1]}=IFCPRESENTATIONLAYERASSIGNMENT(${args.join(',')});`;
    }
  }
}


function findEntityByRef(lines, ref) {
  const id = refId(ref);
  return id ? findEntity(lines, id) : null;
}

function rewriteRelatedObjectsOrDelete(lines, lineIndex, match, args, relatedArgIndex, targetId) {
  const related = refsFromList(args[relatedArgIndex]);
  if (!related.includes(Number(targetId))) return false;

  const kept = related.filter((id) => Number(id) !== Number(targetId));
  if (!kept.length) {
    lines[lineIndex] = null;
  } else {
    args[relatedArgIndex] = refsToIfcList(kept);
    lines[lineIndex] = `#${match[1]}=${match[2]}(${args.join(',')});`;
  }
  return true;
}

function removeClassificationRelationsForTarget(lines, targetId) {
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '');
    const match = line.match(/^#(\d+)=(IFCRELASSOCIATESCLASSIFICATION)\(([\s\S]*)\);$/i);
    if (!match) continue;
    const args = splitIfcArgs(match[3]);
    rewriteRelatedObjectsOrDelete(lines, i, match, args, 4, targetId);
  }
}

function isGeneratedTypePsetOrQto(entity) {
  if (!entity) return false;
  const name = parseStepString(entity.args[2]);
  if (entity.type === 'IFCPROPERTYSET') return /^Pset_.*Common$/i.test(name);
  if (entity.type === 'IFCELEMENTQUANTITY') return /^Qto_.*BaseQuantities$/i.test(name);
  return false;
}

function removeGeneratedPropertyRelationsForTarget(lines, targetId) {
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '');
    const match = line.match(/^#(\d+)=(IFCRELDEFINESBYPROPERTIES)\(([\s\S]*)\);$/i);
    if (!match) continue;

    const args = splitIfcArgs(match[3]);
    const related = refsFromList(args[4]);
    if (!related.includes(Number(targetId))) continue;

    const definition = findEntityByRef(lines, args[5]);
    if (!isGeneratedTypePsetOrQto(definition)) continue;

    rewriteRelatedObjectsOrDelete(lines, i, match, args, 4, targetId);
  }
}

function cleanupOldMetadataForTarget(lines, targetId) {
  removeClassificationRelationsForTarget(lines, targetId);
  removeGeneratedPropertyRelationsForTarget(lines, targetId);
}

function layerInfoForType(toEntry) {
  const type = toEntry.type;
  const categoryLabel = categoryByKey.get(toEntry.category)?.label || toEntry.category || 'IFC';

  const direct = {
    IFCWALL: ['A-WALL', 'Walls'],
    IFCCURTAINWALL: ['A-CURTAINWALL', 'Curtain walls'],
    IFCSLAB: ['A-SLAB', 'Slabs and floors'],
    IFCROOF: ['A-ROOF', 'Roofs'],
    IFCDOOR: ['A-DOOR', 'Doors'],
    IFCWINDOW: ['A-WINDOW', 'Windows and glazing'],
    IFCSTAIR: ['A-STAIR', 'Stairs'],
    IFCSTAIRFLIGHT: ['A-STAIR', 'Stairs'],
    IFCBEAM: ['S-BEAM', 'Structural beams'],
    IFCCOLUMN: ['S-COLUMN', 'Structural columns'],
    IFCMEMBER: ['S-MEMBER', 'Structural members'],
    IFCFOOTING: ['S-FOUNDATION', 'Foundations'],
    IFCPILE: ['S-FOUNDATION', 'Foundations'],
    IFCFURNITURE: ['I-FURNITURE', 'Furniture'],
    IFCFURNISHINGELEMENT: ['I-FURNITURE', 'Furniture and equipment'],
    IFCBUILDINGELEMENTPROXY: ['Z-PROXY', 'Unclassified proxy geometry'],
  };

  if (direct[type]) {
    return { name: direct[type][0], description: direct[type][1] };
  }

  const prefixByCategory = {
    arch_walls: 'A-WALLS',
    arch_floors: 'A-FLOORS',
    arch_openings: 'A-OPENINGS',
    arch_circulation: 'A-CIRCULATION',
    arch_finishes: 'A-FINISHES',
    structure: 'S-STRUCTURE',
    foundations: 'S-FOUNDATION',
    furnishings: 'I-FURNITURE',
    mep_distribution: 'M-DISTRIBUTION',
    mep_flow: 'M-FLOW',
    mep_electrical: 'E-ELECTRICAL',
    mep_terminals: 'M-TERMINALS',
    civil: 'C-CIVIL',
    misc: 'Z-MISC',
  };

  return {
    name: prefixByCategory[toEntry.category] || `Z-${type.replace(/^IFC/, '')}`,
    description: categoryLabel,
  };
}

function applyPresentationLayerForType(lines, appender, entityArgs, toEntry) {
  const layeredItemIds = representationRefsForEntity(lines, entityArgs);
  if (!layeredItemIds.length) return;

  removeFromExistingPresentationLayers(lines, layeredItemIds);

  const layer = layerInfoForType(toEntry);
  const layerRef = appender.nextRef();
  appender.add(`${layerRef}=IFCPRESENTATIONLAYERASSIGNMENT(${stepString(layer.name)},${stepString(layer.description)},${refsToIfcList(layeredItemIds)},${stepString(layer.name)});`);
}

function findClassificationRoot(lines, name) {
  for (const line of lines) {
    const match = String(line).match(/^(#\d+)=IFCCLASSIFICATION\(([\s\S]*)\);$/i);
    if (!match) continue;
    const args = splitIfcArgs(match[2]);
    if (parseStepString(args[3]) === name) return match[1];
  }
  return null;
}

function getOrCreateClassificationRoot(lines, appender) {
  const name = 'IFC Class';
  const existing = findClassificationRoot(lines, name);
  if (existing) return existing;

  const root = appender.nextRef();
  appender.add(`${root}=IFCCLASSIFICATION('Smelt',$,$,${stepString(name)},'IFC class assigned manually in the local viewer',$,$);`);
  return root;
}

function applyClassificationForType(lines, appender, targetId, toEntry, cache) {
  const root = getOrCreateClassificationRoot(lines, appender);
  const category = categoryByKey.get(toEntry.category);
  const cacheKey = `${root}:${toEntry.type}`;

  let reference = cache.get(cacheKey);
  if (!reference) {
    reference = appender.nextRef();
    const name = toEntry.label || toEntry.type;
    const description = category?.label ? `${category.label} - ${toEntry.type}` : toEntry.type;
    appender.add(`${reference}=IFCCLASSIFICATIONREFERENCE($,${stepString(toEntry.type)},${stepString(name)},${root},${stepString(description)},$);`);
    cache.set(cacheKey, reference);
  }

  const relation = appender.nextRef();
  appender.add(`${relation}=IFCRELASSOCIATESCLASSIFICATION('${ifcGuid()}',$,${stepString(`Reclassification ${toEntry.type}`)},$,(${`#${targetId}`}),${reference});`);
}


function addPropertySingleValue(appender, name, typedValue) {
  const prop = appender.nextRef();
  appender.add(`${prop}=IFCPROPERTYSINGLEVALUE(${stepString(name)},$,${typedValue},$);`);
  return prop;
}

function commonPsetForType(toEntry) {
  const type = toEntry?.type;
  const reference = `IFCIDENTIFIER('')`;
  const no = 'IFCBOOLEAN(.F.)';
  const yes = 'IFCBOOLEAN(.T.)';

  const map = {
    IFCWALL: {
      name: 'Pset_WallCommon',
      props: [
        ['Reference', reference],
        ['IsExternal', no],
        ['LoadBearing', no],
        ['ExtendToStructure', no],
      ],
    },
    IFCSLAB: {
      name: 'Pset_SlabCommon',
      props: [
        ['Reference', reference],
        ['IsExternal', no],
        ['LoadBearing', no],
      ],
    },
    IFCBEAM: {
      name: 'Pset_BeamCommon',
      props: [
        ['Reference', reference],
        ['IsExternal', no],
        ['LoadBearing', no],
      ],
    },
    IFCCOLUMN: {
      name: 'Pset_ColumnCommon',
      props: [
        ['Reference', reference],
        ['IsExternal', no],
        ['LoadBearing', no],
      ],
    },
    IFCSTAIR: {
      name: 'Pset_StairCommon',
      props: [
        ['Reference', reference],
        ['IsExternal', no],
      ],
    },
    IFCSTAIRFLIGHT: {
      name: 'Pset_StairFlightCommon',
      props: [
        ['Reference', reference],
        ['IsExternal', no],
      ],
    },
    IFCROOF: {
      name: 'Pset_RoofCommon',
      props: [
        ['Reference', reference],
        ['IsExternal', yes],
        ['LoadBearing', no],
      ],
    },
    IFCDOOR: {
      name: 'Pset_DoorCommon',
      props: [
        ['Reference', reference],
        ['IsExternal', no],
      ],
    },
    IFCWINDOW: {
      name: 'Pset_WindowCommon',
      props: [
        ['Reference', reference],
        ['IsExternal', no],
      ],
    },
  };

  return map[type] || null;
}

function applyCommonPsetForType(lines, appender, targetId, ownerHistory, toEntry) {
  const spec = commonPsetForType(toEntry);
  if (!spec) return;

  const props = spec.props.map(([name, value]) => addPropertySingleValue(appender, name, value));
  const pset = appender.nextRef();
  appender.add(`${pset}=IFCPROPERTYSET('${ifcGuid()}',${ownerHistory || '$'},${stepString(spec.name)},$,${refsToIfcList(props.map((ref) => Number(ref.slice(1))))});`);
  const rel = appender.nextRef();
  appender.add(`${rel}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${ownerHistory || '$'},$, $,(${`#${targetId}`}),${pset});`.replace(',$, $,', ',$,$,'));
}

function applyMetadataForReclassification(lines, appender, targetId, entityArgs, toEntry, classificationCache) {
  const ownerHistory = entityArgs[1] || '$';
  applyPresentationLayerForType(lines, appender, entityArgs, toEntry);
  applyClassificationForType(lines, appender, targetId, toEntry, classificationCache);
  applyCommonPsetForType(lines, appender, targetId, ownerHistory, toEntry);
}

/**
 * Split an IFC argument list at the top-level commas, ignoring commas
 * inside parentheses and string literals (where ' is escaped as '').
 */
export function splitIfcArgs(text) {
  const args = [];
  let depth = 0;
  let inString = false;
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      buf += c;
      if (c === "'") {
        if (text[i + 1] === "'") { buf += "'"; i += 2; continue; }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (c === "'") { inString = true; buf += c; i += 1; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { args.push(buf); buf = ''; }
    else buf += c;
    i += 1;
  }
  if (buf.length > 0) args.push(buf);
  return args;
}

export function findEntity(lines, localId) {
  const target = `#${localId}=`;
  for (let i = 0; i < lines.length; i++) {
    if (String(lines[i] || '').startsWith(target)) {
      const m = lines[i].match(/^#(\d+)=([A-Z0-9_]+)\(([\s\S]*)\);$/);
      if (!m) return null;
      return { lineIndex: i, lineText: lines[i], type: m[2], args: splitIfcArgs(m[3]) };
    }
  }
  return null;
}

/**
 * Parse a reference string like "#42" → 42, or null if not a ref.
 */
function refId(arg) {
  if (!arg) return null;
  const m = String(arg).trim().match(/^#(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Resolve geometry coordinates for an element. Returns IFC-space bounds
 * (Z up). Tries the Representation arg first; if that fails for any reason,
 * returns null and the caller uses sensible defaults.
 */
export function getElementBoundsFromIfc(lines, elementArgs) {
  const repId = refId(elementArgs[6]);
  if (!repId) return null;

  const productShape = findEntity(lines, repId);
  if (!productShape || productShape.type !== 'IFCPRODUCTDEFINITIONSHAPE') return null;

  const repsList = productShape.args[2]?.replace(/[()]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  if (!repsList || repsList.length === 0) return null;

  for (const shapeRepRef of repsList) {
    const shapeRep = findEntity(lines, shapeRepRef.replace('#', ''));
    if (!shapeRep || shapeRep.type !== 'IFCSHAPEREPRESENTATION') continue;

    const itemsList = shapeRep.args[3]?.replace(/[()]/g, '').split(',').map(s => s.trim()).filter(Boolean);
    if (!itemsList) continue;

    for (const itemRef of itemsList) {
      const item = findEntity(lines, itemRef.replace('#', ''));
      if (!item) continue;
      if (item.type !== 'IFCTRIANGULATEDFACESET') continue;

      const coordRef = item.args[0]?.trim().replace('#', '');
      const pointList = findEntity(lines, coordRef);
      if (!pointList || pointList.type !== 'IFCCARTESIANPOINTLIST3D') continue;

      const coordsRaw = pointList.args[0];
      const inner = coordsRaw.trim().replace(/^\(\(/, '').replace(/\)\)$/, '');
      const triplets = inner.split('),(');

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;

      for (const t of triplets) {
        const parts = t.replace(/[()]/g, '').split(',').map(Number);
        if (parts.length < 3 || parts.some(Number.isNaN)) continue;
        const [x, y, z] = parts;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }

      if (Number.isFinite(minX)) return { minX, maxX, minY, maxY, minZ, maxZ };
    }
  }

  return null;
}

function computeOpeningDimensions(bounds) {
  const sizeX = bounds.maxX - bounds.minX;
  const sizeY = bounds.maxY - bounds.minY;
  const sizeZ = bounds.maxZ - bounds.minZ;
  return {
    height: sizeZ.toFixed(4), // Z is vertical in IFC
    width: Math.max(sizeX, sizeY).toFixed(4),
  };
}

/**
 * Rewrite an entity line to change its IFC type.
 */
export function rewriteEntityType(entity, toType, lines, targetId = null) {
  const fromEntry = catalog.byType.get(entity.type);
  const toEntry   = catalog.byType.get(toType);

  if (!fromEntry || fromEntry.tier === 'unsupported') {
    throw new Error(`Source type ${entity.type} is not reclassifiable`);
  }
  if (!toEntry || toEntry.tier === 'unsupported') {
    throw new Error(`Target type ${toType} is not supported`);
  }

  const args = entity.args;

  // For both 'standard' (9 attrs) and 'opening' (13 attrs), the first 8
  // attrs are identical: GlobalId, OwnerHistory, Name, Description,
  // ObjectType, ObjectPlacement, Representation, Tag.
  const commonArgs = enrichCommonArgs(args.slice(0, 8), fromEntry, toEntry, targetId);

  if (toEntry.tier === 'standard') {
    const predefined = toEntry.predefined ?? STANDARD_FALLBACK_PREDEFINED;
    return `${toType}(${[...commonArgs, predefined].join(',')});`;
  }

  // toEntry.tier === 'opening' → 13 attrs
  const bounds = getElementBoundsFromIfc(lines, args);
  let height = '2.1', width = '0.9';
  if (bounds) {
    const dims = computeOpeningDimensions(bounds);
    height = dims.height;
    width = dims.width;
  }

  const predefined = toEntry.predefined ?? '.NOTDEFINED.';
  const newArgs = [
    ...commonArgs,
    height,
    width,
    predefined,
    OPENING_THIRD_ATTR,
    '$',
  ];
  return `${toType}(${newArgs.join(',')});`;
}

/**
 * Apply a list of edits to an IFC text and return the new text + a report.
 *
 * @param {string} ifcText
 * @param {Array<{localId: number, toType: string}>} edits
 * @returns {{ ifcText, applied, errors }}
 */
export function applyReclassifications(ifcText, edits) {
  const lines = ifcText.split('\n');
  const appender = makeAppender(lines);
  const classificationCache = new Map();
  let applied = 0;
  const errors = [];

  for (const edit of edits) {
    try {
      const targetId = Number(edit.localId);
      const toType = String(edit.toType).toUpperCase();

      let foundIdx = -1;
      const prefix = `#${targetId}=`;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(prefix)) { foundIdx = i; break; }
      }
      if (foundIdx < 0) {
        errors.push({ localId: targetId, error: 'entity not found' });
        continue;
      }

      const m = lines[foundIdx].match(/^#(\d+)=([A-Z0-9_]+)\(([\s\S]*)\);$/);
      if (!m) {
        errors.push({ localId: targetId, error: 'malformed entity line' });
        continue;
      }

      const entity = { type: m[2], args: splitIfcArgs(m[3]) };

      if (entity.type === toType) continue; // no-op

      const toEntry = catalog.byType.get(toType);
      const originalArgs = [...entity.args];
      cleanupOldMetadataForTarget(lines, targetId);
      const newBody = rewriteEntityType(entity, toType, lines, targetId);
      // newBody starts with "TYPE(...);". We prepend "#id=" to form the full line.
      lines[foundIdx] = `#${targetId}=${newBody}`;
      applyMetadataForReclassification(lines, appender, targetId, originalArgs, toEntry, classificationCache);
      applied += 1;
    } catch (err) {
      errors.push({ localId: edit.localId, error: err.message || String(err) });
    }
  }

  return { ifcText: lines.filter((line) => line !== null).join('\n'), applied, errors };
}

// Re-export catalog API for convenience
export { IFC_TYPES, buildIfcCatalog, filterCatalog, reclassifiableTypeNames } from './ifc-catalog.js';
