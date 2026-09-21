// Smelt Studio — catalogue des équipements.
// Les modèles sont générés par le code (equipment-models.js) à partir des dimensions :
// changer la largeur d'un plan de travail ne l'épaissit pas, changer la hauteur d'un évier
// ne rapetisse pas son robinet.
//
// Convention des dimensions : largeur × profondeur × hauteur de l'enveloppe principale.
// Pour les meubles de cuisine et l'évier, la hauteur est celle du plan de travail
// (le robinet vient en plus). zOffset : hauteur de pose au-dessus du sol.
//
// Pour utiliser un modèle GLB à la place d'un modèle généré, ajouter `asset: '/assets/…glb'`.

export const EQUIPMENT_GROUPS = {
  sanitary: 'Salle de bain',
  kitchen: 'Cuisine',
  living: 'Séjour et chambres',
};

const S = 'IFCSANITARYTERMINAL';
const F = 'IFCFURNITURE';
const E = 'IFCELECTRICAPPLIANCE';

export const EQUIPMENT_TYPES = {
  // — Salle de bain —
  wc: { label: 'WC', group: 'sanitary', width: 0.36, depth: 0.66, height: 0.78, ifcClass: S, ifcPredefined: 'TOILETPAN' },
  basin: { label: 'Lavabo sur colonne', group: 'sanitary', width: 0.55, depth: 0.45, height: 0.85, ifcClass: S, ifcPredefined: 'WASHHANDBASIN' },
  vanity: { label: 'Meuble vasque', group: 'sanitary', width: 0.80, depth: 0.46, height: 0.85, ifcClass: S, ifcPredefined: 'WASHHANDBASIN' },
  shower: { label: 'Douche', group: 'sanitary', width: 0.90, depth: 0.90, height: 2.00, ifcClass: S, ifcPredefined: 'SHOWER' },
  bath: { label: 'Baignoire', group: 'sanitary', width: 1.70, depth: 0.75, height: 0.58, ifcClass: S, ifcPredefined: 'BATH' },
  washer: { label: 'Lave-linge', group: 'sanitary', width: 0.60, depth: 0.60, height: 0.85, ifcClass: E, ifcPredefined: 'WASHINGMACHINE' },
  towelDryer: { label: 'Sèche-serviettes', group: 'sanitary', width: 0.50, depth: 0.10, height: 1.20, zOffset: 0.2, ifcClass: F, ifcPredefined: 'NOTDEFINED' },

  // — Cuisine —
  sink: { label: 'Évier', group: 'kitchen', width: 0.80, depth: 0.60, height: 0.90, ifcClass: S, ifcPredefined: 'SINK' },
  baseCabinet: { label: 'Meuble bas', group: 'kitchen', width: 0.60, depth: 0.60, height: 0.90, ifcClass: F, ifcPredefined: 'SHELF' },
  worktop: { label: 'Linéaire de cuisine', group: 'kitchen', width: 1.20, depth: 0.60, height: 0.90, ifcClass: F, ifcPredefined: 'SHELF' },
  wallCabinet: { label: 'Meuble haut', group: 'kitchen', width: 0.60, depth: 0.35, height: 0.70, zOffset: 1.40, ifcClass: F, ifcPredefined: 'SHELF' },
  cooktop: { label: 'Plaque de cuisson', group: 'kitchen', width: 0.60, depth: 0.60, height: 0.90, ifcClass: E, ifcPredefined: 'ELECTRICCOOKER' },
  oven: { label: 'Four encastré', group: 'kitchen', width: 0.60, depth: 0.60, height: 0.90, ifcClass: E, ifcPredefined: 'ELECTRICCOOKER' },
  dishwasher: { label: 'Lave-vaisselle', group: 'kitchen', width: 0.60, depth: 0.60, height: 0.90, ifcClass: E, ifcPredefined: 'DISHWASHER' },
  fridge: { label: 'Réfrigérateur', group: 'kitchen', width: 0.60, depth: 0.65, height: 1.85, ifcClass: E, ifcPredefined: 'REFRIGERATOR' },
  hood: { label: 'Hotte', group: 'kitchen', width: 0.60, depth: 0.50, height: 0.80, zOffset: 1.55, ifcClass: E, ifcPredefined: 'NOTDEFINED' },

  // — Séjour et chambres —
  bedDouble: { label: 'Lit double', model: 'bed', group: 'living', width: 1.60, depth: 2.00, height: 0.50, ifcClass: F, ifcPredefined: 'BED' },
  bedSingle: { label: 'Lit simple', model: 'bed', group: 'living', width: 0.90, depth: 1.90, height: 0.50, ifcClass: F, ifcPredefined: 'BED' },
  sofa: { label: 'Canapé', group: 'living', width: 2.00, depth: 0.90, height: 0.85, ifcClass: F, ifcPredefined: 'SOFA' },
  table: { label: 'Table', group: 'living', width: 1.60, depth: 0.90, height: 0.75, ifcClass: F, ifcPredefined: 'TABLE' },
  chair: { label: 'Chaise', group: 'living', width: 0.45, depth: 0.50, height: 0.90, ifcClass: F, ifcPredefined: 'CHAIR' },
  desk: { label: 'Bureau', group: 'living', width: 1.20, depth: 0.60, height: 0.75, ifcClass: F, ifcPredefined: 'DESK' },
  wardrobe: { label: 'Armoire', group: 'living', width: 1.20, depth: 0.60, height: 2.10, ifcClass: F, ifcPredefined: 'SHELF' },
  radiator: { label: 'Radiateur', group: 'living', width: 0.80, depth: 0.10, height: 0.60, zOffset: 0.15, ifcClass: F, ifcPredefined: 'NOTDEFINED' },
};

// Anciens identifiants de types, pour ouvrir les projets existants
export const EQUIPMENT_ALIASES = {};

export function equipmentIfcSpec(item) {
  const cat = EQUIPMENT_TYPES[item?.type];
  if (cat) {
    return {
      label: cat.label,
      entity: cat.ifcClass,
      predefined: cat.ifcPredefined,
      width: cat.width,
      depth: cat.depth,
      height: cat.height,
    };
  }
  return {
    label: item?.type || 'Équipement',
    entity: F,
    predefined: 'NOTDEFINED',
    width: 0.60,
    depth: 0.60,
    height: 0.90,
  };
}
