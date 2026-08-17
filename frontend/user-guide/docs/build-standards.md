# Construire les standards et les composants

Les **standards** sont l'ossature du curriculum : ce que les élèves doivent apprendre. Cette page montre comment les enrichir en discutant avec Claude — ajouter des objectifs, préciser les **composants d'apprentissage**, et organiser le tout. Pour relier ensuite des leçons à ces standards, voir [Ajouter et modifier un cours et ses leçons](courses-lessons.md).

!!! info "Réservé aux curateurs"
    L'ajout et la modification passent par le rôle de **curateur**, et restent en **brouillon** jusqu'à publication.

## Le vocabulaire, en trois mots

| Terme | Ce que c'est | Exemple |
|---|---|---|
| **Domaine** | Un grand thème qui regroupe des objectifs | *Arithmétique* |
| **Objectif** | Un but d'apprentissage précis, à l'intérieur d'un domaine | *Comparer deux nombres jusqu'à 20* |
| **Composant d'apprentissage** | Une compétence ou une notion unique et bien délimitée, rattachée à un objectif | *Reconnaître le symbole «&nbsp;>&nbsp;»* |

Les domaines et les objectifs s'emboîtent comme des dossiers et sous-dossiers. Les composants sont les briques les plus fines : ils **précisent** un objectif en le découpant en savoir-faire concrets.

## Ajouter un objectif

Dites à Claude ce que vous voulez ajouter et **où** :

> « Ajoute un objectif “Comparer deux nombres jusqu'à 20” dans le domaine Arithmétique. »

Comme toujours, Claude vous montre d'abord **un aperçu** de ce qu'il va créer ; vous **confirmez**, et l'objectif rejoint le brouillon.

## Ajouter des composants d'apprentissage

Un composant se rattache **à un objectif** — il décrit une compétence précise que cet objectif recouvre :

> « Sous cet objectif, ajoute les composants : “reconnaître le symbole >”, “comparer deux collections”, “ranger trois nombres dans l'ordre”. »

Vous pouvez en ajouter **plusieurs d'un coup** : c'est plus rapide et tout part dans le même brouillon, en une seule étape à confirmer.

!!! tip "Créer par lots"
    Pour bâtir une section entière, décrivez-la en une fois : « Crée le domaine Géométrie avec trois objectifs, et sous chacun deux composants. » Claude prépare l'ensemble, vous montre l'aperçu complet, et n'écrit qu'après votre accord.

## Relier une leçon à un objectif : l'alignement

C'est le lien le plus important du graphe. **Aligner** une leçon sur un objectif, c'est déclarer : « cette leçon enseigne cet objectif ». C'est ce qui permet à l'outil de savoir quel objectif est couvert, et par quoi.

> « Aligne la leçon “Plus grand, plus petit” sur l'objectif “Comparer deux nombres jusqu'à 20”. »

L'alignement se pose depuis le **contenu vers le standard** (de la leçon vers l'objectif), jamais l'inverse — c'est toujours la leçon qui « pointe vers » l'objectif qu'elle enseigne. On peut aussi préciser si une leçon **enseigne** un objectif ou l'**évalue** (un bilan).

!!! warning "Composant ou objectif ?"
    Une leçon s'aligne sur un **objectif**, pas sur un composant. Les composants servent à *détailler* un objectif et nourrissent la génération du matériel ; ils ne sont pas des cibles d'alignement. Si vous demandez d'aligner une leçon sur un composant, Claude vous orientera vers l'objectif parent.

## Vérifier votre travail

À tout moment, prenez du recul :

> « Fais-moi un état des lieux : combien d'objectifs, combien de composants ? »
>
> « Quels objectifs ne sont enseignés par aucune leçon ? »
>
> « À quel(s) objectif(s) cette leçon est-elle reliée ? »

Cette dernière question est utile car un simple parcours de l'arborescence **ne montre pas** les alignements : ils traversent le graphe d'un bord à l'autre et se consultent leçon par leçon.

L'**[explorateur](explorer.md)** vous donne la même information sous forme visuelle : la couche des standards et la couche du contenu, avec leurs liens.

## Corriger et réorganiser

Vous n'ajoutez pas seulement ; vous corrigez aussi.

| Vous voulez… | Dites quelque chose comme… |
|---|---|
| Corriger un intitulé | « Renomme cet objectif en “Comparer des nombres jusqu'à 50”. » |
| Reformuler le texte d'un objectif | « Remplace le texte de cet objectif par : … » |
| Déplacer un objectif dans un autre domaine | « Déplace cet objectif vers le domaine Mesures. » |
| Réordonner | « Place cet objectif en deuxième position dans son domaine. » |

Chaque correction suit la même règle : **aperçu → confirmation → brouillon**. Rien n'est officiel avant [publication](review-approve.md).
