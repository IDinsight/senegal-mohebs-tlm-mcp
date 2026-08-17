# Générer du matériel pédagogique

Vous pouvez générer **n'importe quel document défini dans le graphe** — un **cours** entier, ou seulement une partie (un chapitre, une leçon). Ce que vous produisez n'est pas une liste figée de modèles : tout dépend de ce qui a été construit dans le curriculum, formatters compris.

## Ce qu'on peut produire dépend du graphe

Un **cours** est la racine d'un document. Plusieurs cours peuvent coexister dans une même matière, et d'autres peuvent être créés par un concepteur (voir [Ajouter et modifier un cours et ses leçons](courses-lessons.md)).

!!! example "Exemple : les mathématiques de CI"
    En mathématiques CI, deux cours coexistent aujourd'hui : le **manuel de l'élève** et le **guide de l'enseignant** (les fiches de leçons). Ce ne sont pas des types de documents « en dur » dans l'outil — ce sont deux cours *du graphe*. Créez-en un troisième, et il devient générable au même titre.

Vous pouvez générer un cours **en entier** ou seulement **une partie** : un chapitre, une leçon, une plage de leçons.

## Ce que la génération utilise

Quand vous demandez un document, Claude ne part pas d'une page blanche : il s'appuie sur ce qui a été construit dans le graphe.

- La **structure des leçons** vient des [routines pédagogiques](routines.md) appliquées à chaque leçon.
- La **mise en forme** vient du [formatter](formatters.md) appliqué au cours — palette, typographie, mise en page, style des illustrations.
- Le **contenu** et les **objectifs à couvrir** viennent des [standards](build-standards.md) et de leurs alignements.

Autrement dit : ce qui sort — le fond *et* la forme — est décidé par le graphe. Mieux le curriculum est préparé, meilleur et plus régulier est le document produit.

L'outil veille aussi à ce que les documents restent **cohérents** (mêmes personnages, même terminologie, couverture des notions) et **variés** au bon endroit (les domaines d'exemples — fruits, légumes… — tournent d'un chapitre à l'autre).

## Comment ça se passe

1. **Choisissez l'espace, la classe et la matière** (voir [Prise en main](getting-started.md)).
2. **Demandez ce que vous voulez générer** — un cours entier, ou une partie précise :

    > « Génère le manuel de l'élève. »
    >
    > « Génère le chapitre 5 du manuel de l'élève. »
    >
    > « Prépare les fiches de la leçon “Comparer deux nombres”. »

3. **Claude prépare le contexte** automatiquement : la partie du graphe concernée, les routines et le formatter attachés, les personnages déjà utilisés, la terminologie, les notions à couvrir, et une suggestion de domaine d'exemples qui ne répète pas les chapitres voisins.
4. **Claude rédige le document.**
5. **Vous validez l'enregistrement.** Avant que le document soit enregistré, une **demande de confirmation** apparaît. Rien n'est enregistré tant que vous n'avez pas accepté.

<!-- SCREENSHOT : boîte de dialogue de confirmation d'enregistrement -->

## La confirmation d'enregistrement

!!! warning "Écriture immédiate — pas de brouillon"
    Enregistrer un document écrit **directement** dans l'espace partagé : c'est **immédiat, sans annulation**. La demande de confirmation indique exactement ce qui va être écrit. Lisez-la, puis acceptez ou refusez.

    (C'est différent des modifications du curriculum, qui passent d'abord par un brouillon — voir [Relire, publier ou abandonner un brouillon](review-approve.md).)

## Conseils

- **Précisez ce que vous voulez générer** : le cours entier, un chapitre, une leçon. Si vous ne savez pas ce qui existe, demandez « quels cours et quels chapitres existent ? ».
- **Certains documents s'appuient sur d'autres.** Par exemple, les fiches de leçons s'appuient sur le manuel : si vous préparez les deux, faites le manuel d'abord.
- **Vérifiez la variété des exemples.** Pour voir quels domaines d'exemples ont déjà été utilisés :

    > « Quels domaines d'exemples ont été utilisés dans les chapitres récents ? »

- **Prévisualisez un brouillon avant de publier.** Si vous testez une modification du curriculum, vous pouvez voir le document qui en sortirait **sans rien publier** — voir [Prévisualiser avant de publier](courses-lessons.md).

## Retrouver un document déjà produit

> « Liste les documents de ce cours. »

Claude vous indique ce qui existe déjà et peut vous fournir un lien de téléchargement.
