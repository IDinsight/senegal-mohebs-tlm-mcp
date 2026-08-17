# Générer du matériel pédagogique

Vous pouvez produire deux types de documents pour un chapitre :

- le **manuel de l'élève** ;
- les **fiches de leçons** (le guide de l'enseignant).

L'outil s'assure que les documents restent **cohérents** (mêmes personnages, même terminologie, couverture des notions) et **variés** au bon endroit (les domaines d'exemples — fruits, légumes… — tournent d'un chapitre à l'autre).

## Ce que la génération utilise

Quand vous demandez un document, Claude ne part pas d'une page blanche : il s'appuie sur ce qui a été construit dans le curriculum.

- La **structure des leçons** vient des [routines pédagogiques](routines.md) appliquées à chaque leçon.
- La **mise en forme** vient du [formatter](formatters.md) appliqué au cours.
- Le **contenu** et les **objectifs à couvrir** viennent du [graphe](build-standards.md) et de ses alignements.

Autrement dit : mieux le curriculum est préparé, meilleur — et plus régulier — est le document produit.

## Comment ça se passe

1. **Choisissez l'espace, la classe et la matière** (voir [Prise en main](getting-started.md)).
2. **Demandez le document.** Par exemple :

    > « Génère le manuel de l'élève pour le chapitre 5. »
    >
    > « Prépare les fiches de leçons du chapitre 5. »

3. **Claude prépare le contexte** automatiquement : la partie du curriculum concernée, les personnages déjà utilisés, la terminologie, les notions à couvrir, et une suggestion de domaine d'exemples qui ne répète pas les chapitres voisins.
4. **Claude rédige le document.**
5. **Vous validez l'enregistrement.** Avant que le document soit enregistré, une **demande de confirmation** apparaît. Rien n'est enregistré tant que vous n'avez pas accepté.

<!-- SCREENSHOT : boîte de dialogue de confirmation d'enregistrement -->

## La confirmation d'enregistrement

!!! warning "Écriture immédiate — pas de brouillon"
    Enregistrer un document écrit **directement** dans l'espace partagé : c'est **immédiat, sans annulation**. La demande de confirmation indique exactement ce qui va être écrit. Lisez-la, puis acceptez ou refusez.

    (C'est différent des modifications du curriculum, qui passent d'abord par un brouillon — voir [Relire, publier ou abandonner un brouillon](review-approve.md).)

## Conseils

- **Les fiches de leçons s'appuient sur le manuel.** Si vous préparez les deux, faites le manuel d'abord.
- **Précisez le chapitre** (son numéro). Vous pouvez demander « quels chapitres existent ? » si besoin.
- **Vérifiez la variété des exemples.** Pour voir quels domaines d'exemples ont déjà été utilisés :

    > « Quels domaines d'exemples ont été utilisés dans les chapitres récents ? »

- **Prévisualisez un brouillon avant de publier.** Si vous testez une modification du curriculum, vous pouvez voir le document qui en sortirait **sans rien publier** — voir [Prévisualiser avant de publier](courses-lessons.md).

## Retrouver un document déjà produit

> « Liste les documents du chapitre 5. »

Claude vous indique ce qui existe déjà et peut vous fournir un lien de téléchargement.
