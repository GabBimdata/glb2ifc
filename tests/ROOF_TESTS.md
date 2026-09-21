# Vérification des combles et ouvertures de toiture

Lancer `npm test` (ou `bun run test`) pour **tous** les tests, y compris le Studio.
Lancer `npm run check` pour la syntaxe et les garde-fous existants.
Les tests du Studio n'étaient auparavant pas inclus dans `npm test`.

`studio-roof-openings.test.js` contient des cas synthétiques reproductibles.
Le fichier personnel fourni pour le diagnostic n'est pas inclus dans le dépôt.

| Cas | Vérification |
| --- | --- |
| Pignons avec fenêtres | Mur continu jusqu'au rampant, ouverture réellement vide, maçonnerie conservée au-dessus du faux plafond, pas de panneau plein superposé |
| Fenêtres de toit | Deux pans, quatre pans, monopente et plat ; trois rotations ; jambettes de 0, 0,9 et 1,5 m ; altitude du corps décalée |
| Jacobines et chiens-assis | Trois types, trois rotations, plafond activé/désactivé ; volume intérieur dégagé sous la lucarne |
| Quatre jacobines | Deux par versant ; aire de toiture conservée après retrait des quatre ouvertures ; aucune surface ne rebouche les trous |
| Faux plafond | Percé sous la fenêtre de toit ; partie extérieure au percement conservée |
| Rives et faîtage | Recalage exact des allèges trop basses/hautes, faîtage tourné, débord nul, intervalle de placement très étroit |
| Géométrie impossible | Dimensions invalides, ouverture trop large, hors toiture, chevauchement, lucarne sur toit plat : diagnostic explicite |
| Plusieurs corps et niveaux | Mur partagé limité par l'enveloppe la plus haute, ordre des pièces, duplication, aller-retour JSON, toiture désactivée |
| Emprises et surfaces | Toit à croupe carré, contour en L, pièce concave, pans superposés, plafond sous 1,80 m |
| Export | Percements IFC avec extrusions positives ; vitrage de jacobine transparent dans la scène commune à la 3D et au GLB |

Les contrôles de percement comparent les triangles générés avec l'emprise des
ouvertures. Les contrôles d'aire vérifient la conservation des surfaces et l'absence
de double comptage. Ils ne se limitent pas à compter les objets produits.

## Vérification visuelle avant fusion

1. Ouvrir le projet de reproduction dans le Studio et afficher le dernier niveau.
2. Examiner les deux pignons depuis l'extérieur et l'intérieur : les fenêtres
   doivent percer le mur et le pignon doit continuer au-dessus du faux plafond.
3. Vérifier les quatre jacobines, puis déplacer l'une près d'une rive ou du faîtage.
   Une position impossible doit afficher une explication dans l'inspecteur.
4. Ajouter une fenêtre de toit avec une allège traversant la hauteur du faux
   plafond ; vérifier le percement depuis la pièce.
5. Exporter GLB et IFC puis les ouvrir dans la visionneuse habituelle.

Le projet fourni a aussi été construit et exporté localement : quatre jacobines,
IFC relu et maillé par web-ifc, GLB relu par glTF Transform. Deux fenêtres de façade
sur les côtés bas dépassent encore le rampant et une porte dépasse de 13 cm : ces
positions sont signalées, pas déplacées automatiquement.

## Limites explicites

Cette matrice n'est pas une preuve d'exhaustivité pour toute géométrie possible.
Les lucarnes doivent tenir sur un seul pan ; les ouvertures qui se chevauchent sont
refusées (la première valide est conservée). Les emprises non orthogonales gardent
l'approximation existante par rectangle englobant. Les raccords constructifs,
solins et habillages du puits de lumière ne sont pas modélisés ici.
Les toitures complexes composées de plusieurs rectangles conservent leur méthode
de génération existante ; seule leur enveloppe intérieure est dédupliquée.
