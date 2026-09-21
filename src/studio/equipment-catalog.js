// Smelt Studio - catalogue unique des équipements.
// Pour remplacer un modèle, conserver simplement le même nom de fichier GLB.
// Le chargeur recalcule automatiquement les dimensions natives du GLB pour
// les nouveaux éléments placés dans le projet.

export const EQUIPMENT_TYPES = {
  wc: {
    label: 'WC',
    group: 'sanitary',
    width: 0.356, depth: 0.666, height: 0.778, zOffset: 0,
    asset: '/assets/equipment/wc.glb',
    ifcClass: 'IFCSANITARYTERMINAL',
    ifcPredefined: 'TOILETPAN',
    exactAsset: true,
  },
  basin: {
    label: 'Lavabo',
    group: 'sanitary',
    width: 0.403, depth: 0.511, height: 0.928, zOffset: 0,
    asset: '/assets/equipment/lavabo.glb',
    ifcClass: 'IFCSANITARYTERMINAL',
    ifcPredefined: 'WASHHANDBASIN',
    exactAsset: true,
  },
  shower: {
    label: 'Douche',
    group: 'sanitary',
    width: 0.900, depth: 0.900, height: 0.0374, zOffset: 0,
    asset: '/assets/equipment/douche.glb',
    ifcClass: 'IFCSANITARYTERMINAL',
    ifcPredefined: 'SHOWER',
    exactAsset: true,
  },
  bath: {
    label: 'Baignoire',
    group: 'sanitary',
    width: 1.70, depth: 0.75, height: 0.58, zOffset: 0,
    asset: '/assets/equipment/baignoire.glb',
    ifcClass: 'IFCSANITARYTERMINAL',
    ifcPredefined: 'BATH',
    exactAsset: true,
  },
  sink: {
    label: 'Évier',
    group: 'kitchen',
    width: 0.808, depth: 0.607, height: 1.123, zOffset: 0,
    asset: '/assets/equipment/evier.glb',
    ifcClass: 'IFCSANITARYTERMINAL',
    ifcPredefined: 'SINK',
    exactAsset: true,
  },
  baseCabinet: {
    label: 'Meuble bas',
    group: 'kitchen',
    width: 0.60, depth: 0.60, height: 0.90, zOffset: 0,
    asset: '/assets/equipment/meuble_bas_60.glb',
    ifcClass: 'IFCFURNITURE',
    ifcPredefined: 'NOTDEFINED',
    exactAsset: true,
  },
  wallCabinet: {
    label: 'Meuble haut',
    group: 'kitchen',
    width: 0.60, depth: 0.35, height: 0.70, zOffset: 1.40,
    asset: '/assets/equipment/meuble_haut_60.glb',
    ifcClass: 'IFCFURNITURE',
    ifcPredefined: 'NOTDEFINED',
    exactAsset: true,
  },
  fridge: {
    label: 'Réfrigérateur',
    group: 'kitchen',
    width: 0.60, depth: 0.65, height: 1.90, zOffset: 0,
    asset: '/assets/equipment/frigo_60.glb',
    ifcClass: 'IFCFURNITURE',
    ifcPredefined: 'NOTDEFINED',
    exactAsset: true,
  },
  cooktop: {
    label: 'Plaque cuisson',
    group: 'kitchen',
    width: 0.60, depth: 0.60, height: 0.91, zOffset: 0,
    asset: '/assets/equipment/plaque_60.glb',
    ifcClass: 'IFCFURNITURE',
    ifcPredefined: 'NOTDEFINED',
    exactAsset: true,
  },
  worktop: {
    label: 'Plan de travail',
    group: 'kitchen',
    width: 1.20, depth: 0.60, height: 0.92, zOffset: 0,
    asset: '/assets/equipment/plan_travail_120.glb',
    ifcClass: 'IFCFURNITURE',
    ifcPredefined: 'NOTDEFINED',
    exactAsset: true,
  },
};

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
      exactAsset: cat.exactAsset,
    };
  }

  return {
    label: item?.type || 'Équipement',
    entity: 'IFCFURNITURE',
    predefined: 'NOTDEFINED',
    width: 0.60,
    depth: 0.60,
    height: 0.90,
    exactAsset: false,
  };
}
