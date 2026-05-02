import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import { openTypePicker } from './ifc-type-picker.js';
import { getProject, updateProject, findProjectForIfcFile, setLastProjectId, getLastProjectId, editsMapToArray, editsArrayToMap, textToIfcFile } from './project-store.js';

const container = document.getElementById("container");
const dropzone = document.getElementById("dropzone");
const input = document.getElementById("ifc-input");
const statusBox = document.getElementById("status");
const resetButton = document.getElementById("reset-camera");
const clearButton = document.getElementById("clear-model");
const isolateButton = document.getElementById("isolate-selection");
const tree = document.getElementById("tree");
const propertiesPanel = document.getElementById("properties");
const treeTabs = [...document.querySelectorAll(".tree-tab")];
const editModeButton = document.getElementById("edit-mode-button");
const exportEditedButton = document.getElementById("export-edited");
const resetEditsButton = document.getElementById("reset-edits");
const editCountEl = document.getElementById("edit-count");
const reloadEditedButton = document.getElementById("reload-edited");
const modelerButton = document.getElementById("modeler-button");

const state = {
  components: null,
  world: null,
  fragments: null,
  ifcLoader: null,
  caster: null,
  lastModelObject: null,
  activeModel: null,
  activeTreeTab: "spatial",
  initialized: false,
  pointerDown: null,
  currentSelection: null,
  itemDataCache: new Map(),
  ifcIndex: null,
  currentFileName: "",
  hider: null,
  hiddenIds: new Set(),
  selectedIds: [],
  isolateActive: false,
  isolatedIds: [],
  selectableIds: [],
  editMode: false,
  pendingEdits: new Map(),       // localId -> { fromType, toType }
  lastIfcText: null,             // texte brut du dernier IFC chargé
  ifcCatalog: null,  // { types, categories } from /api/ifc-catalog
  lastEditedBlobUrl: null,
  projectId: null,
  project: null,
  restoringProjectEdits: false,
};

let projectPersistTimer = null;

const selectionColor = new THREE.Color("#ffd166");

const itemConfig = {
  data: {
    attributesDefault: true,
    relations: {
      IsDefinedBy: { attributes: true, relations: true },
      DefinesOccurrence: { attributes: false, relations: false },
      IsTypedBy: { attributes: true, relations: true },
      HasAssociations: { attributes: true, relations: true },
      ContainsElements: { attributes: true, relations: false },
      IsDecomposedBy: { attributes: true, relations: false },
      Decomposes: { attributes: true, relations: false },
    },
  },
};

function setStatus(message, type = "") {
  statusBox.className = `status ${type}`;
  statusBox.textContent = message;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function attrValue(value) {
  if (value == null) return "";

  if (typeof value === "object") {
    if ("value" in value) return attrValue(value.value);
    if ("type" in value && "value" in value) return attrValue(value.value);
    if (Array.isArray(value)) return value.map(attrValue).filter(Boolean).join(", ");
    return "";
  }

  return String(value);
}

function localIdOf(item) {
  const candidates = [
    item?.localId,
    item?.localID,
    item?.expressID,
    item?.expressId,
    item?.id,
    item?.ID,
    item?._localId,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }

  return NaN;
}

function itemCategory(item) {
  return item?.category || item?.type || item?.Type || item?.class || item?.Class || item?.ifcType || "IFC";
}

function itemName(item) {
  return (
    attrValue(item?.Name) ||
    attrValue(item?.name) ||
    attrValue(item?.LongName) ||
    attrValue(item?.longName) ||
    attrValue(item?.ObjectType) ||
    attrValue(item?.GlobalId) ||
    (Number.isFinite(localIdOf(item)) ? `#${localIdOf(item)}` : "")
  );
}

function prettyIfcType(type) {
  const raw = String(type || "IFC").toUpperCase();

  if (!raw.startsWith("IFC")) return raw;

  const body = raw
    .slice(3)
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_, sep, char) => sep + char.toUpperCase());

  return `Ifc${body}`;
}

function cacheKey(modelId, localId) {
  return `${modelId}:${localId}`;
}

async function getItemData(model, localId) {
  if (!model || !Number.isFinite(Number(localId))) return null;

  const key = cacheKey(model.modelId, localId);
  if (state.itemDataCache.has(key)) {
    return state.itemDataCache.get(key);
  }

  const parsedEntity = state.ifcIndex?.entities?.get(Number(localId));
  let fragmentData = null;

  try {
    const [data] = await model.getItemsData([Number(localId)], itemConfig);
    fragmentData = data || null;
  } catch (error) {
    console.warn(`Could not read item data for #${localId}`, error);
  }

  const parsedData = parsedEntityToItem(parsedEntity);
  const resolved = parsedData
    ? { ...(fragmentData || {}), ...parsedData }
    : fragmentData;

  state.itemDataCache.set(key, resolved);
  return resolved;
}

// ─────────────────────────────────────────────────────────────
// IFC text parser for BIMData-like tree
// ─────────────────────────────────────────────────────────────

function splitIfcArgs(text) {
  const args = [];
  let current = "";
  let depth = 0;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === "'") {
      current += char;

      if (inString && text[i + 1] === "'") {
        current += text[i + 1];
        i++;
      } else {
        inString = !inString;
      }

      continue;
    }

    if (!inString && char === "(") {
      depth++;
      current += char;
      continue;
    }

    if (!inString && char === ")") {
      depth--;
      current += char;
      continue;
    }

    if (!inString && depth === 0 && char === ",") {
      args.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) args.push(current.trim());
  return args;
}

function parseIfcString(arg) {
  if (!arg || arg === "$" || arg === "*") return "";

  const trimmed = String(arg).trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }

  return "";
}

function parseIfcRef(arg) {
  const match = String(arg || "").match(/#(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseIfcRefs(arg) {
  return [...String(arg || "").matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function normalizeIfcName(name) {
  const value = String(name || "").trim();
  if (!value || value === "$" || value === "*") return "";
  if (/^#\??$/.test(value)) return "";
  return value;
}

function parseIfcValue(arg) {
  if (!arg || arg === "$" || arg === "*") return "";
  const text = String(arg).trim();

  if (text === ".T.") return "true";
  if (text === ".F.") return "false";
  if (/^\.[A-Z0-9_]+\.$/.test(text)) return text.slice(1, -1);

  const typed = text.match(/^([A-Z0-9_]+)\(([\s\S]*)\)$/i);
  if (typed) {
    const inner = typed[2].trim();
    if (inner.startsWith("'") && inner.endsWith("'")) return parseIfcString(inner);
    if (inner === ".T.") return "true";
    if (inner === ".F.") return "false";
    if (/^\.[A-Z0-9_]+\.$/.test(inner)) return inner.slice(1, -1);
    return inner;
  }

  if (text.startsWith("'") && text.endsWith("'")) return parseIfcString(text);
  return text;
}

function parsePropertyEntity(entity) {
  if (!entity) return null;

  if (entity.type === "IFCPROPERTYSINGLEVALUE") {
    return {
      name: parseIfcString(entity.rawArgs[0]) || `#${entity.id}`,
      value: parseIfcValue(entity.rawArgs[2]),
      type: "Property",
    };
  }

  return null;
}

function parseQuantityEntity(entity) {
  if (!entity) return null;

  const quantityTypes = new Set([
    "IFCQUANTITYLENGTH",
    "IFCQUANTITYAREA",
    "IFCQUANTITYVOLUME",
    "IFCQUANTITYCOUNT",
    "IFCQUANTITYWEIGHT",
    "IFCQUANTITYTIME",
  ]);

  if (!quantityTypes.has(entity.type)) return null;

  return {
    name: parseIfcString(entity.rawArgs[0]) || `#${entity.id}`,
    value: parseIfcValue(entity.rawArgs[3]),
    type: prettyIfcType(entity.type),
  };
}

function parsePsetOrQto(entity, entities) {
  if (!entity) return null;

  if (entity.type === "IFCPROPERTYSET") {
    const name = parseIfcString(entity.rawArgs[2]) || `PropertySet #${entity.id}`;
    const propertyIds = parseIfcRefs(entity.rawArgs[4]);
    return {
      id: entity.id,
      kind: "pset",
      name,
      rows: propertyIds.map((id) => parsePropertyEntity(entities.get(id))).filter(Boolean),
    };
  }

  if (entity.type === "IFCELEMENTQUANTITY") {
    const name = parseIfcString(entity.rawArgs[2]) || `ElementQuantity #${entity.id}`;
    const quantityIds = parseIfcRefs(entity.rawArgs[5]);
    return {
      id: entity.id,
      kind: "qto",
      name,
      rows: quantityIds.map((id) => parseQuantityEntity(entities.get(id))).filter(Boolean),
    };
  }

  return null;
}

function parseClassificationReference(entity, entities) {
  if (!entity || entity.type !== "IFCCLASSIFICATIONREFERENCE") return null;

  const identification = parseIfcString(entity.rawArgs[1]);
  const name = parseIfcString(entity.rawArgs[2]);
  const referencedSourceId = parseIfcRef(entity.rawArgs[3]);
  const source = referencedSourceId ? entities.get(referencedSourceId) : null;
  const sourceName = source?.type === "IFCCLASSIFICATION"
    ? parseIfcString(source.rawArgs[3]) || parseIfcString(source.rawArgs[4]) || "Classification"
    : "Classification";

  return {
    id: entity.id,
    source: sourceName,
    identification,
    name,
  };
}

function addMapArrayValue(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function uniqueById(items) {
  const seen = new Set();
  const out = [];

  for (const item of items || []) {
    const id = item?.id ?? JSON.stringify(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }

  return out;
}

function collectElementRepresentationRefs(entity, entities) {
  if (!entity || !isDisplayableIfcElement(entity)) return [];

  const productShapeId = parseIfcRef(entity.rawArgs[6]);
  if (!productShapeId) return [];

  const productShape = entities.get(productShapeId);
  if (!productShape || productShape.type !== "IFCPRODUCTDEFINITIONSHAPE") {
    return [productShapeId];
  }

  const shapeReps = parseIfcRefs(productShape.rawArgs[2]);
  return [productShapeId, ...shapeReps];
}

function buildRepresentationToElements(entities) {
  const representationToElements = new Map();

  for (const entity of entities.values()) {
    if (!isDisplayableIfcElement(entity)) continue;

    const refs = collectElementRepresentationRefs(entity, entities);
    for (const ref of refs) {
      addMapArrayValue(representationToElements, ref, entity.id);
    }
  }

  return representationToElements;
}

function parseLayerAssignment(entity, representationToElements) {
  if (!entity || entity.type !== "IFCPRESENTATIONLAYERASSIGNMENT") return null;

  const name = parseIfcString(entity.rawArgs[0]) || `Layer #${entity.id}`;
  const description = parseIfcString(entity.rawArgs[1]);
  const identifier = parseIfcString(entity.rawArgs[3]);
  const assignedItemIds = parseIfcRefs(entity.rawArgs[2]);

  const elementIds = new Set();

  for (const assignedId of assignedItemIds) {
    const mapped = representationToElements.get(assignedId);
    if (mapped?.length) {
      mapped.forEach((id) => elementIds.add(id));
    }
  }

  return {
    id: entity.id,
    name,
    description,
    identifier,
    elementIds: [...elementIds],
  };
}

function parseIfcText(text, fileName = "") {
  const entities = new Map();
  const aggregates = new Map();
  const contained = new Map();
  const psetsByElement = new Map();
  const qtosByElement = new Map();
  const classificationsByElement = new Map();
  const layersByElement = new Map();
  const elementsByLayer = new Map();

  const entityRegex = /#(\d+)=([A-Z0-9_]+)\(([\s\S]*?)\);/g;
  let match;

  while ((match = entityRegex.exec(text))) {
    const id = Number(match[1]);
    const type = match[2].toUpperCase();
    const args = splitIfcArgs(match[3]);

    entities.set(id, {
      id,
      localId: id,
      expressID: id,
      category: type,
      type,
      rawArgs: args,
      GlobalId: parseIfcString(args[0]),
      Name: parseIfcString(args[2]),
      Description: parseIfcString(args[3]),
      ObjectType: parseIfcString(args[4]),
      Tag: parseIfcString(args[7]),
    });
  }

  for (const entity of entities.values()) {
    if (entity.type === "IFCRELAGGREGATES") {
      const parent = parseIfcRef(entity.rawArgs[4]);
      const children = parseIfcRefs(entity.rawArgs[5]);
      if (parent && children.length) {
        if (!aggregates.has(parent)) aggregates.set(parent, []);
        aggregates.get(parent).push(...children);
      }
    }

    if (entity.type === "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
      const elements = parseIfcRefs(entity.rawArgs[4]);
      const structure = parseIfcRef(entity.rawArgs[5]);
      if (structure && elements.length) {
        if (!contained.has(structure)) contained.set(structure, []);
        contained.get(structure).push(...elements);
      }
    }

    if (entity.type === "IFCRELDEFINESBYPROPERTIES") {
      const relatedObjects = parseIfcRefs(entity.rawArgs[4]);
      const psetOrQto = parsePsetOrQto(entities.get(parseIfcRef(entity.rawArgs[5])), entities);
      if (psetOrQto) {
        for (const objectId of relatedObjects) {
          const target = psetOrQto.kind === "qto" ? qtosByElement : psetsByElement;
          if (!target.has(objectId)) target.set(objectId, []);
          target.get(objectId).push(psetOrQto);
        }
      }
    }

    if (entity.type === "IFCRELASSOCIATESCLASSIFICATION") {
      const relatedObjects = parseIfcRefs(entity.rawArgs[4]);
      const classification = parseClassificationReference(entities.get(parseIfcRef(entity.rawArgs[5])), entities);
      if (classification) {
        for (const objectId of relatedObjects) {
          if (!classificationsByElement.has(objectId)) classificationsByElement.set(objectId, []);
          classificationsByElement.get(objectId).push(classification);
        }
      }
    }
  }

  const representationToElements = buildRepresentationToElements(entities);

  for (const entity of entities.values()) {
    if (entity.type !== "IFCPRESENTATIONLAYERASSIGNMENT") continue;

    const layer = parseLayerAssignment(entity, representationToElements);
    if (!layer || !layer.elementIds.length) continue;

    if (!elementsByLayer.has(layer.name)) {
      elementsByLayer.set(layer.name, {
        name: layer.name,
        description: layer.description,
        identifier: layer.identifier,
        elementIds: [],
      });
    }

    const layerGroup = elementsByLayer.get(layer.name);
    layerGroup.elementIds.push(...layer.elementIds);

    for (const elementId of layer.elementIds) {
      addMapArrayValue(layersByElement, elementId, {
        id: layer.id,
        name: layer.name,
        description: layer.description,
        identifier: layer.identifier,
      });
    }
  }

  for (const layer of elementsByLayer.values()) {
    layer.elementIds = uniqueIds(layer.elementIds);
  }

  for (const [elementId, layers] of layersByElement.entries()) {
    layersByElement.set(elementId, uniqueById(layers));
  }

  const project = [...entities.values()].find((entity) => entity.type === "IFCPROJECT") || null;

  return {
    fileName,
    entities,
    aggregates,
    contained,
    psetsByElement,
    qtosByElement,
    classificationsByElement,
    layersByElement,
    elementsByLayer,
    projectId: project?.id || null,
  };
}

function ifcEntityName(entity, fallback = "") {
  if (!entity) return fallback;

  const name = normalizeIfcName(entity.Name);
  if (name && !/^(project|site|building)$/i.test(name)) {
    return name;
  }

  return fallback || name || prettyIfcType(entity.type);
}

function ifcSpatialName(entity, index) {
  if (!entity) return "";

  if (entity.type === "IFCPROJECT") {
    const name = normalizeIfcName(entity.Name);
    if (name && !/^project$/i.test(name)) return name;
    return index.fileName || "Project";
  }

  if (entity.type === "IFCSITE") return ifcEntityName(entity, "Site");
  if (entity.type === "IFCBUILDING") return ifcEntityName(entity, "Building");
  if (entity.type === "IFCBUILDINGSTOREY") return ifcEntityName(entity, "Storey");

  return ifcEntityName(entity, prettyIfcType(entity.type));
}

function ifcElementName(entity) {
  if (!entity) return "";

  return (
    normalizeIfcName(entity.Name) ||
    normalizeIfcName(entity.ObjectType) ||
    normalizeIfcName(entity.Tag) ||
    normalizeIfcName(entity.GlobalId) ||
    `#${entity.id}`
  );
}

function isIfcSpatialType(type) {
  return ["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY"].includes(String(type).toUpperCase());
}

function isDisplayableIfcElement(entity) {
  if (!entity) return false;
  if (!entity.type.startsWith("IFC")) return false;
  if (isIfcSpatialType(entity.type)) return false;
  if (entity.type.startsWith("IFCREL")) return false;
  if (entity.type.startsWith("IFCPROPERTY")) return false;
  if (entity.type.startsWith("IFCQUANTITY")) return false;
  if (entity.type.includes("REPRESENTATION")) return false;
  if (entity.type.includes("STYLE")) return false;
  if (entity.type.includes("PLACEMENT")) return false;
  if (entity.type.includes("DIRECTION")) return false;
  if (entity.type.includes("CARTESIAN")) return false;
  if (entity.type.includes("OWNERHISTORY")) return false;
  if (entity.type.includes("UNIT")) return false;
  if (entity.type.includes("CLASSIFICATION")) return false;
  if (entity.type === "IFCMATERIAL") return false;
  if (entity.type === "IFCLOCALPLACEMENT") return false;
  if (entity.type === "IFCTRIANGULATEDFACESET") return false;

  return true;
}

function uniqueIds(ids) {
  return [...new Set((ids || []).filter((id) => Number.isFinite(Number(id))))];
}

function ifcChildren(index, id) {
  return uniqueIds(index.aggregates.get(id) || [])
    .map((childId) => index.entities.get(childId))
    .filter(Boolean);
}

function ifcContainedElements(index, storeyId) {
  const containedIds = uniqueIds(index.contained.get(storeyId) || []);
  const aggregateIds = uniqueIds(index.aggregates.get(storeyId) || []);

  // In our generated IFC, IfcSpace is aggregated under IfcBuildingStorey.
  // BIM viewers often show it under the storey alongside contained elements.
  const ids = uniqueIds([...containedIds, ...aggregateIds]);

  return ids
    .map((id) => index.entities.get(id))
    .filter(isDisplayableIfcElement);
}

function groupIfcEntitiesByType(entities) {
  const groups = new Map();

  for (const entity of entities) {
    if (!groups.has(entity.type)) groups.set(entity.type, []);
    groups.get(entity.type).push(entity);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, items]) => ({
      category: type,
      label: prettyIfcType(type),
      items: items.sort((a, b) => ifcElementName(a).localeCompare(ifcElementName(b))),
    }));
}

function isElementVisible(id) {
  return !state.hiddenIds.has(Number(id));
}

function visibilityCheckboxHtml(ids, className = "visibility-checkbox") {
  const cleanIds = uniqueIds(ids).join(",");
  const checked = uniqueIds(ids).every((id) => isElementVisible(id));

  return `<input class="${className}" type="checkbox" data-visibility-ids="${escapeHtml(cleanIds)}" ${checked ? "checked" : ""} title="Afficher / masquer" />`;
}

function nodeHiddenClass(ids) {
  const cleanIds = uniqueIds(ids);
  return cleanIds.length && cleanIds.every((id) => !isElementVisible(id)) ? " hidden-node" : "";
}

function groupClassificationsByReference(index) {
  const groups = new Map();

  for (const [elementId, classifications] of index.classificationsByElement.entries()) {
    for (const classification of classifications) {
      const key = [
        classification.source || "Classification",
        classification.identification || "",
        classification.name || "",
      ].join("::");

      if (!groups.has(key)) {
        groups.set(key, {
          label: [classification.identification, classification.name].filter(Boolean).join(" · ") || classification.source || "Classification",
          source: classification.source || "Classification",
          items: [],
        });
      }

      const entity = index.entities.get(elementId);
      if (entity && isDisplayableIfcElement(entity)) {
        groups.get(key).items.push(entity);
      }
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: uniqueById(group.items).sort((a, b) => ifcElementName(a).localeCompare(ifcElementName(b))),
    }))
    .filter((group) => group.items.length)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function renderIfcClassificationTree(index) {
  const groups = groupClassificationsByReference(index);

  if (!groups.length) {
    return '<div class="tree-empty">Aucune classification trouvée dans ce fichier.</div>';
  }

  return groups.map((group) => {
    const ids = group.items.map((item) => item.id);
    return `
      <details class="tree-node type-group${nodeHiddenClass(ids)}">
        <summary data-selection-ids="${escapeHtml(ids.join(","))}" data-model-id="${escapeHtml(state.activeModel?.modelId || "")}">
          ${visibilityCheckboxHtml(ids)}
          <span class="twisty">›</span>
          <span class="tree-label">${escapeHtml(group.label)}</span>
          <span class="tree-type">${escapeHtml(group.source)}</span>
          <span class="tree-count">${group.items.length}</span>
        </summary>
        <div class="tree-children">
          ${group.items.map((entity) => renderIfcElementNode(entity)).join("")}
        </div>
      </details>
    `;
  }).join("");
}

function renderIfcLayerTree(index) {
  const layers = [...index.elementsByLayer.values()]
    .filter((layer) => layer.elementIds.length)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!layers.length) {
    return '<div class="tree-empty">Aucun IfcPresentationLayerAssignment trouvé.</div>';
  }

  return layers.map((layer) => {
    const entities = layer.elementIds
      .map((id) => index.entities.get(id))
      .filter(isDisplayableIfcElement)
      .sort((a, b) => ifcElementName(a).localeCompare(ifcElementName(b)));

    const ids = entities.map((entity) => entity.id);

    return `
      <details class="tree-node type-group${nodeHiddenClass(ids)}">
        <summary data-selection-ids="${escapeHtml(ids.join(","))}" data-model-id="${escapeHtml(state.activeModel?.modelId || "")}">
          ${visibilityCheckboxHtml(ids)}
          <span class="twisty">›</span>
          <span class="tree-label">${escapeHtml(layer.name)}</span>
          <span class="tree-type">${escapeHtml(layer.identifier || "Layer")}</span>
          <span class="tree-count">${entities.length}</span>
        </summary>
        <div class="tree-children">
          ${entities.map((entity) => renderIfcElementNode(entity)).join("")}
        </div>
      </details>
    `;
  }).join("");
}

async function setElementVisibility(ids, visible) {
  const cleanIds = uniqueIds(ids);
  if (!cleanIds.length || !state.activeModel || !state.hider) return;

  const modelIdMap = { [state.activeModel.modelId]: new Set(cleanIds) };

  try {
    await state.hider.set(Boolean(visible), modelIdMap);

    for (const id of cleanIds) {
      if (visible) state.hiddenIds.delete(id);
      else state.hiddenIds.add(id);
    }

    if (!visible && state.currentSelection && cleanIds.some((id) => state.selectedIds.includes(id))) {
      clearSelection();
    }

    if (visible && state.isolateActive) {
      state.isolateActive = false;
      state.isolatedIds = [];
    }

    syncVisibilityCheckboxes();
    state.fragments?.core.update(true);
  } catch (error) {
    console.warn("Visibility change failed:", error);
    setStatus(`Impossible de changer la visibilité : ${error.message || error}`, "error");
  }
}

function syncVisibilityCheckboxes() {
  tree.querySelectorAll(".visibility-checkbox").forEach((checkbox) => {
    const ids = parseVisibilityIds(checkbox);
    const visibleCount = ids.filter((id) => isElementVisible(id)).length;

    checkbox.checked = visibleCount === ids.length;
    checkbox.indeterminate = visibleCount > 0 && visibleCount < ids.length;

    const node = checkbox.closest(".tree-node");
    if (node) {
      node.classList.toggle("hidden-node", ids.length > 0 && visibleCount === 0);
    }
  });
}

function parseVisibilityIds(checkbox) {
  return String(checkbox.dataset.visibilityIds || "")
    .split(",")
    .map((value) => Number(value))
    .filter(Number.isFinite);
}

function allDisplayableIfcElementIds(index) {
  if (!index) return [];

  return [...index.entities.values()]
    .filter(isDisplayableIfcElement)
    .map((entity) => entity.id);
}

function storeyElementIds(index, storeyId) {
  if (!index) return [];
  return ifcContainedElements(index, storeyId).map((entity) => entity.id);
}

function selectionIdsFromSummary(summary) {
  if (!summary) return [];

  const ids = summary.dataset.selectionIds
    ? summary.dataset.selectionIds.split(",").map((value) => Number(value)).filter(Number.isFinite)
    : [];

  if (ids.length) return uniqueIds(ids);

  const localId = Number(summary.dataset.localId);
  return Number.isFinite(localId) ? [localId] : [];
}

function updateSelectionButtons() {
  const hasSelection = state.selectedIds.length > 0;

  isolateButton.disabled = !hasSelection || !state.activeModel;
  resetButton.disabled = !state.activeModel;
  clearButton.disabled = !state.activeModel;

  isolateButton.classList.toggle("active", state.isolateActive);
}

function currentSelectionModelId() {
  return state.currentSelection?.modelId || state.activeModel?.modelId;
}

function renderIfcSpatialTree(index) {
  const project =
    (index.projectId && index.entities.get(index.projectId)) ||
    [...index.entities.values()].find((entity) => entity.type === "IFCPROJECT");

  if (!project) {
    return '<div class="tree-empty">Aucun IfcProject trouvé dans ce fichier.</div>';
  }

  return renderIfcSpatialNode(index, project, { root: true, storeyIndex: { value: 0 } });
}

function renderIfcSpatialNode(index, entity, options = {}) {
  if (!entity) return "";

  if (entity.type === "IFCBUILDINGSTOREY") {
    return renderIfcStoreyNode(index, entity, options);
  }

  const children = ifcChildren(index, entity.id).filter((child) => isIfcSpatialType(child.type));
  const isOpen = options.root || entity.type === "IFCPROJECT" || entity.type === "IFCSITE" || entity.type === "IFCBUILDING";

  return `
    <details class="tree-node" ${isOpen ? "open" : ""}>
      <summary data-local-id="${entity.id}" data-model-id="${escapeHtml(state.activeModel?.modelId || "")}">
        <span class="twisty">${children.length ? "›" : "·"}</span>
        <span class="tree-label">${escapeHtml(ifcSpatialName(entity, index))}</span>
        <span class="tree-type">${escapeHtml(prettyIfcType(entity.type))}</span>
      </summary>
      ${children.length ? `<div class="tree-children">${children.map((child) => renderIfcSpatialNode(index, child, options)).join("")}</div>` : ""}
    </details>
  `;
}

function renderIfcStoreyNode(index, entity, options = {}) {
  const elements = ifcContainedElements(index, entity.id);
  const groups = groupIfcEntitiesByType(elements);
  const ids = elements.map((item) => item.id);
  const currentStoreyIndex = options.storeyIndex?.value ?? 0;
  if (options.storeyIndex) options.storeyIndex.value += 1;

  const isOpen = currentStoreyIndex === 0;

  return `
    <details class="tree-node${nodeHiddenClass(ids)}" ${isOpen ? "open" : ""}>
      <summary data-local-id="${entity.id}" data-model-id="${escapeHtml(state.activeModel?.modelId || "")}" data-selection-ids="${escapeHtml(ids.join(","))}">
        ${visibilityCheckboxHtml(ids)}
        <span class="twisty">${groups.length ? "›" : "·"}</span>
        <span class="tree-label">${escapeHtml(ifcSpatialName(entity, index))}</span>
        <span class="tree-type">Storey</span>
      </summary>
      <div class="tree-children">
        ${groups.length ? groups.map((group) => renderIfcGroup(group)).join("") : '<div class="tree-empty">Aucun élément contenu dans cet étage.</div>'}
      </div>
    </details>
  `;
}

function renderIfcGroup(group) {
  const ids = group.items.map((entity) => entity.id);

  return `
    <details class="tree-node type-group${nodeHiddenClass(ids)}">
      <summary data-selection-ids="${escapeHtml(ids.join(","))}" data-model-id="${escapeHtml(state.activeModel?.modelId || "")}">
        ${visibilityCheckboxHtml(ids)}
        <span class="twisty">›</span>
        <span class="tree-label">${escapeHtml(group.label)}</span>
        <span class="tree-count">${group.items.length}</span>
      </summary>
      <div class="tree-children">
        ${group.items.map((entity) => renderIfcElementNode(entity)).join("")}
      </div>
    </details>
  `;
}

function renderIfcElementNode(entity) {
  const ids = [entity.id];

  return `
    <details class="tree-node element-node${nodeHiddenClass(ids)}">
      <summary data-local-id="${entity.id}" data-model-id="${escapeHtml(state.activeModel?.modelId || "")}">
        ${visibilityCheckboxHtml(ids)}
        <span class="twisty">·</span>
        <span class="tree-label">${escapeHtml(ifcElementName(entity))}</span>
        <span class="tree-type">${escapeHtml(prettyIfcType(entity.type))}</span>
      </summary>
    </details>
  `;
}

function renderIfcTypeTree(index) {
  const elements = [...index.entities.values()].filter(isDisplayableIfcElement);
  const groups = groupIfcEntitiesByType(elements);

  if (!groups.length) {
    return '<div class="tree-empty">Aucun objet IFC listable trouvé.</div>';
  }

  return groups.map((group) => renderIfcGroup(group)).join("");
}

function parsedEntityToItem(entity) {
  if (!entity) return null;

  return {
    localId: entity.id,
    expressID: entity.id,
    category: entity.type,
    type: entity.type,
    GlobalId: entity.GlobalId,
    Name: entity.Name,
    Description: entity.Description,
    ObjectType: entity.ObjectType,
    Tag: entity.Tag,
    classifications: state.ifcIndex?.classificationsByElement?.get(entity.id) || [],
    layers: state.ifcIndex?.layersByElement?.get(entity.id) || [],
    psets: state.ifcIndex?.psetsByElement?.get(entity.id) || [],
    qtos: state.ifcIndex?.qtosByElement?.get(entity.id) || [],
  };
}

// Fallback helpers for .frag files where we don't have the original IFC text.
const spatialContainerTypes = new Set(["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY"]);

function categoryOf(node) {
  return String(itemCategory(node) || "IFC").toUpperCase();
}

function isSpatialContainer(node) {
  return spatialContainerTypes.has(categoryOf(node));
}

function isWrapper(node) {
  const category = categoryOf(node);
  return category === "IFC" || category.startsWith("IFCREL");
}

function isSpatialElement(node) {
  const category = categoryOf(node);
  if (spatialContainerTypes.has(category)) return false;
  if (isWrapper(node)) return false;
  return true;
}

function allChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

function collectElementsUnder(node, output = []) {
  for (const child of allChildren(node)) {
    if (isSpatialElement(child)) output.push(child);
    collectElementsUnder(child, output);
  }
  return output;
}

function groupElementsByType(elements) {
  const groups = new Map();

  for (const element of elements) {
    const category = categoryOf(element);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(element);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, items]) => ({
      category,
      label: prettyIfcType(category),
      items: items.sort((a, b) => itemName(a).localeCompare(itemName(b))),
    }));
}

async function enrichElementsForTree(model, elements) {
  const byId = new Map();

  for (const element of elements) {
    const localId = localIdOf(element);
    if (!Number.isFinite(localId)) continue;
    byId.set(localId, element);
  }

  const ids = [...byId.keys()];
  if (!ids.length) return [];

  let itemData = [];

  try {
    itemData = await model.getItemsData(ids, {
      data: {
        attributesDefault: true,
        relations: {},
      },
    });
  } catch (error) {
    console.warn("Bulk item data read failed, falling back to spatial nodes.", error);
  }

  const enriched = [];

  for (const id of ids) {
    const source = byId.get(id);
    const data = itemData.find((item) => localIdOf(item) === id);
    const merged = {
      ...source,
      ...(data || {}),
      localId: id,
    };

    state.itemDataCache.set(cacheKey(model.modelId, id), merged);
    enriched.push(merged);
  }

  return enriched;
}

async function fitCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);

  if (box.isEmpty()) {
    await state.world.camera.controls.setLookAt(10, 8, 10, 0, 0, 0);
    return;
  }

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim * 1.65;

  await state.world.camera.controls.setLookAt(
    center.x + distance,
    center.y + distance * 0.75,
    center.z + distance,
    center.x,
    center.y,
    center.z,
    true
  );

  state.fragments?.core.update(true);
}

function setupSceneLighting(world) {
  const scene = world.scene.three;

  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambient);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x2a3441, 0.85);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(25, 40, 30);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xc7d2fe, 0.35);
  fillLight.position.set(-25, 20, -20);
  scene.add(fillLight);
}

async function initViewer() {
  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);

  const world = worlds.create();
  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = new THREE.Color(0x0f1419);

  world.renderer = new OBC.SimpleRenderer(components, container);
  world.camera = new OBC.OrthoPerspectiveCamera(components);

  setupSceneLighting(world);

  await world.camera.controls.setLookAt(10, 8, 10, 0, 0, 0);

  components.init();
  components.get(OBC.Grids).create(world);

  const ifcLoader = components.get(OBC.IfcLoader);

  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      path: "https://unpkg.com/web-ifc@0.0.77/",
      absolute: true,
    },
  });

  const workerUrl = await OBC.FragmentsManager.getWorker();
  const fragments = components.get(OBC.FragmentsManager);
  fragments.init(workerUrl);

  world.camera.controls.addEventListener("update", () => fragments.core.update());

fragments.list.onItemSet.add(async ({ value: model }) => {
  model.useCamera(world.camera.three);
  world.scene.three.add(model.object);

  state.activeModel = model;
  state.lastModelObject = model.object;

  fragments.core.update(true);
  await fitCameraToObject(model.object);
  await buildTree();

  // Les objets Fragments ne sont pas toujours prêts immédiatement.
  // On attend deux frames avant de créer les edges.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      addEdgesToObject(model.object);
      fragments.core.update(true);
    });
  });
});

  fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
   if (!("isLodMaterial" in material && material.isLodMaterial)) {
     material.polygonOffset = true;
     material.polygonOffsetUnits = 1;
     material.polygonOffsetFactor = Math.random();

     material.side = THREE.DoubleSide;

     if ("roughness" in material) material.roughness = 0.78;
     if ("metalness" in material) material.metalness = 0.04;
     if ("envMapIntensity" in material) material.envMapIntensity = 0.7;
     if ("aoMapIntensity" in material) material.aoMapIntensity = 1.4;

     material.needsUpdate = true;
  }
});

  const casters = components.get(OBC.Raycasters);
  const caster = casters.get(world);
  const hider = components.get(OBC.Hider);

  state.components = components;
  state.world = world;
  state.fragments = fragments;
  state.ifcLoader = ifcLoader;
  state.caster = caster;
  state.hider = hider;
  state.initialized = true;

  setupPicking();
  setStatus("Viewer prêt. Dépose un fichier .ifc.", "ok");
  await loadProjectFromUrl();
}

function setupPicking() {
  container.addEventListener("pointerdown", (event) => {
    state.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
  });

  container.addEventListener("pointerup", async (event) => {
    if (!state.pointerDown || !state.activeModel) return;

    const dx = Math.abs(event.clientX - state.pointerDown.x);
    const dy = Math.abs(event.clientY - state.pointerDown.y);
    const dt = performance.now() - state.pointerDown.time;

    if (dx > 4 || dy > 4 || dt > 450) return;

    try {
      const result = await state.caster.castRay();
      if (!result) return;

      const modelId = result.fragments.modelId;
      const localId = Number(result.localId);

      // Si Ctrl/Cmd est enfoncé → étend la sélection
      if (event.ctrlKey || event.metaKey) {
        const current = new Set(state.selectedIds);

        if (current.has(localId)) {
          current.delete(localId);
        } else {
          current.add(localId);
        }

        await selectElements(modelId, [...current]);
      } else {
        await selectElement(modelId, localId);
      }
    } catch (error) {
      console.warn("Picking failed:", error);
    }
  });
}

function clearSelection() {
  state.currentSelection = null;
  state.selectedIds = [];
  tree.querySelectorAll("summary.selected").forEach((item) => item.classList.remove("selected"));
  propertiesPanel.innerHTML = '<div class="properties-empty">Aucun élément sélectionné.</div>';

  try {
    state.fragments?.resetHighlight?.();
    state.fragments?.core.update(true);
  } catch (error) {
    console.warn("Clear highlight failed:", error);
  }

  updateSelectionButtons();
}

async function clearModels() {
  if (!state.fragments) return;

  const models = [...state.fragments.list.values()];
  for (const model of models) {
    removeEdgesFromObject();
    state.world.scene.three.remove(model.object);
    model.dispose?.();
  }

  state.fragments.list.clear?.();
  state.lastModelObject = null;
  state.activeModel = null;
  state.currentSelection = null;
  state.itemDataCache.clear();
  state.hiddenIds.clear();
  state.selectedIds = [];
  state.isolateActive = false;
  state.isolatedIds = [];
  state.selectableIds = [];
  state.ifcIndex = null;
  state.currentFileName = "";
  updateSelectionButtons();

  clearButton.disabled = true;
  resetButton.disabled = true;
  tree.innerHTML = '<div class="tree-empty">Charge un fichier IFC pour afficher la structure spatiale.</div>';
  propertiesPanel.innerHTML = '<div class="properties-empty">Aucun élément sélectionné.</div>';

  await state.fragments.resetHighlight?.();
  state.fragments.core.update(true);

  state.lastIfcText = null;
  state.editMode = false;
  document.body.classList.remove('edit-mode');
  if (editModeButton) {
   editModeButton.classList.remove('active');
   editModeButton.disabled = true;
}
resetPendingEdits();
updateModelerButtonState();
}

function updateModelerButtonState() {
  if (!modelerButton) return;
  // On laisse le bouton actif dès qu’un IFC texte est chargé : si aucun GLB
  // source n’est lié, le handler donne un message clair au lieu de masquer l’action.
  modelerButton.disabled = !state.lastIfcText;
}

async function attachProjectContextForFile(fileName) {
  if (!fileName || !/\.ifc$/i.test(fileName)) {
    updateModelerButtonState();
    return;
  }

  try {
    let project = state.projectId ? await getProject(state.projectId) : null;

    if (!project) {
      project = await findProjectForIfcFile(fileName);
    }

    if (!project) {
      const lastId = getLastProjectId();
      const last = lastId ? await getProject(lastId) : null;
      if (last && last.glbBlob && last.ifcFileName) {
        const a = String(last.ifcFileName).replace(/\.ifc$/i, '').toLowerCase();
        const b = String(fileName).replace(/\.ifc$/i, '').toLowerCase();
        if (a === b || a.replace(/\.edited$/i, '') === b.replace(/\.edited$/i, '')) project = last;
      }
    }

    if (project) {
      state.projectId = project.id;
      state.project = project;
      setLastProjectId(project.id);
      setStatus(`Modèle chargé : ${fileName} · GLB source lié au projet local.`, "ok");
    }
  } catch (error) {
    console.warn("Project context lookup failed:", error);
  }

  updateModelerButtonState();
}

function restorePendingEditsFromProject(project) {
  if (!project?.edits?.length || !state.ifcIndex) return;
  state.restoringProjectEdits = true;
  state.pendingEdits = editsArrayToMap(project.edits, state.ifcIndex);
  state.restoringProjectEdits = false;
  updateEditCount();
  if (state.pendingEdits.size > 0) {
    setStatus(`Modèle chargé : ${state.currentFileName} · ${state.pendingEdits.size} reclassification(s) restaurée(s).`, "ok");
  }
}

function scheduleProjectPersist() {
  if (state.restoringProjectEdits || !state.projectId || !state.lastIfcText) return;
  if (projectPersistTimer) clearTimeout(projectPersistTimer);
  projectPersistTimer = setTimeout(() => {
    projectPersistTimer = null;
    persistCurrentProjectState().catch((error) => console.warn("Project persist failed:", error));
  }, 250);
}

async function persistCurrentProjectState() {
  if (!state.projectId || !state.lastIfcText) return null;
  const updated = await updateProject(state.projectId, {
    ifcText: state.lastIfcText,
    ifcFileName: state.currentFileName || state.project?.ifcFileName || "model.ifc",
    edits: editsMapToArray(state.pendingEdits),
    lastOpenedIn: "viewer",
  });
  state.project = updated;
  return updated;
}

async function ensureLinkedProjectForModeler() {
  let project = state.projectId ? await getProject(state.projectId) : null;

  if (!project && state.currentFileName) {
    project = await findProjectForIfcFile(state.currentFileName);
  }

  if (!project) {
    const last = await getProject(getLastProjectId());
    if (last?.glbBlob) project = last;
  }

  if (!project?.glbBlob) {
    throw new Error("Aucun GLB source n’est lié à cet IFC. Ouvre le viewer depuis le bouton créé après la conversion GLB → IFC, ou recharge l’IFC généré dans le même navigateur.");
  }

  state.projectId = project.id;
  state.project = project;
  setLastProjectId(project.id);
  return project;
}

async function openModelerForCurrentProject() {
  if (!state.lastIfcText) {
    setStatus("Charge un IFC avant de lancer le modeler.", "error");
    return;
  }

  try {
    const project = await ensureLinkedProjectForModeler();
    await updateProject(project.id, {
      ifcText: state.lastIfcText,
      ifcFileName: state.currentFileName || project.ifcFileName || "model.ifc",
      edits: editsMapToArray(state.pendingEdits),
      lastOpenedIn: "viewer",
    });
    window.location.href = `/modeler.html?project=${encodeURIComponent(project.id)}&return=viewer`;
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

async function loadProjectFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("project");
  if (!projectId) return;

  try {
    const project = await getProject(projectId);
    if (!project?.ifcText) throw new Error("Projet local introuvable ou IFC absent.");

    state.projectId = project.id;
    state.project = project;
    setLastProjectId(project.id);

    state.restoringProjectEdits = true;
    await loadFile(textToIfcFile(project.ifcText, project.ifcFileName || "model.ifc"));
    state.restoringProjectEdits = false;

    restorePendingEditsFromProject(project);
    updateModelerButtonState();
  } catch (error) {
    state.restoringProjectEdits = false;
    console.error(error);
    setStatus(`Impossible de charger le projet local : ${error.message || error}`, "error");
  }
}

async function loadFile(file) {
  if (!state.initialized) {
    setStatus("Le viewer n’est pas encore prêt.", "error");
    return;
  }

  const lower = file.name.toLowerCase();

  if (!lower.endsWith(".ifc") && !lower.endsWith(".ifczip") && !lower.endsWith(".frag")) {
    setStatus("Fichier non supporté. Dépose un .ifc ou .frag.", "error");
    return;
  }

  try {
    await clearModels();

    setStatus(`Chargement de ${file.name} (${formatBytes(file.size)})…`);

    const data = await file.arrayBuffer();
    state.currentFileName = file.name;
    state.ifcIndex = null;

    if (lower.endsWith(".frag")) {
      const modelId = file.name.replace(/\.frag$/i, "");
      await state.fragments.core.load(data, { modelId });
      state.lastIfcText = null; 
      resetPendingEdits();
      if (editModeButton) editModeButton.disabled = true;
    } else {
      const buffer = new Uint8Array(data);
      const modelId = file.name.replace(/\.ifc(zip)?$/i, "");

     if (lower.endsWith(".ifc")) {
     const ifcText = new TextDecoder("utf-8").decode(buffer);
     state.ifcIndex = parseIfcText(ifcText, file.name);
     state.selectableIds = allDisplayableIfcElementIds(state.ifcIndex);
     state.lastIfcText = ifcText;     // ← garde le source
     resetPendingEdits();              // ← reset des edits sur nouveau modèle
     if (editModeButton) editModeButton.disabled = false;
   }

      await state.ifcLoader.load(buffer, false, modelId, {
        processData: {
          progressCallback: (progress) => {
            const pct = typeof progress === "number"
              ? `${Math.round(progress * 100)}%`
              : JSON.stringify(progress);
            setStatus(`Conversion IFC → Fragments… ${pct}`);
          },
        },
      });
    }

    clearButton.disabled = false;
    resetButton.disabled = false;
    updateSelectionButtons();
    setStatus(`Modèle chargé : ${file.name}`, "ok");
    await attachProjectContextForFile(file.name);
    if (state.project?.edits?.length) restorePendingEditsFromProject(state.project);
    updateModelerButtonState();
  } catch (error) {
    console.error(error);
    setStatus(`Erreur viewer : ${error.message || error}`, "error");
  }
}

async function buildTree() {
  if (!state.activeModel && !state.ifcIndex) return;

  if (state.activeTreeTab === "types") {
    await buildTypeTree();
    return;
  }

  if (state.activeTreeTab === "classifications") {
    await buildClassificationTree();
    return;
  }

  if (state.activeTreeTab === "layers") {
    await buildLayerTree();
    return;
  }

  await buildSpatialTree();
}

async function buildSpatialTree() {
  if (state.ifcIndex) {
    tree.innerHTML = renderIfcSpatialTree(state.ifcIndex);
    bindTreeEvents();
    return;
  }

  tree.innerHTML = '<div class="tree-empty">Structure spatiale disponible seulement pour les fichiers IFC en v6.</div>';
}

async function buildTypeTree() {
  if (state.ifcIndex) {
    tree.innerHTML = renderIfcTypeTree(state.ifcIndex);
    bindTreeEvents();
    return;
  }

  try {
    const structure = await state.activeModel.getSpatialStructure();
    const rawElements = collectElementsUnder(structure);
    const elements = await enrichElementsForTree(state.activeModel, rawElements);
    const groups = groupElementsByType(elements);

    tree.innerHTML = groups.length
      ? groups.map((group) => renderElementGroup(group)).join("")
      : '<div class="tree-empty">Aucun objet listable trouvé.</div>';
    bindTreeEvents();
  } catch (error) {
    console.error(error);
    tree.innerHTML = '<div class="tree-empty">Impossible de construire l’arbre par objets.</div>';
  }
}

async function buildClassificationTree() {
  if (!state.ifcIndex) {
    tree.innerHTML = '<div class="tree-empty">Les classifications sont disponibles pour les fichiers IFC chargés directement.</div>';
    return;
  }

  tree.innerHTML = renderIfcClassificationTree(state.ifcIndex);
  bindTreeEvents();
}

async function buildLayerTree() {
  if (!state.ifcIndex) {
    tree.innerHTML = '<div class="tree-empty">Les layers sont disponibles pour les fichiers IFC chargés directement.</div>';
    return;
  }

  tree.innerHTML = renderIfcLayerTree(state.ifcIndex);
  bindTreeEvents();
}

function renderElementGroup(group) {
  const ids = group.items.map((item) => localIdOf(item)).filter(Number.isFinite);

  return `
    <details class="tree-node type-group${nodeHiddenClass(ids)}">
      <summary data-selection-ids="${escapeHtml(ids.join(","))}" data-model-id="${escapeHtml(state.activeModel?.modelId || "")}">
        ${visibilityCheckboxHtml(ids)}
        <span class="twisty">›</span>
        <span class="tree-label">${escapeHtml(group.label)}</span>
        <span class="tree-count">${group.items.length}</span>
      </summary>
      <div class="tree-children">
        ${group.items.map((item) => renderElementNode(item)).join("")}
      </div>
    </details>
  `;
}

function renderElementNode(item) {
  const localId = localIdOf(item);
  const label = itemName(item) || `#${Number.isFinite(localId) ? localId : "?"}`;
  const category = prettyIfcType(categoryOf(item));
  const ids = Number.isFinite(localId) ? [localId] : [];

  return `
    <details class="tree-node element-node${nodeHiddenClass(ids)}">
      <summary data-local-id="${localId}" data-model-id="${escapeHtml(state.activeModel?.modelId || "")}">
        ${visibilityCheckboxHtml(ids)}
        <span class="twisty">·</span>
        <span class="tree-label">${escapeHtml(label)}</span>
        <span class="tree-type">${escapeHtml(category)}</span>
      </summary>
    </details>
  `;
}

function bindTreeEvents() {
  tree.querySelectorAll(".visibility-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    checkbox.addEventListener("change", async (event) => {
      event.stopPropagation();
      const ids = parseVisibilityIds(checkbox);
      await setElementVisibility(ids, checkbox.checked);
    });
  });

  tree.querySelectorAll("summary").forEach((summary) => {
    summary.addEventListener("click", async (event) => {
      if (event.target?.classList?.contains("visibility-checkbox")) {
        return;
      }

      event.preventDefault();

      const ids = selectionIdsFromSummary(summary);
      const modelId = summary.dataset.modelId || state.activeModel?.modelId;
      const details = summary.parentElement;
      const isElement = details?.classList.contains("element-node");

      if (ids.length && modelId) {
        await toggleSelection(modelId, ids[0], { fromTree: true, ids });
      }

      if (!isElement && details?.tagName === "DETAILS") {
        details.open = !details.open;
      }
    });
  });

  syncVisibilityCheckboxes();
}

function markSelectedTreeItem(localId) {
  tree.querySelectorAll("summary.selected").forEach((item) => item.classList.remove("selected"));

  const target = tree.querySelector(`summary[data-local-id="${localId}"]`);
  if (target) {
    target.classList.add("selected");
    target.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

async function toggleSelection(modelId, localId, options = {}) {
  const ids = uniqueIds(options.ids?.length ? options.ids : [localId]);
  const sameSelection =
    state.currentSelection &&
    state.currentSelection.modelId === modelId &&
    arraysSameSet(state.selectedIds, ids);

  if (sameSelection) {
    clearSelection();
    return;
  }

  await selectElements(modelId, ids, options);
}

function arraysSameSet(a, b) {
  const aa = uniqueIds(a);
  const bb = uniqueIds(b);
  if (aa.length !== bb.length) return false;
  const set = new Set(aa);
  return bb.every((id) => set.has(id));
}

async function selectElements(modelId, ids, options = {}) {
  const cleanIds = uniqueIds(ids);
  const model = state.fragments.list.get(modelId) || state.activeModel;

  if (!model || !cleanIds.length) {
    return;
  }

  try {
    await state.fragments.resetHighlight?.();

    const modelIdMap = { [model.modelId]: new Set(cleanIds) };

    await state.fragments.highlight(
      {
        color: selectionColor,
        renderedFaces: FRAGS.RenderedFaces?.TWO ?? FRAGS.RenderedFaces?.ONE ?? 0,
        opacity: 1,
        transparent: false,
      },
      modelIdMap,
    );

    await state.fragments.core.update(true);
  } catch (error) {
    console.warn("Highlight failed:", error);
  }

  state.currentSelection = { modelId: model.modelId, localId: cleanIds[0] };
  state.selectedIds = cleanIds;
  markSelectedTreeItems(cleanIds);

  if (cleanIds.length === 1) {
    await renderProperties(model, cleanIds[0]);
  } else {
    renderGroupProperties(cleanIds);
  }

  updateSelectionButtons();
}

async function selectElement(modelId, localId, options = {}) {
  await selectElements(modelId, [Number(localId)], options);
}

function markSelectedTreeItems(ids) {
  const idSet = new Set(uniqueIds(ids));
  tree.querySelectorAll("summary.selected").forEach((item) => item.classList.remove("selected"));

  for (const id of idSet) {
    const target = tree.querySelector(`summary[data-local-id="${id}"]`);
    if (target) {
      target.classList.add("selected");
    }
  }

  const first = tree.querySelector("summary.selected");
  first?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderGroupProperties(ids) {
  if (!state.editMode) {
    // Comportement original
    const rows = [
      { name: "Éléments sélectionnés", value: String(ids.length) },
      { name: "Raccourcis", value: "H masquer · F fit view · I isoler · Esc désélection" },
    ];
    propertiesPanel.innerHTML = `
      <div class="prop-title">Groupe sélectionné</div>
      <div class="prop-subtitle">${ids.length} éléments</div>
      ${renderAccordion({ title: "Sélection", rows, open: true })}
    `;
    return;
  }

  // Mode édition : on affiche le picker pour reclassifier en masse
  const typesPresent = new Map(); // type -> count
  for (const id of ids) {
    const t = currentTypeForEntity(id);
    if (t) typesPresent.set(t, (typesPresent.get(t) || 0) + 1);
  }

  const typesChips = [...typesPresent.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span class="type-chip">${escapeHtml(prettyIfcType(t))} × ${n}</span>`)
    .join('');

  const pendingCount = ids.filter(id => state.pendingEdits.has(Number(id))).length;
  const pendingMark = pendingCount > 0
    ? `<span class="pending-mark">${pendingCount} modifié${pendingCount > 1 ? 's' : ''}</span>`
    : '';

  // Most common type as default for the picker
  const dominant = [...typesPresent.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  propertiesPanel.innerHTML = `
    <div class="prop-title">Sélection multiple</div>
    <div class="prop-subtitle">${ids.length} éléments</div>

    <div class="multi-summary">
      <div class="count-line">
        <strong>${ids.length}</strong> élément${ids.length > 1 ? 's' : ''} sélectionné${ids.length > 1 ? 's' : ''}
      </div>
      <div class="types-line">${typesChips}</div>
    </div>

    <div class="reclassify-section">
      <h3>Reclassification en masse${pendingMark}</h3>
      <button type="button" class="reclassify-trigger" id="multi-reclassify-trigger">
        <span>Choisir un type IFC à appliquer…</span>
        <span class="arrow">▾</span>
      </button>
      <div class="original">Tip : Ctrl+clic pour ajouter à la sélection</div>
    </div>
  `;

  const btn = document.getElementById('multi-reclassify-trigger');
  if (btn) {
    btn.addEventListener('click', async () => {
      const newType = await openTypePicker({
        anchor: btn,
        currentType: dominant,
        catalog: state.ifcCatalog,
      });
      if (!newType) return;
      // Apply to all
      for (const id of ids) applyTypeChangeQuiet(id, newType);
      updateEditCount();
      renderGroupProperties(ids); // re-render to show pending mark
      setStatus(`Reclassifié ${ids.length} élément(s) vers ${prettyIfcType(newType)}`, "ok");
    });
  }
}

// Silent version that doesn't re-render or set status (used for batch)
function applyTypeChangeQuiet(localId, newType) {
  const original = originalTypeForEntity(localId);
  if (!original || newType === original) {
    state.pendingEdits.delete(Number(localId));
    return;
  }
  state.pendingEdits.set(Number(localId), { fromType: original, toType: newType });
}

async function renderProperties(model, localId) {
  propertiesPanel.innerHTML = '<div class="properties-empty">Lecture des propriétés…</div>';

  try {
    const parsedEntity = state.ifcIndex?.entities?.get(localId);
    const data =
      (await getItemData(model, localId)) ||
      (await model.getItemsData([localId], itemConfig).catch(() => []))[0] ||
      parsedEntityToItem(parsedEntity);

    if (!data) {
      propertiesPanel.innerHTML = `<div class="properties-empty">Aucune propriété trouvée pour #${localId}.</div>`;
      return;
    }

    const title = parsedEntity ? ifcElementName(parsedEntity) : itemName(data);
    const category = parsedEntity?.type || itemCategory(data);
    const globalId = attrValue(data.GlobalId);
    const attrs = extractAttributes(data);
    const accordions = buildAccordions(data, attrs);

    const reclassifyBlock = state.editMode
     ? renderReclassifyBlock(localId)
     : '';

    propertiesPanel.innerHTML = `
     <div class="prop-title">${escapeHtml(title)}</div>
     <div class="prop-subtitle">
      ${escapeHtml(prettyIfcType(category))} · #${localId}${globalId ? ` · ${escapeHtml(globalId)}` : ""}
     </div>
     ${reclassifyBlock}
     ${accordions}
    `;

    if (state.editMode) attachReclassifyHandler();
  } catch (error) {
    console.error(error);
    propertiesPanel.innerHTML = `<div class="properties-empty">Erreur de lecture des propriétés : ${escapeHtml(error.message || error)}</div>`;
  }
}

function extractAttributes(item) {
  const ignored = new Set(["relations", "children", "localId", "expressID", "category", "type", "rawArgs", "psets", "qtos", "classifications", "layers"]);
  const rows = [];

  for (const [key, value] of Object.entries(item)) {
    if (ignored.has(key)) continue;

    const valueText = attrValue(value);
    if (!valueText) continue;

    rows.push({ name: key, value: valueText });
  }

  return rows;
}

function parsedIfcSections(item) {
  const sections = [];

  if (item.classifications?.length) {
    sections.push({
      title: "Classifications",
      rows: item.classifications.flatMap((classification) => [
        { name: "Source", value: classification.source || "Classification" },
        { name: "Code", value: classification.identification || "" },
        { name: "Nom", value: classification.name || "" },
      ]).filter((row) => row.value),
      open: true,
    });
  }

  if (item.layers?.length) {
    sections.push({
      title: "Layers",
      rows: item.layers.flatMap((layer) => [
        { name: "Nom", value: layer.name || "" },
        { name: "Identifier", value: layer.identifier || "" },
        { name: "Description", value: layer.description || "" },
      ]).filter((row) => row.value),
      open: true,
    });
  }

  for (const pset of item.psets || []) {
    sections.push({
      title: pset.name,
      rows: pset.rows.map((row) => ({ name: row.name, value: row.value })),
      open: /Pset_WallCommon|Pset_.*Common/i.test(pset.name),
    });
  }

  for (const qto of item.qtos || []) {
    sections.push({
      title: qto.name,
      rows: qto.rows.map((row) => ({ name: row.name, value: row.value })),
      open: /Qto_WallBaseQuantities|Qto_.*BaseQuantities/i.test(qto.name),
    });
  }

  return sections;
}

function buildAccordions(item, attrs) {
  const sections = [];

  sections.push({
    title: "Attributs",
    rows: attrs.length ? attrs : [{ name: "LocalId", value: localIdOf(item) }],
    open: true,
  });

  sections.push(...parsedIfcSections(item));

  const relationSections = relationAccordions(item);
  sections.push(...relationSections);

  if (sections.length === 1) {
    sections.push({
      title: "Relations",
      rows: [{ name: "Info", value: "Aucune relation détaillée disponible." }],
      open: false,
    });
  }

  return sections.map((section) => renderAccordion(section)).join("");
}

function relationAccordions(item) {
  const sections = [];
  const relations = item.relations || item.Relations || {};

  if (!relations || typeof relations !== "object") {
    return sections;
  }

  for (const [relationName, relationValue] of Object.entries(relations)) {
    const rows = flattenRelation(relationValue);

    if (!rows.length) continue;

    sections.push({
      title: relationName,
      rows,
      open: /IsDefinedBy|Pset|Qto/i.test(relationName),
    });
  }

  return sections;
}

function flattenRelation(value, prefix = "") {
  const rows = [];

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const label = prefix ? `${prefix} ${index + 1}` : `Item ${index + 1}`;
      if (typeof item === "object" && item) {
        const name = itemName(item);
        const category = itemCategory(item);
        rows.push({ name: label, value: `${name} · ${category}` });

        const attrs = extractAttributes(item);
        for (const attr of attrs) {
          if (/Name|GlobalId|NominalValue|Description|Value|Reference|IsExternal|LoadBearing|Gross|Net|Height|Width|Length|Area|Volume/i.test(attr.name)) {
            rows.push({ name: `${label} · ${attr.name}`, value: attr.value });
          }
        }

        const nested = item.relations || item.Relations;
        if (nested && typeof nested === "object") {
          for (const [nestedName, nestedValue] of Object.entries(nested)) {
            flattenRelation(nestedValue, `${label} · ${nestedName}`).forEach((row) => rows.push(row));
          }
        }
      } else {
        rows.push({ name: label, value: attrValue(item) });
      }
    });

    return rows;
  }

  if (typeof value === "object" && value) {
    const attrs = extractAttributes(value);
    rows.push(...attrs);

    const nested = value.relations || value.Relations;
    if (nested && typeof nested === "object") {
      for (const [nestedName, nestedValue] of Object.entries(nested)) {
        flattenRelation(nestedValue, nestedName).forEach((row) => rows.push(row));
      }
    }

    return rows;
  }

  const text = attrValue(value);
  if (text) rows.push({ name: prefix || "Valeur", value: text });

  return rows;
}

function renderAccordion(section) {
  const rowsHtml = section.rows.map((row) => `
    <div class="prop-row">
      <div class="prop-name">${escapeHtml(row.name)}</div>
      <div class="prop-value">${escapeHtml(row.value)}</div>
    </div>
  `).join("");

  return `
    <details class="accordion" ${section.open ? "open" : ""}>
      <summary>
        <span>${escapeHtml(section.title)}</span>
        <span class="mini">${section.rows.length}</span>
      </summary>
      <div class="accordion-body">${rowsHtml}</div>
    </details>
  `;
}

async function hideCurrentSelection() {
  if (!state.selectedIds.length) return;
  await setElementVisibility(state.selectedIds, false);
}

async function fitCurrentSelection() {
  if (!state.selectedIds.length || !state.activeModel) {
    if (state.lastModelObject) await fitCameraToObject(state.lastModelObject);
    return;
  }

  const ids = state.selectedIds;

  // Fragments does not expose a stable per-item bounding box API across all
  // versions. Try best-effort APIs first, then fallback to full model fit.
  try {
    const model = state.activeModel;

    if (typeof model.getBoxes === "function") {
      const boxes = await model.getBoxes(ids);
      const box = new THREE.Box3();

      for (const itemBox of boxes || []) {
        if (itemBox?.min && itemBox?.max) {
          box.union(new THREE.Box3(
            new THREE.Vector3(itemBox.min.x, itemBox.min.y, itemBox.min.z),
            new THREE.Vector3(itemBox.max.x, itemBox.max.y, itemBox.max.z),
          ));
        }
      }

      if (!box.isEmpty()) {
        await fitCameraToBox(box);
        return;
      }
    }
  } catch (error) {
    console.warn("Fit selected failed, falling back to model fit:", error);
  }

  await fitCameraToObject(state.lastModelObject);
}

async function fitCameraToBox(box) {
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim * 1.65;

  await state.world.camera.controls.setLookAt(
    center.x + distance,
    center.y + distance * 0.75,
    center.z + distance,
    center.x,
    center.y,
    center.z,
    true
  );

  state.fragments?.core.update(true);
}

async function toggleIsolation() {
  if (!state.selectedIds.length || !state.activeModel || !state.hider) return;

  if (state.isolateActive && arraysSameSet(state.isolatedIds, state.selectedIds)) {
    await clearIsolation();
    return;
  }

  const allIds = state.selectableIds.length
    ? state.selectableIds
    : state.ifcIndex
      ? allDisplayableIfcElementIds(state.ifcIndex)
      : [];

  const selected = new Set(state.selectedIds);
  const toHide = allIds.filter((id) => !selected.has(id));

  if (!toHide.length) return;

  try {
    await state.hider.set(false, { [state.activeModel.modelId]: new Set(toHide) });
    state.isolateActive = true;
    state.isolatedIds = [...state.selectedIds];

    for (const id of toHide) state.hiddenIds.add(id);
    for (const id of state.selectedIds) state.hiddenIds.delete(id);

    syncVisibilityCheckboxes();
    updateSelectionButtons();
    state.fragments?.core.update(true);
  } catch (error) {
    console.warn("Isolation failed:", error);
    setStatus(`Impossible d’isoler : ${error.message || error}`, "error");
  }
}

async function clearIsolation() {
  if (!state.activeModel || !state.hider) return;

  const allIds = state.selectableIds.length
    ? state.selectableIds
    : state.ifcIndex
      ? allDisplayableIfcElementIds(state.ifcIndex)
      : [];

  try {
    await state.hider.set(true, { [state.activeModel.modelId]: new Set(allIds) });
    state.isolateActive = false;
    state.isolatedIds = [];
    state.hiddenIds.clear();

    syncVisibilityCheckboxes();
    updateSelectionButtons();
    state.fragments?.core.update(true);
  } catch (error) {
    console.warn("Clear isolation failed:", error);
  }
}

function isTypingTarget(target) {
  const tag = String(target?.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || target?.isContentEditable;
}

document.addEventListener("keydown", async (event) => {
  if (isTypingTarget(event.target)) return;

  const key = event.key.toLowerCase();

  if (key === "h") {
    event.preventDefault();
    await hideCurrentSelection();
  }

  if (key === "f") {
    event.preventDefault();
    await fitCurrentSelection();
  }

  if (key === "i") {
    event.preventDefault();
    await toggleIsolation();
  }

  if (event.key === "Escape") {
    event.preventDefault();
    if (state.isolateActive) await clearIsolation();
    clearSelection();
  }
});

isolateButton.addEventListener("click", async () => {
  await toggleIsolation();
});

treeTabs.forEach((button) => {
  button.addEventListener("click", async () => {
    treeTabs.forEach((tab) => tab.classList.remove("active"));
    button.classList.add("active");
    state.activeTreeTab = button.dataset.treeTab || "spatial";
    await buildTree();
  });
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("drag-over");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("drag-over");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("drag-over");

  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

input.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) loadFile(file);
});

resetButton.addEventListener("click", async () => {
  if (state.lastModelObject) {
    await fitCameraToObject(state.lastModelObject);
  }
});

clearButton.addEventListener("click", async () => {
  await clearModels();
  setStatus("Modèle retiré. Dépose un autre fichier IFC.", "ok");
});

window.addEventListener("resize", () => {
  state.world?.renderer?.resize?.();
  state.world?.camera?.updateAspect?.();
  state.fragments?.core.update(true);
});

// ─────────────────────────────────────────────────────────────────────────
// Edit mode (reclassification)
// ─────────────────────────────────────────────────────────────────────────

const FALLBACK_RECLASSIFIABLE_TYPES = [
  "IFCWALL",
  "IFCSLAB",
  "IFCBEAM",
  "IFCCOLUMN",
  "IFCSTAIR",
  "IFCROOF",
  "IFCDOOR",
  "IFCWINDOW",
  "IFCBUILDINGELEMENTPROXY",
];

async function loadIfcCatalog() {
  try {
    const r = await fetch('/api/ifc-catalog');
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data.types) && data.types.length) {
        state.ifcCatalog = data;
        return;
      }
    }
  } catch (_) { /* ignore */ }
  // Fallback minimal
  state.ifcCatalog = {
    types: [
      { type: 'IFCWALL', label: 'Mur', aliases: ['mur', 'wall'], category: 'misc', tier: 'standard' },
      { type: 'IFCSLAB', label: 'Dalle', aliases: ['dalle', 'slab'], category: 'misc', tier: 'standard' },
      { type: 'IFCDOOR', label: 'Porte', aliases: ['porte', 'door'], category: 'misc', tier: 'opening' },
      { type: 'IFCWINDOW', label: 'Fenêtre', aliases: ['fenetre', 'window'], category: 'misc', tier: 'opening' },
      { type: 'IFCBUILDINGELEMENTPROXY', label: 'Élément générique', aliases: [], category: 'misc', tier: 'standard' },
    ],
    categories: [{ key: 'misc', label: 'Divers' }],
  };
}

function resetPendingEdits() {
  state.pendingEdits.clear();
  updateEditCount();
}

function updateEditCount() {
  if (editCountEl) editCountEl.textContent = String(state.pendingEdits.size);
  if (exportEditedButton) {
    exportEditedButton.disabled = state.pendingEdits.size === 0;
  }
  scheduleProjectPersist();
}

function toggleEditMode() {
  if (!state.lastIfcText) {
    setStatus("Charge un IFC pour activer le mode édition.", "error");
    return;
  }
  state.editMode = !state.editMode;
  document.body.classList.toggle('edit-mode', state.editMode);
  if (editModeButton) editModeButton.classList.toggle('active', state.editMode);

  // Force re-render of the current selection's properties so the dropdown
  // appears/disappears immediately.
  if (state.currentSelection) {
    const model = state.fragments?.list.get(state.currentSelection.modelId) || state.activeModel;
    if (model) renderProperties(model, state.currentSelection.localId);
  }
}

function currentTypeForEntity(localId) {
  const pending = state.pendingEdits.get(Number(localId));
  if (pending) return pending.toType;
  const entity = state.ifcIndex?.entities?.get(Number(localId));
  return entity?.type || null;
}

function originalTypeForEntity(localId) {
  const pending = state.pendingEdits.get(Number(localId));
  if (pending) return pending.fromType;
  const entity = state.ifcIndex?.entities?.get(Number(localId));
  return entity?.type || null;
}

function renderReclassifyBlock(localId) {
  const original = originalTypeForEntity(localId);
  const current = currentTypeForEntity(localId);
  const isPending = state.pendingEdits.has(Number(localId));

  if (!original) {
    return '';
  }

  const entry = state.ifcCatalog?.types.find(t => t.type === current);
  const label = entry?.label || prettyIfcType(current);

  const pendingMark = isPending
    ? `<span class="pending-mark">modifié</span>`
    : '';

  return `
    <div class="reclassify-section">
      <h3>Reclassification${pendingMark}</h3>
      <button type="button" class="reclassify-trigger" id="reclassify-trigger" data-local-id="${localId}">
        <span><strong>${escapeHtml(current)}</strong> · ${escapeHtml(label)}</span>
        <span class="arrow">▾</span>
      </button>
      <div class="original">Type d'origine : ${escapeHtml(prettyIfcType(original))}</div>
      <div class="qwen-suggest-row">
        <button type="button" class="qwen-suggest-button" id="qwen-suggest-trigger" data-local-id="${localId}">✨ Suggérer avec Qwen</button>
      </div>
      <div class="qwen-suggestions" id="qwen-suggestions"></div>
    </div>
  `;
}

function qwenReasonLabel(code) {
  const labels = {
    name_hint_wall: 'nom lié à un mur',
    name_hint_door: 'nom lié à une porte',
    name_hint_window_or_glass: 'nom lié à une fenêtre / vitrage',
    name_hint_slab: 'nom lié à une dalle / plancher',
    name_hint_roof: 'nom lié à une toiture',
    name_hint_beam: 'nom lié à une poutre',
    name_hint_column: 'nom lié à un poteau',
    name_hint_stair: 'nom lié à un escalier',
    thin_vertical_bbox: 'bbox verticale et mince',
    flat_horizontal_bbox: 'bbox horizontale et plate',
    vertical_faces_high: 'faces verticales dominantes',
    horizontal_faces_high: 'faces horizontales dominantes',
    inclined_faces_present: 'faces inclinées présentes',
    semantic_rerank_match: 'match sémantique Qwen',
  };
  return labels[code] || code;
}

function renderQwenSuggestionCards(localId, data) {
  const container = document.getElementById('qwen-suggestions');
  if (!container) return;

  const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
  if (!suggestions.length) {
    container.innerHTML = '<div class="qwen-note">Aucune suggestion exploitable.</div>';
    return;
  }

  const note = data.llmAvailable
    ? `<div class="qwen-note">Qwen actif · ${escapeHtml(String(data.candidateCount || suggestions.length))} candidat(s) scoré(s).</div>`
    : `<div class="qwen-note">Qwen indisponible : fallback heuristique local.${data.qwenError ? `<br><span class="qwen-error">${escapeHtml(data.qwenError)}</span>` : ''}</div>`;

  container.innerHTML = note + suggestions.map((suggestion, index) => {
    const pct = Math.round(Number(suggestion.score || 0) * 100);
    const reasons = (suggestion.reasonCodes || []).map(qwenReasonLabel).join(' · ');
    return `
      <div class="qwen-card">
        <div class="qwen-card-header">
          <span class="qwen-type">${index + 1}. ${escapeHtml(suggestion.type)}</span>
          <span class="qwen-score">${pct}%</span>
        </div>
        <div class="qwen-reasons">${escapeHtml(suggestion.label || '')}${reasons ? ` · ${escapeHtml(reasons)}` : ''}</div>
        <button type="button" class="qwen-apply" data-local-id="${localId}" data-type="${escapeHtml(suggestion.type)}">Appliquer ${escapeHtml(suggestion.type)}</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.qwen-apply').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.localId);
      const type = button.dataset.type;
      if (type) applyTypeChange(id, type);
    });
  });
}

async function requestQwenSuggestions(localId, button) {
  if (!state.lastIfcText) {
    setStatus('Charge un IFC avant de demander une suggestion Qwen.', 'error');
    return;
  }

  const container = document.getElementById('qwen-suggestions');
  if (container) container.innerHTML = '<div class="qwen-note">Analyse Qwen en cours…</div>';
  if (button) {
    button.disabled = true;
    button.classList.add('loading');
    button.textContent = 'Analyse Qwen…';
  }

  try {
    const response = await fetch('/api/qwen-suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ifcText: state.lastIfcText,
        localId,
        currentType: currentTypeForEntity(localId),
        maxSuggestions: 3,
        maxCandidates: 80,
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || 'Erreur Qwen');

    renderQwenSuggestionCards(localId, data);
    setStatus(data.llmAvailable
      ? `Suggestions Qwen prêtes pour #${localId}.`
      : `Qwen indisponible : suggestions heuristiques affichées pour #${localId}.`, data.llmAvailable ? 'ok' : '');
  } catch (error) {
    console.error(error);
    if (container) container.innerHTML = `<div class="qwen-error">${escapeHtml(error.message || error)}</div>`;
    setStatus(`Erreur suggestion Qwen : ${error.message || error}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('loading');
      button.textContent = '✨ Suggérer avec Qwen';
    }
  }
}

function attachQwenSuggestionHandler() {
  const btn = document.getElementById('qwen-suggest-trigger');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const localId = Number(btn.dataset.localId);
    requestQwenSuggestions(localId, btn);
  });
}

function attachReclassifyHandler() {
  const btn = document.getElementById('reclassify-trigger');
  if (btn) {
    btn.addEventListener('click', async () => {
      const localId = Number(btn.dataset.localId);
      const current = currentTypeForEntity(localId);
      const newType = await openTypePicker({
        anchor: btn,
        currentType: current,
        catalog: state.ifcCatalog,
      });
      if (!newType) return;
      applyTypeChange(localId, newType);
    });
  }

  attachQwenSuggestionHandler();
}

function applyTypeChange(localId, newType) {
  const original = originalTypeForEntity(localId);
  if (!original) return;
  if (newType === original) {
    state.pendingEdits.delete(Number(localId));
  } else {
    state.pendingEdits.set(Number(localId), { fromType: original, toType: newType });
  }
  updateEditCount();
  // Re-render selection
  if (state.currentSelection) {
    const model = state.fragments?.list.get(state.currentSelection.modelId) || state.activeModel;
    if (model && state.selectedIds.length === 1) {
      renderProperties(model, state.selectedIds[0]);
    } else if (state.selectedIds.length > 1) {
      renderGroupProperties(state.selectedIds);
    }
  }
  setStatus(`Reclassifié vers ${prettyIfcType(newType)} (#${localId})`, "ok");
}

async function exportEditedIfc() {
  if (!state.lastIfcText || state.pendingEdits.size === 0) return;

  const edits = [];
  for (const [localId, edit] of state.pendingEdits.entries()) {
    edits.push({ localId, toType: edit.toType });
  }

  setStatus(`Export en cours (${edits.length} modifs)…`);

  try {
    const response = await fetch('/api/reexport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ifcText: state.lastIfcText,
        edits,
        fileName: state.currentFileName,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Erreur serveur' }));
      throw new Error(err.error);
    }

    const applied = response.headers.get('X-Edits-Applied');
    const errors  = response.headers.get('X-Edits-Errors');
    const blob = await response.blob();

    if (state.lastEditedBlobUrl) URL.revokeObjectURL(state.lastEditedBlobUrl);
    const url = URL.createObjectURL(blob);
    state.lastEditedBlobUrl = url;

    const a = document.createElement('a');
    a.href = url;
    a.download = (state.currentFileName || 'edited.ifc').replace(/\.ifc$/i, '') + '.edited.ifc';
    document.body.appendChild(a);
    a.click();
    a.remove();

    setStatus(`Export OK · ${applied} modif(s) appliquée(s)${errors > 0 ? ` · ${errors} erreur(s)` : ''}`, "ok");
    if (reloadEditedButton) {
      reloadEditedButton.disabled = false;
      reloadEditedButton.style.display = '';
      reloadEditedButton.dataset.blobUrl = url;
    }
  } catch (err) {
    setStatus(`Erreur export : ${err.message || err}`, "error");
  }
}

async function reloadEditedIfc() {
  const url = reloadEditedButton?.dataset.blobUrl;
  if (!url) return;

  try {
    setStatus("Rechargement de l'IFC modifié…");
    const response = await fetch(url);
    const blob = await response.blob();
    const file = new File([blob], state.currentFileName.replace(/\.ifc$/i, '') + '.edited.ifc', { type: 'application/x-step' });
    await loadFile(file);
  } catch (err) {
    setStatus(`Erreur rechargement : ${err.message || err}`, "error");
  }
}

if (editModeButton) editModeButton.addEventListener('click', toggleEditMode);
if (exportEditedButton) exportEditedButton.addEventListener('click', exportEditedIfc);
if (resetEditsButton) resetEditsButton.addEventListener('click', () => {
  if (state.pendingEdits.size === 0) return;
  if (!confirm(`Annuler ${state.pendingEdits.size} modification(s) ?`)) return;
  resetPendingEdits();
  if (state.currentSelection) {
    const model = state.fragments?.list.get(state.currentSelection.modelId) || state.activeModel;
    if (model) renderProperties(model, state.currentSelection.localId);
  }
  setStatus("Modifications annulées.", "ok");
});
if (reloadEditedButton) reloadEditedButton.addEventListener('click', reloadEditedIfc);
if (modelerButton) modelerButton.addEventListener('click', openModelerForCurrentProject);

loadIfcCatalog();

const EDGE_HELPER_NAME = "__glb2ifc_edges__";

function addEdgesToObject(root) {
  if (!root || !state.world) return;

  removeEdgesFromObject();

  const scene = state.world.scene.three;
  const edgesGroup = new THREE.Group();
  edgesGroup.name = EDGE_HELPER_NAME;
  edgesGroup.renderOrder = 9999;

  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
  });

  const instanceMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();

  let meshCount = 0;
  let edgeCount = 0;

  root.updateWorldMatrix(true, true);

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;

    meshCount += 1;
    child.updateWorldMatrix(true, false);

    // Cas classique
    if (!child.isInstancedMesh) {
      const edgesGeometry = new THREE.EdgesGeometry(child.geometry, 20);
      const edges = new THREE.LineSegments(edgesGeometry, edgeMaterial);

      edges.matrixAutoUpdate = false;
      edges.matrix.copy(child.matrixWorld);
      edges.renderOrder = 9999;

      edgesGroup.add(edges);
      edgeCount += 1;
      return;
    }

    // Cas InstancedMesh / Fragments
    const count = Math.min(child.count || 0, 3000);
    const baseEdgesGeometry = new THREE.EdgesGeometry(child.geometry, 20);

    for (let i = 0; i < count; i++) {
      child.getMatrixAt(i, instanceMatrix);

      worldMatrix
        .copy(child.matrixWorld)
        .multiply(instanceMatrix);

      const edges = new THREE.LineSegments(baseEdgesGeometry.clone(), edgeMaterial);
      edges.matrixAutoUpdate = false;
      edges.matrix.copy(worldMatrix);
      edges.renderOrder = 9999;

      edgesGroup.add(edges);
      edgeCount += 1;
    }

    baseEdgesGeometry.dispose();
  });

  scene.add(edgesGroup);

  console.info(`[Edges] meshes trouvés: ${meshCount}, edges ajoutés: ${edgeCount}`);
}

function removeEdgesFromObject() {
  const scene = state.world?.scene?.three;
  if (!scene) return;

  const edgesGroup = scene.getObjectByName(EDGE_HELPER_NAME);
  if (!edgesGroup) return;

  edgesGroup.traverse((child) => {
    child.geometry?.dispose?.();
  });

  const materials = new Set();
  edgesGroup.traverse((child) => {
    if (child.material) materials.add(child.material);
  });

  for (const material of materials) {
    material.dispose?.();
  }

  scene.remove(edgesGroup);
}

initViewer().catch((error) => {
  console.error(error);
  setStatus(`Erreur d’initialisation : ${error.message || error}`, "error");
});
