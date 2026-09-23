// Smelt Studio — catalogue d'éléments (valeurs modifiables ici sans toucher au reste du code).

export const DEFAULTS = {
  levelHeight: 2.8,     // hauteur d'étage, sol fini à sol fini (m)
  slabThickness: 0.2,   // épaisseur des planchers (m)
  gridStep: 0.05,       // pas d'aimantation (m)
};

// Réglage unique du vitrage.
// Three.js / GLB utilisent une opacité (0 = invisible, 1 = opaque).
// IFC utilise une transparence (0 = opaque, 1 = totalement transparent).
export const GLASS_OPACITY = 0.45;
export const IFC_GLASS_TRANSPARENCY = 1 - GLASS_OPACITY;

export const WALL_TYPES = {
  ext30: { label: 'Mur extérieur 30 cm', thickness: 0.30, category: 'exterior', ifc: 'IfcWall', material: 'Maçonnerie' },
  ext20: { label: 'Mur extérieur 20 cm', thickness: 0.20, category: 'exterior', ifc: 'IfcWall', material: 'Maçonnerie' },
  int15: { label: 'Mur porteur intérieur 15 cm', thickness: 0.15, category: 'interior', ifc: 'IfcWall', material: 'Maçonnerie' },
  part10: { label: 'Cloison 10 cm', thickness: 0.10, category: 'partition', ifc: 'IfcWall', material: 'Plaque de plâtre' },
  part7: { label: 'Cloison 7 cm', thickness: 0.07, category: 'partition', ifc: 'IfcWall', material: 'Plaque de plâtre' },
};

export const OPENING_TYPES = {
  door: { label: 'Porte', kind: 'door', width: 0.9, height: 2.15, sill: 0 },
  doorDouble: { label: 'Porte double', kind: 'door', width: 1.4, height: 2.15, sill: 0 },
  garageDoor: { label: 'Porte de garage', kind: 'door', operation: 'sectional', width: 2.4, height: 2.0, sill: 0 },
  window: { label: 'Fenêtre', kind: 'window', width: 1.2, height: 1.25, sill: 0.95 },
  windowSmall: { label: 'Petite fenêtre', kind: 'window', width: 0.6, height: 0.75, sill: 1.35 },
  frenchWindow: { label: 'Porte-fenêtre', kind: 'window', width: 1.4, height: 2.15, sill: 0 },
  bay: { label: 'Baie vitrée', kind: 'window', width: 2.4, height: 2.15, sill: 0 },
};

// Balcons et terrasses
export const RAILING_TYPES = {
  glass: 'Vitré',
  bars: 'Barreaudé',
  wall: 'Maçonné',
};
export const BALCONY = { label: 'Balcon en saillie', width: 3.0, depth: 1.2, thickness: 0.18, railing: 'bars', railingHeight: 1.0 };

export const SKYLIGHT = { label: 'Fenêtre de toit', width: 0.78, height: 1.18, sill: 1.1 };

// Ouvertures de toiture : fenêtre de toit et lucarnes
export const ROOF_OPENINGS = {
  skylight: { label: 'Fenêtre de toit', kind: 'skylight', width: 0.78, height: 1.18, sill: 1.1 },
  // Lucarnes : égout (eave) et allège (winSill) sont mesurés depuis le plancher de l'étage,
  // comme pour une fenêtre de toit. wallHeight ne sert qu'à relire les projets antérieurs,
  // où la façade était mesurée depuis le dessus de la couverture.
  dormerGable: { label: 'Jacobine deux pans', kind: 'dormer', dormer: 'gable', width: 1.6, eave: 2.5, pitch: 40, setback: 0.4, winHeight: 1.2, winSill: 0.95, wallHeight: 1.5 },
  dormerHip: { label: 'Jacobine à croupe', kind: 'dormer', dormer: 'hip', width: 1.6, eave: 2.5, pitch: 40, setback: 0.4, winHeight: 1.2, winSill: 0.95, wallHeight: 1.5 },
  dormerShed: { label: 'Chien-assis', kind: 'dormer', dormer: 'shed', width: 2.2, eave: 2.4, pitch: 15, depth: 2, setback: 0.4, winHeight: 1.1, winSill: 0.95, wallHeight: 1.4 },
};

export const ROOM_NAMES = [
  'Séjour', 'Cuisine', 'Salon', 'Salle à manger', 'Entrée', 'Dégagement', 'Chambre',
  'Salle de bain', "Salle d'eau", 'WC', 'Bureau', 'Buanderie', 'Cellier', 'Garage', 'Rangement', 'Palier',
];

export const ROOF_TYPES = {
  gable: 'Deux pans',
  hip: 'Quatre pans',
  shed: 'Un pan',
  flat: 'Toit plat',
};

export const COLOR_LABELS = {
  exterior: 'Murs extérieurs',
  interior: 'Murs porteurs',
  partition: 'Cloisons',
  slab: 'Planchers',
  balcony: 'Balcons et terrasses',
  railing: 'Garde-corps',
  stair: 'Escaliers',
  ceiling: 'Plafonds',
  roof: 'Toiture',
  gable: 'Pignons',
  door: 'Portes',
  window: 'Vitrages',
  frame: 'Menuiseries',
};

export const COLORS = {
  exterior: '#e9e4dc',
  interior: '#ece8e1',
  partition: '#f4f2ee',
  slab: '#c9c4bb',
  balcony: '#d3cdc2',
  railing: '#3b4247',
  stair: '#b08a62',
  ceiling: '#f2efe9',
  roof: '#9b5a43',
  gable: '#e9e4dc',
  door: '#8a6a4a',
  window: '#9cc3d6',
  frame: '#f4f4f2',
};

// Couleurs effectives : valeurs d'origine, puis celles du projet, puis celles du corps.
export function colorsOf(project, body = null) {
  return { ...COLORS, ...(project?.colors || {}), ...(body?.colors || {}) };
}
