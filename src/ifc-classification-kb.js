/**
 * Lightweight knowledge base used to build IFC candidate documents for the
 * Qwen reranker. This is not the source of truth for supported types: the
 * authoritative catalog remains ifc-catalog.js / ifc-patcher.js.
 */

export const IFC_CLASSIFICATION_KB = {
  IFCWALL: {
    use: 'Vertical building element used as a wall, partition, enclosure or facade part. Usually tall, long and relatively thin.',
    positive: ['wall/mur/cloison/facade name hint', 'height around a storey', 'large length compared to thickness', 'dominant vertical faces'],
    negative: ['door or window hint', 'horizontal slab geometry', 'furniture or MEP equipment'],
  },
  IFCCURTAINWALL: {
    use: 'Facade or curtain wall assembly, often vertical and broad, frequently linked to glazing or facade names.',
    positive: ['facade/curtain/glass/glazing hint', 'large vertical surface', 'thin depth'],
    negative: ['opaque interior partition with no facade/glass hint', 'single small window panel'],
  },
  IFCPLATE: {
    use: 'Thin planar building element such as panel, sheet, cladding plate, glass plate or infill panel.',
    positive: ['very thin panel-like geometry', 'plate/panel/vitre/glass hint', 'vertical or horizontal planar object'],
    negative: ['full-height wall with wall hint', 'door with door hint', 'structural beam or column'],
  },
  IFCSLAB: {
    use: 'Horizontal floor, ceiling, slab or deck element, generally broad and thin.',
    positive: ['slab/floor/dalle/plancher/ceiling hint', 'large horizontal footprint', 'small vertical thickness', 'dominant horizontal faces'],
    negative: ['tall vertical object', 'door/window/stair hint'],
  },
  IFCROOF: {
    use: 'Roof or roof covering element, horizontal or sloped, usually near the top of the building.',
    positive: ['roof/toit/toiture/couverture hint', 'inclined faces', 'large upper horizontal or sloped surface'],
    negative: ['regular floor slab at storey level', 'wall or door hint'],
  },
  IFCCOVERING: {
    use: 'Finish, covering, cladding, lining, ceiling finish, floor finish or surface layer.',
    positive: ['covering/revetement/habillage/enduit/plafond hint', 'thin layer-like object'],
    negative: ['main structural wall/slab/roof geometry'],
  },
  IFCDOOR: {
    use: 'Door, entrance leaf or door assembly used for passage. Usually vertical, thin and around human door size.',
    positive: ['door/porte/ouvrant hint', 'height around 1.8 to 2.4 m', 'width around 0.5 to 1.5 m', 'thin depth'],
    negative: ['window/glass hint without door hint', 'large full wall', 'horizontal slab'],
  },
  IFCWINDOW: {
    use: 'Window, glazed opening, bay or transparent panel. Usually vertical and thin with glass/window naming.',
    positive: ['window/fenetre/vitre/vitrage/glass/glazing hint', 'vertical thin panel', 'plausible window dimensions'],
    negative: ['opaque wall with wall hint', 'door/porte hint', 'floor slab'],
  },
  IFCBEAM: {
    use: 'Beam, joist, lintel or horizontal/sloped structural linear member.',
    positive: ['beam/poutre/joist/lintel hint', 'long linear object', 'small cross-section compared to length'],
    negative: ['full storey-height wall', 'compact column', 'door/window hint'],
  },
  IFCCOLUMN: {
    use: 'Column, post, pillar or vertical structural member with compact footprint.',
    positive: ['column/poteau/pilier hint', 'tall vertical object', 'compact XZ footprint'],
    negative: ['long wall-like footprint', 'beam-like horizontal member', 'door/window hint'],
  },
  IFCMEMBER: {
    use: 'Generic structural member, often a brace, rail, mullion or linear component not clearly a beam or column.',
    positive: ['member/profile/brace/mullion hint', 'linear object', 'structural component'],
    negative: ['clear wall/slab/door/window geometry'],
  },
  IFCSTAIR: {
    use: 'Complete stair object or stair assembly.',
    positive: ['stair/escalier/marche hint', 'series of horizontal levels', 'vertical rise and horizontal run'],
    negative: ['single slab', 'wall panel', 'door/window hint'],
  },
  IFCSTAIRFLIGHT: {
    use: 'One flight of stairs including treads and risers.',
    positive: ['stair flight/volee hint', 'repeated steps', 'inclined progression'],
    negative: ['complete multi-flight stair assembly', 'single floor slab'],
  },
  IFCRAILING: {
    use: 'Railing, guardrail, balustrade or handrail.',
    positive: ['railing/garde-corps/main courante hint', 'long thin safety barrier', 'near stairs, balconies or edges'],
    negative: ['solid wall', 'beam or pipe without railing context'],
  },
  IFCFURNISHINGELEMENT: {
    use: 'Furniture or furnishing object such as table, chair, cabinet or equipment that is not part of the building fabric.',
    positive: ['furniture/mobilier/table/chair/chaise/cabinet hint', 'free-standing object', 'not structural'],
    negative: ['wall/slab/roof/door/window hints'],
  },
  IFCSANITARYTERMINAL: {
    use: 'Plumbing fixture such as toilet, sink, basin, shower or bathtub.',
    positive: ['toilet/wc/sink/lavabo/basin/douche/bath hint', 'sanitary equipment shape'],
    negative: ['building envelope or structural element'],
  },
  IFCLIGHTFIXTURE: {
    use: 'Light fixture, luminaire or lamp.',
    positive: ['light/lamp/luminaire/eclairage hint', 'small fixture near ceiling or wall'],
    negative: ['window or glass facade', 'large building element'],
  },
  IFCFLOWTERMINAL: {
    use: 'Generic MEP terminal such as diffuser, outlet, grille or end device.',
    positive: ['terminal/diffuser/grille/outlet hint', 'small MEP device'],
    negative: ['main duct, pipe, wall or slab'],
  },
  IFCDUCTSEGMENT: {
    use: 'HVAC duct segment, generally linear with rectangular or circular section.',
    positive: ['duct/gaine/ventilation/cvc hint', 'long MEP segment'],
    negative: ['beam with structural name', 'wall-like panel'],
  },
  IFCPIPESEGMENT: {
    use: 'Pipe segment for plumbing, heating or other fluid distribution.',
    positive: ['pipe/tube/tuyau/canalisation hint', 'long cylindrical or linear MEP segment'],
    negative: ['structural beam or railing with no MEP hint'],
  },
  IFCCABLESEGMENT: {
    use: 'Cable or electrical segment.',
    positive: ['cable/wire/fil/electrical hint', 'thin linear electrical element'],
    negative: ['pipe/duct/beam with stronger hints'],
  },
  IFCBUILDINGELEMENTPROXY: {
    use: 'Fallback generic building element when the semantic class is uncertain or unsupported.',
    positive: ['ambiguous object', 'no reliable name or geometry signal', 'unsupported target type'],
    negative: ['clear wall, slab, door, window, roof, beam or column'],
  },
  IFCELEMENTASSEMBLY: {
    use: 'Assembly made of multiple elements or a grouped component not fitting a single simple class.',
    positive: ['assembly/groupe/kit hint', 'compound object with mixed geometry'],
    negative: ['single clear wall/slab/door/window object'],
  },
};

export function kbForIfcType(type) {
  return IFC_CLASSIFICATION_KB[String(type || '').toUpperCase()] || null;
}

export function candidateDocumentForIfcType(entry) {
  const type = String(entry?.type || '').toUpperCase();
  const kb = kbForIfcType(type);
  const aliases = Array.isArray(entry?.aliases) ? entry.aliases.join(', ') : '';
  return [
    `IFC_TYPE: ${type}`,
    `LABEL: ${entry?.label || type}`,
    `CATEGORY: ${entry?.category || 'unknown'}`,
    `ALIASES: ${aliases || 'none'}`,
    `TIER: ${entry?.tier || 'unknown'}`,
    `PREDEFINED: ${entry?.predefined ?? 'none'}`,
    `WHEN_TO_USE: ${kb?.use || 'Use when this IFC class is the best semantic match for the physical BIM element.'}`,
    `POSITIVE_SIGNALS: ${(kb?.positive || []).join('; ') || 'name, material, geometry and BIM context match this class'}`,
    `NEGATIVE_SIGNALS: ${(kb?.negative || []).join('; ') || 'another more specific IFC class is a clearer match'}`,
  ].join('\n');
}
