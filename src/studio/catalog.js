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
  window: { label: 'Fenêtre', kind: 'window', width: 1.2, height: 1.25, sill: 0.95 },
  windowSmall: { label: 'Petite fenêtre', kind: 'window', width: 0.6, height: 0.75, sill: 1.35 },
  frenchWindow: { label: 'Porte-fenêtre', kind: 'window', width: 1.4, height: 2.15, sill: 0 },
  bay: { label: 'Baie vitrée', kind: 'window', width: 2.4, height: 2.15, sill: 0 },
};

export const SKYLIGHT = { label: 'Fenêtre de toit', width: 0.78, height: 1.18, sill: 1.1 };

// Ouvertures de toiture : fenêtre de toit et lucarnes
export const ROOF_OPENINGS = {
  skylight: { label: 'Fenêtre de toit', kind: 'skylight', width: 0.78, height: 1.18, sill: 1.1 },
  dormerGable: { label: 'Jacobine deux pans', kind: 'dormer', dormer: 'gable', width: 1.6, wallHeight: 1.5, pitch: 40, setback: 0.4, winHeight: 1.0, winSill: 0.5 },
  dormerHip: { label: 'Jacobine à croupe', kind: 'dormer', dormer: 'hip', width: 1.6, wallHeight: 1.5, pitch: 40, setback: 0.4, winHeight: 1.0, winSill: 0.5 },
  dormerShed: { label: 'Chien-assis', kind: 'dormer', dormer: 'shed', width: 2.2, wallHeight: 1.4, pitch: 15, depth: 2, setback: 0.4, winHeight: 0.95, winSill: 0.45 },
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
