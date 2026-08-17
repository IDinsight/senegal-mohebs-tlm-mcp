# Ajouter et modifier un cours et ses leçons

C'est ici que se construit le **contenu** enseignant : les cours, leurs chapitres, et les leçons. Vous les rédigez, vous les organisez, et vous les **reliez** à trois choses : les standards qu'ils enseignent, les **routines pédagogiques** qui donnent leur structure aux leçons, et les **formatters** qui décident de la mise en forme. Une fois ce contenu en place, il alimente la [génération de documents](create-materials.md).

!!! info "Réservé aux curateurs"
    Ces modifications passent par le rôle de **curateur** et restent en **brouillon** jusqu'à publication. Rien n'atteint la génération avant d'être publié.

## La couche « contenu », en un coup d'œil

```
Cours  →  Chapitre (regroupement)  →  Leçon  →  Activités, supports
```

- Un **cours** est la racine d'un document — par exemple *le manuel de l'élève* ou *le guide de l'enseignant*.
- Un **chapitre** (un regroupement) rassemble des leçons ; selon la matière, on parle de chapitre, d'unité ou de semaine.
- Une **leçon** est l'unité de travail : c'est elle qu'on aligne sur un objectif et à qui on applique une routine.

## Créer un cours, un chapitre, une leçon

Décrivez simplement ce que vous voulez, et où :

> « Crée un chapitre 26 “Nombres décimaux” à la fin du manuel de l'élève. »
>
> « Ajoute une leçon “Additionner deux décimaux” au chapitre 26. »

Vous pouvez tout décrire en une fois — Claude prépare l'ensemble, montre l'**aperçu**, et n'écrit qu'après votre **confirmation** :

> « Crée le chapitre 26 avec trois leçons : …, …, … »

!!! tip "Numéros de chapitre"
    Pour ajouter ou renuméroter, visez un numéro **libre** (ajouter à la fin, ou combler un trou). Pour insérer un chapitre au milieu en décalant les autres, faites-le explicitement, étape par étape.

## Modifier et réorganiser

| Vous voulez… | Dites quelque chose comme… |
|---|---|
| Corriger un titre | « Renomme le chapitre 3 en “Les nombres décimaux”. » |
| Modifier le texte d'une leçon | « Remplace le contenu de cette leçon par : … » |
| Déplacer une leçon | « Déplace cette leçon vers le chapitre 6. » |
| Réordonner | « Place cette leçon en première position du chapitre. » |
| Supprimer | « Supprime cette leçon. » (ce qui en dépend est retiré avec elle) |

Déplacer une leçon ne renumérote pas en cascade : l'appartenance à un chapitre est un lien, pas un numéro figé.

!!! note "Une leçon peut avoir deux places"
    En mathématiques, une même leçon peut appartenir **à la fois** à un chapitre (l'axe du contenu) et à une semaine (l'axe du calendrier). C'est voulu. Déplacer la leçon sur un axe laisse l'autre intact — précisez lequel vous visez si le doute est possible.

## Relier une leçon aux standards

Une leçon ne prend tout son sens que **reliée à l'objectif qu'elle enseigne**. C'est l'**alignement**, décrit en détail dans [Construire les standards et les composants](build-standards.md) :

> « Aligne cette leçon sur l'objectif “Comparer deux nombres jusqu'à 20”. »

Pour vérifier ce qu'une leçon enseigne :

> « À quel objectif cette leçon est-elle reliée, et quels composants couvre-t-il ? »

## Appliquer une routine pédagogique à une leçon

Une **routine** est un gabarit d'enseignement réutilisable — par exemple les cinq étapes d'une fiche de leçon de 30 minutes. On l'**applique à une leçon** pour lui donner sa structure :

> « Applique la routine “Fiche de leçon” à cette leçon. »

Appliquer une routine en fait une **copie indépendante** attachée à votre leçon : les retouches ultérieures de la routine d'origine ne la modifient pas. Pour créer ou modifier les routines elles-mêmes, voir [Créer des routines pédagogiques](routines.md).

## Appliquer un formatter à un cours

Un **formatter** décrit la **mise en forme** du document produit — palette, typographie, mise en page, style des illustrations. On l'**applique au cours** (la racine du document), et la génération s'y conforme :

> « Applique le formatter “Style maison” à ce cours. »

Comme pour une routine, l'application crée une copie indépendante attachée au cours. Pour créer ou modifier les formatters, voir [Créer des formatters](formatters.md).

## Prévisualiser avant de publier

Avant de passer le relais à l'approbateur, vous pouvez **voir le résultat** de votre brouillon sans rien publier :

> « Montre-moi les modifications en attente. » *(le détail du brouillon)*
>
> « Prévisualise le manuel de ce cours à partir du brouillon. » *(le document qui en sortirait)*

La prévisualisation reste **isolée** : elle n'écrit rien dans l'espace officiel et n'apparaît pas dans la liste des documents produits. Quand tout vous convient, passez à [Relire, publier ou abandonner un brouillon](review-approve.md).
