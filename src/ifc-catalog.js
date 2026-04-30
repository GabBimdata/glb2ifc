/**
 * IFC type catalog for the reclassification picker.
 *
 * Each entry:
 *   - type:      the IFC class name (uppercase, as used in STEP-21)
 *   - label:     short French/English-friendly label
 *   - aliases:   keywords for fuzzy search (no accents, lowercase)
 *   - category:  group key
 *   - tier:      'standard' (9 attrs) | 'opening' (13 attrs, needs dimensions) |
 *                'unsupported' (cannot reclassify to/from in v1)
 *   - predefined: PredefinedType value to use when converting TO this type
 *                (only for 'standard' and 'opening' tiers)
 *
 * Tiers in detail:
 *   - 'standard'    : direct 9-attr swap, just change the class name + PredefinedType.
 *   - 'opening'     : 13-attr (IfcDoor, IfcWindow). The patcher computes
 *                     OverallHeight and OverallWidth from the element's
 *                     IfcCartesianPointList3D when converting TO these.
 *   - 'unsupported' : shown in the picker but disabled. Examples: IfcSpace
 *                     (10 attrs incl. ElevationWithFlooring), IfcDistributionElement
 *                     and its many MEP subtypes (would require more domain logic),
 *                     spatial structure types (IfcBuildingStorey, IfcSite, ...).
 */

export const IFC_CATEGORIES = [
  { key: 'arch_walls',     label: 'Murs et façades' },
  { key: 'arch_floors',    label: 'Sols et toitures' },
  { key: 'arch_openings',  label: 'Ouvertures' },
  { key: 'arch_circulation', label: 'Circulations' },
  { key: 'arch_finishes',  label: 'Finitions et habillages' },
  { key: 'structure',      label: 'Structure' },
  { key: 'foundations',    label: 'Fondations' },
  { key: 'furnishings',    label: 'Mobilier et équipements' },
  { key: 'mep_distribution', label: 'MEP — Distribution (générique)' },
  { key: 'mep_flow',       label: 'MEP — Plomberie / CVC' },
  { key: 'mep_electrical', label: 'MEP — Électricité' },
  { key: 'mep_terminals',  label: 'MEP — Terminaux' },
  { key: 'civil',          label: 'Génie civil et infrastructure' },
  { key: 'spatial',        label: 'Éléments spatiaux' },
  { key: 'misc',           label: 'Divers' },
];

export const IFC_TYPES = [
  // ── Murs et façades ───────────────────────────────────────────────────────
  { type: 'IFCWALL',           label: 'Mur',                aliases: ['mur', 'wall', 'cloison', 'partition'], category: 'arch_walls', tier: 'standard', predefined: '.STANDARD.' },
  { type: 'IFCCURTAINWALL',    label: 'Mur-rideau',         aliases: ['mur rideau', 'curtain wall', 'facade vitree'], category: 'arch_walls', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCPLATE',          label: 'Plaque / Panneau',   aliases: ['plate', 'plaque', 'panneau', 'panel'], category: 'arch_walls', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCSHADINGDEVICE',  label: 'Brise-soleil',       aliases: ['brise soleil', 'shading', 'pare soleil', 'lamelle'], category: 'arch_walls', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── Sols et toitures ──────────────────────────────────────────────────────
  { type: 'IFCSLAB',           label: 'Dalle / Sol',        aliases: ['dalle', 'slab', 'plancher', 'sol', 'floor'], category: 'arch_floors', tier: 'standard', predefined: '.FLOOR.' },
  { type: 'IFCROOF',           label: 'Toiture',            aliases: ['toit', 'toiture', 'roof', 'couverture'], category: 'arch_floors', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCCOVERING',       label: 'Habillage / Revêtement', aliases: ['revetement', 'covering', 'habillage', 'enduit', 'plafond suspendu'], category: 'arch_floors', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── Ouvertures ────────────────────────────────────────────────────────────
  { type: 'IFCDOOR',           label: 'Porte',              aliases: ['porte', 'door', 'entree'], category: 'arch_openings', tier: 'opening', predefined: '.DOOR.' },
  { type: 'IFCWINDOW',         label: 'Fenêtre',            aliases: ['fenetre', 'window', 'vitrage', 'baie'], category: 'arch_openings', tier: 'opening', predefined: '.WINDOW.' },

  // ── Circulations ──────────────────────────────────────────────────────────
  { type: 'IFCSTAIR',          label: 'Escalier',           aliases: ['escalier', 'stair', 'marche'], category: 'arch_circulation', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCSTAIRFLIGHT',    label: 'Volée d\'escalier',  aliases: ['volee', 'stair flight', 'paillasse'], category: 'arch_circulation', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCRAMP',           label: 'Rampe',              aliases: ['rampe', 'ramp', 'pente'], category: 'arch_circulation', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCRAMPFLIGHT',     label: 'Volée de rampe',     aliases: ['volee rampe', 'ramp flight'], category: 'arch_circulation', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCRAILING',        label: 'Garde-corps',        aliases: ['garde corps', 'railing', 'main courante', 'rambarde'], category: 'arch_circulation', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── Finitions ─────────────────────────────────────────────────────────────
  { type: 'IFCBUILDINGELEMENTPART', label: 'Composant de bâtiment', aliases: ['composant', 'part', 'sous element'], category: 'arch_finishes', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCCHIMNEY',        label: 'Cheminée',           aliases: ['cheminee', 'chimney', 'conduit fumee'], category: 'arch_finishes', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── Structure ─────────────────────────────────────────────────────────────
  { type: 'IFCBEAM',           label: 'Poutre',             aliases: ['poutre', 'beam', 'panne', 'chevron', 'sommier'], category: 'structure', tier: 'standard', predefined: '.BEAM.' },
  { type: 'IFCCOLUMN',         label: 'Poteau / Colonne',   aliases: ['poteau', 'column', 'colonne', 'pilier'], category: 'structure', tier: 'standard', predefined: '.COLUMN.' },
  { type: 'IFCMEMBER',         label: 'Membrure',           aliases: ['membrure', 'member', 'structurel'], category: 'structure', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCBEARING',        label: 'Appui structurel',   aliases: ['appui', 'bearing', 'palier'], category: 'structure', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCTENDON',         label: 'Tirant / Câble',     aliases: ['tirant', 'tendon', 'cable', 'precontrainte'], category: 'structure', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCREINFORCINGBAR', label: 'Armature',           aliases: ['armature', 'rebar', 'fer a beton'], category: 'structure', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCREINFORCINGMESH', label: 'Treillis soudé',    aliases: ['treillis', 'mesh', 'panneau armature'], category: 'structure', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── Fondations ────────────────────────────────────────────────────────────
  { type: 'IFCFOOTING',        label: 'Semelle',            aliases: ['semelle', 'footing', 'fondation'], category: 'foundations', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCPILE',           label: 'Pieu',               aliases: ['pieu', 'pile', 'micropieu'], category: 'foundations', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── Mobilier ──────────────────────────────────────────────────────────────
  { type: 'IFCFURNITURE',      label: 'Mobilier',           aliases: ['meuble', 'furniture', 'mobilier'], category: 'furnishings', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCSYSTEMFURNITUREELEMENT', label: 'Mobilier système', aliases: ['mobilier systeme', 'system furniture', 'cloison amovible'], category: 'furnishings', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── MEP Distribution générique ────────────────────────────────────────────
  { type: 'IFCDISTRIBUTIONELEMENT', label: 'Élément de distribution', aliases: ['distribution', 'reseau', 'mep'], category: 'mep_distribution', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCDISTRIBUTIONCONTROLELEMENT', label: 'Contrôle distribution', aliases: ['controle', 'control', 'regulation'], category: 'mep_distribution', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCDISTRIBUTIONFLOWELEMENT', label: 'Élément de flux', aliases: ['flux', 'flow'], category: 'mep_distribution', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCDISTRIBUTIONCHAMBERELEMENT', label: 'Chambre / Regard', aliases: ['chambre', 'regard', 'chamber'], category: 'mep_distribution', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCDISTRIBUTIONPORT', label: 'Port de connexion', aliases: ['port', 'connecteur', 'connector'], category: 'mep_distribution', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── MEP Plomberie / CVC ───────────────────────────────────────────────────
  { type: 'IFCFLOWSEGMENT',    label: 'Segment (tuyau/gaine)', aliases: ['tuyau', 'pipe', 'gaine', 'duct', 'tube', 'segment'], category: 'mep_flow', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCFLOWFITTING',    label: 'Raccord',            aliases: ['raccord', 'fitting', 'coude', 'te'], category: 'mep_flow', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCFLOWCONTROLLER', label: 'Contrôleur de flux', aliases: ['vanne', 'valve', 'controller', 'robinet'], category: 'mep_flow', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCFLOWMOVINGDEVICE', label: 'Équipement moteur', aliases: ['pompe', 'pump', 'ventilateur', 'fan', 'compresseur'], category: 'mep_flow', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCFLOWSTORAGEDEVICE', label: 'Stockage',         aliases: ['ballon', 'tank', 'reservoir', 'cuve'], category: 'mep_flow', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCFLOWTREATMENTDEVICE', label: 'Traitement',     aliases: ['filtre', 'filter', 'traitement', 'treatment'], category: 'mep_flow', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCENERGYCONVERSIONDEVICE', label: 'Conversion d\'énergie', aliases: ['chaudiere', 'boiler', 'pac', 'heat pump', 'echangeur'], category: 'mep_flow', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── MEP Électricité ───────────────────────────────────────────────────────
  { type: 'IFCCABLECARRIERFITTING', label: 'Raccord chemin de câbles', aliases: ['chemin cables raccord', 'cable carrier fitting'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCCABLECARRIERSEGMENT', label: 'Chemin de câbles',  aliases: ['chemin de cables', 'cable carrier', 'goulotte'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCCABLEFITTING',   label: 'Raccord câble',       aliases: ['raccord cable', 'cable fitting'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCCABLESEGMENT',   label: 'Câble',               aliases: ['cable', 'fil', 'wire'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCJUNCTIONBOX',    label: 'Boîte de jonction',   aliases: ['boite jonction', 'junction box', 'derivation'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCSWITCHINGDEVICE',label: 'Interrupteur',        aliases: ['interrupteur', 'switch', 'disjoncteur', 'breaker'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCELECTRICAPPLIANCE', label: 'Appareil électrique', aliases: ['appareil electrique', 'electric appliance', 'electromenager'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCELECTRICDISTRIBUTIONBOARD', label: 'Tableau électrique', aliases: ['tableau electrique', 'electrical panel', 'tge'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCELECTRICFLOWSTORAGEDEVICE', label: 'Stockage électrique', aliases: ['batterie', 'battery', 'ups', 'onduleur'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCELECTRICGENERATOR', label: 'Générateur électrique', aliases: ['generateur', 'generator', 'alternateur'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCELECTRICMOTOR',  label: 'Moteur électrique',   aliases: ['moteur', 'motor'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCELECTRICTIMECONTROL', label: 'Programmateur', aliases: ['programmateur', 'time control', 'horloge'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCTRANSFORMER',    label: 'Transformateur',     aliases: ['transformateur', 'transformer', 'tgbt'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCPROTECTIVEDEVICE', label: 'Dispositif de protection', aliases: ['protection', 'fuse', 'fusible', 'differentiel'], category: 'mep_electrical', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── MEP Terminaux ─────────────────────────────────────────────────────────
  { type: 'IFCAIRTERMINAL',    label: 'Bouche d\'air',      aliases: ['bouche air', 'air terminal', 'grille', 'diffuseur'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCAIRTERMINALBOX', label: 'Caisson terminal air', aliases: ['caisson air', 'air terminal box', 'cta'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCSANITARYTERMINAL', label: 'Appareil sanitaire', aliases: ['lavabo', 'wc', 'douche', 'baignoire', 'toilette', 'sanitary'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCLAMP',           label: 'Lampe / Luminaire',  aliases: ['lampe', 'lamp', 'luminaire', 'light fixture'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCLIGHTFIXTURE',   label: 'Appareil d\'éclairage', aliases: ['eclairage', 'light fixture'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCFIRESUPPRESSIONTERMINAL', label: 'Terminal incendie', aliases: ['sprinkler', 'incendie', 'fire suppression', 'extincteur'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCSPACEHEATER',    label: 'Radiateur',          aliases: ['radiateur', 'space heater', 'convecteur', 'chauffage'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCSTACKTERMINAL',  label: 'Terminal de souche', aliases: ['souche', 'stack', 'mitron'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCWASTETERMINAL',  label: 'Évacuation',         aliases: ['evacuation', 'waste', 'siphon', 'avaloir'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCAUDIOVISUALAPPLIANCE', label: 'Audio-visuel', aliases: ['ecran', 'tv', 'haut parleur', 'speaker', 'projecteur'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCCOMMUNICATIONSAPPLIANCE', label: 'Communication', aliases: ['telephone', 'antenne', 'communication', 'reseau'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCALARM',          label: 'Alarme / Détecteur',  aliases: ['alarme', 'alarm', 'detecteur fumee', 'sas'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCSENSOR',         label: 'Capteur',            aliases: ['capteur', 'sensor', 'sonde'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCACTUATOR',       label: 'Actionneur',         aliases: ['actionneur', 'actuator', 'verin'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCCONTROLLER',     label: 'Contrôleur',         aliases: ['controleur', 'controller', 'regulateur'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCFLOWMETER',      label: 'Compteur',           aliases: ['compteur', 'meter', 'flow meter'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCOUTLET',         label: 'Prise',              aliases: ['prise', 'outlet', 'socket'], category: 'mep_terminals', tier: 'standard', predefined: '.NOTDEFINED.' },

  // ── Génie civil ───────────────────────────────────────────────────────────
  { type: 'IFCCIVILELEMENT',   label: 'Élément de génie civil', aliases: ['genie civil', 'civil', 'voirie'], category: 'civil', tier: 'standard', predefined: null },
  { type: 'IFCGEOGRAPHICELEMENT', label: 'Élément géographique', aliases: ['geographique', 'geographic', 'terrain'], category: 'civil', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCEARTHWORKSELEMENT', label: 'Terrassement',     aliases: ['terrassement', 'earthworks', 'remblai', 'deblai'], category: 'civil', tier: 'standard', predefined: null },

  // ── Spatial (non reclassifiable) ──────────────────────────────────────────
  { type: 'IFCSPACE',          label: 'Espace',             aliases: ['espace', 'space', 'piece', 'room', 'local'], category: 'spatial', tier: 'unsupported', reason: 'Structure spatiale (10 attrs avec ElevationWithFlooring) — édition non supportée en v1' },
  { type: 'IFCZONE',           label: 'Zone',               aliases: ['zone'], category: 'spatial', tier: 'unsupported', reason: 'Élément de groupement, pas un élément physique' },
  { type: 'IFCBUILDINGSTOREY', label: 'Étage',              aliases: ['etage', 'storey', 'niveau', 'level'], category: 'spatial', tier: 'unsupported', reason: 'Structure spatiale — modifier via spatial tree' },

  // ── Divers ────────────────────────────────────────────────────────────────
  { type: 'IFCBUILDINGELEMENTPROXY', label: 'Élément générique', aliases: ['proxy', 'generique', 'inconnu', 'autre'], category: 'misc', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCFURNISHINGELEMENT', label: 'Équipement',     aliases: ['equipement', 'furnishing'], category: 'misc', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCELEMENTASSEMBLY', label: 'Assemblage',       aliases: ['assemblage', 'assembly', 'ensemble'], category: 'misc', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCDISCRETEACCESSORY', label: 'Accessoire',     aliases: ['accessoire', 'accessory'], category: 'misc', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCFASTENER',       label: 'Attache',            aliases: ['attache', 'fastener', 'cheville'], category: 'misc', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCMECHANICALFASTENER', label: 'Attache mécanique', aliases: ['attache mecanique', 'mechanical fastener', 'boulon', 'vis'], category: 'misc', tier: 'standard', predefined: '.NOTDEFINED.' },
  { type: 'IFCVIRTUALELEMENT', label: 'Élément virtuel',    aliases: ['virtuel', 'virtual'], category: 'misc', tier: 'standard', predefined: null },
  { type: 'IFCTRANSPORTELEMENT', label: 'Transport (ascenseur, escalator)', aliases: ['ascenseur', 'elevator', 'escalator', 'tapis'], category: 'misc', tier: 'standard', predefined: '.NOTDEFINED.' },
];

/**
 * Build a fast lookup index for filtering.
 * Returns a Map<type, entry> and a flat array.
 */
export function buildIfcCatalog() {
  const byType = new Map();
  for (const entry of IFC_TYPES) {
    byType.set(entry.type, entry);
  }
  return { byType, all: IFC_TYPES };
}

/**
 * Get the list of types that the patcher actually supports for reclassification.
 * (Used by /api/reclassifiable-types to filter the picker.)
 */
export function reclassifiableTypeNames() {
  return IFC_TYPES
    .filter(t => t.tier !== 'unsupported')
    .map(t => t.type);
}

/**
 * Normalize a string for fuzzy search: lowercase, no accents, trim.
 */
export function normalizeSearch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Fuzzy filter the catalog entries against a query string.
 * Returns matching entries, ordered by relevance:
 *   1. exact type match
 *   2. label or alias starts with query
 *   3. label or alias contains query
 */
export function filterCatalog(query) {
  const q = normalizeSearch(query);
  if (!q) return IFC_TYPES;

  const scored = [];
  for (const entry of IFC_TYPES) {
    const typeNorm = normalizeSearch(entry.type);
    const labelNorm = normalizeSearch(entry.label);
    const aliasesNorm = entry.aliases.map(normalizeSearch);

    let score = 0;
    if (typeNorm === q) score = 1000;
    else if (typeNorm.startsWith(q)) score = 900;
    else if (labelNorm === q) score = 800;
    else if (labelNorm.startsWith(q)) score = 700;
    else if (aliasesNorm.some(a => a === q)) score = 600;
    else if (aliasesNorm.some(a => a.startsWith(q))) score = 500;
    else if (typeNorm.includes(q)) score = 400;
    else if (labelNorm.includes(q)) score = 300;
    else if (aliasesNorm.some(a => a.includes(q))) score = 200;

    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.entry);
}
