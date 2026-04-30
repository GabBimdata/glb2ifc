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

import { buildIfcCatalog, IFC_TYPES } from './ifc-catalog.js';

const catalog = buildIfcCatalog();

const STANDARD_FALLBACK_PREDEFINED = '.NOTDEFINED.';
const OPENING_THIRD_ATTR = '.NOTDEFINED.'; // OperationType / PartitioningType

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
    if (lines[i].startsWith(target)) {
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
export function rewriteEntityType(entity, toType, lines) {
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
  const commonArgs = args.slice(0, 8);

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

      const newBody = rewriteEntityType(entity, toType, lines);
      // newBody starts with "TYPE(...);". We prepend "#id=" to form the full line.
      lines[foundIdx] = `#${targetId}=${newBody}`;
      applied += 1;
    } catch (err) {
      errors.push({ localId: edit.localId, error: err.message || String(err) });
    }
  }

  return { ifcText: lines.join('\n'), applied, errors };
}

// Re-export catalog API for convenience
export { IFC_TYPES, buildIfcCatalog, filterCatalog, reclassifiableTypeNames } from './ifc-catalog.js';
