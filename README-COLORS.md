# Couleurs GLB → IFC

## Comportement V8

Le convertisseur conserve les couleurs GLB quand elles sont réellement informatives : rouge, bleu, bois, verre, métal, etc.

En revanche, beaucoup de GLB importés contiennent un matériau générique blanc sur tous les meshes. Avant la V8, ce blanc était considéré comme une couleur source valide, donc le fallback par type IFC ne s'appliquait pas et le viewer affichait des modèles presque tout blancs.

Depuis la V8 :

- couleur GLB non neutre → conservée ;
- blanc / noir / gris générique → remplacé par une couleur fallback selon la classe détectée ;
- aucun matériau source → couleur fallback selon la classe détectée.

## Forcer la conservation des blancs source

Si tu veux préserver les matériaux blancs/neutres venant du GLB :

```bash
GLB2IFC_PRESERVE_DEFAULT_COLORS=1 bun dev
```

## Vérifier que le fallback s'applique

Après conversion, le terminal doit afficher par exemple :

```txt
Applied fallback colors on 18 element(s)
```

Si ça affiche toujours `0`, c'est que le GLB contient des couleurs non neutres jugées utiles, ou que l'IFC affiché vient d'une ancienne conversion.
