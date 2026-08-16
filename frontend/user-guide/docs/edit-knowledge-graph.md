# Modifier le graphe de connaissances

Le **graphe de connaissances** est la structure du curriculum : les **domaines**, les **chapitres** et les **leçons**, et la façon dont ils s'articulent. C'est cette structure qui alimente la génération du matériel pédagogique.

!!! info "Réservé aux curateurs et approbateurs"
    Seuls les **curateurs** et les **approbateurs** peuvent modifier le curriculum. Si vous n'êtes pas sûr de votre rôle, demandez : « Que puis-je faire ? »

## Le point le plus important : tout passe par un brouillon

Vos modifications **ne deviennent pas immédiatement officielles**. Elles s'accumulent dans un **brouillon** :

- Vous (ou d'autres curateurs) faites une série de changements → ils s'empilent dans le brouillon.
- **Rien n'atteint la génération de documents tant qu'un approbateur n'a pas publié le brouillon** (voir [Relire et approuver](review-approve.md)).

C'est votre filet de sécurité : vous pouvez travailler tranquillement, tout est revu avant de devenir officiel.

## Chaque modification se fait en deux temps

1. Vous demandez le changement → Claude vous montre **un aperçu** de ce qui serait modifié (rien n'est encore appliqué).
2. Vous **confirmez** → le changement est ajouté au brouillon.

<!-- SCREENSHOT : aperçu d'une modification avant confirmation -->

## Deux familles de modifications

### Corriger un intitulé ou un texte

Par exemple :

> « Change le titre du chapitre 3 en “Les nombres décimaux”. »
>
> « Corrige l'objectif de cette leçon : … »

### Restructurer les chapitres et les leçons

| Vous voulez… | Dites quelque chose comme… |
|---|---|
| Ajouter une leçon à un chapitre | « Ajoute une leçon “…” au chapitre 5. » |
| Ajouter un chapitre | « Crée le chapitre 26 “Nombres décimaux” avec deux leçons : … » |
| Déplacer une leçon | « Déplace cette leçon vers le chapitre 6. » |
| Scinder un chapitre | « Sépare le chapitre 5 à partir de la leçon … dans un nouveau chapitre. » |
| Renuméroter un chapitre | « Renumérote le chapitre 3 en 26. » |

!!! tip "Numéros de chapitre"
    Pour ajouter ou renuméroter, le numéro visé doit être **libre** (ajouter à la fin ou combler un trou). Pour insérer un chapitre au milieu en décalant les autres, faites-le explicitement, étape par étape.

## Vérifier votre brouillon en cours

> « Montre-moi les modifications en attente. »

Claude affiche l'ensemble des changements du brouillon (l'« aperçu de l'approbateur »). Vous pouvez continuer à éditer, ou passer le relais pour [relecture et publication](review-approve.md).

## Se voir alerté, sans être bloqué

Certaines situations déclenchent un **avertissement** sans empêcher l'enregistrement — par exemple un chapitre sans leçon, ou un chapitre sans bilan. C'est normal si vous êtes en cours d'édition ; l'approbateur en tiendra compte au moment de publier.

À l'inverse, ce qui casserait la structure (une leçon rattachée à rien, par exemple) est **refusé** d'emblée.
