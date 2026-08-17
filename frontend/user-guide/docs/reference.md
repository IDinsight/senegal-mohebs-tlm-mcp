# Référence

## Qui peut faire quoi

Les rôles sont attribués **par espace de travail** : vous pouvez être curateur ici et simple lecteur ailleurs.

| Action | Sans rôle | Curateur | Approbateur | Admin | Super-admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Lire le curriculum, générer du matériel | ✅ | ✅ | ✅ | ✅ | ✅ |
| Explorer le graphe (lecture seule) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Préparer des modifications (brouillon) | — | ✅ | ✅ | ✅ | ✅ |
| Abandonner un brouillon | — | ✅ | ✅ | ✅ | ✅ |
| **Publier** un brouillon | — | — | ✅ | ✅ | ✅ |
| Gérer les membres de l'espace | — | — | — | ✅ | ✅ |
| Créer / supprimer un espace de travail | — | — | — | — | ✅ |
| Modifier une entrée **partagée** du catalogue | — | — | — | — | ✅ |

Une entrée du catalogue propre à un espace (routine, formatter) se modifie par un **curateur** de cet espace ; une entrée **partagée** entre tous les programmes est réservée au **super-admin**.

Pour connaître votre rôle : demandez à Claude « **Que puis-je faire ?** ».

## Les deux types de confirmation

| Vous faites… | Effet | Filet de sécurité |
|---|---|---|
| **Enregistrer un document** | Écrit **immédiatement**, sans annulation | La confirmation dit ce qui va être écrit |
| **Modifier le curriculum** | Va d'abord dans un **brouillon** | Rien n'est officiel avant la **publication** par un approbateur |

Dans les deux cas, rien ne se produit sans votre confirmation.

## Petit glossaire

| Terme | Signification |
|---|---|
| **Espace de travail** | Le conteneur d'un programme (ex. *Sénégal*). Il possède les curriculums et détermine les rôles. |
| **Classe / matière** | Le périmètre de travail à l'intérieur d'un espace (ex. *CI / mathématiques*). On travaille sur un seul à la fois. |
| **Graphe de connaissances** | La structure du curriculum : les standards, le contenu, et leurs liens. |
| **Standard** | Ce que l'élève doit apprendre. La couche stable du graphe (domaines et objectifs). |
| **Domaine** | Un grand thème qui regroupe des objectifs (ex. Arithmétique, Géométrie). |
| **Objectif** | Un but d'apprentissage précis, à l'intérieur d'un domaine. C'est la cible d'un alignement. |
| **Composant d'apprentissage** | Une compétence unique et fine, rattachée à un objectif ; sert à le détailler. |
| **Alignement** | Le lien qui déclare qu'une leçon **enseigne** (ou **évalue**) un objectif. Va du contenu vers le standard. |
| **Cours** | La racine d'un document (ex. le manuel de l'élève, le guide de l'enseignant). |
| **Chapitre** | Un regroupement de leçons ; selon la matière : chapitre, unité ou semaine. |
| **Leçon** | L'unité de travail : on l'aligne sur un objectif et on lui applique une routine. |
| **Routine pédagogique** | Un gabarit de structure de leçon, réutilisable, rangé dans le catalogue. S'applique à une leçon. |
| **Formatter** | Une consigne de mise en forme (palette, typo, mise en page, illustrations). S'applique à un cours. |
| **Catalogue** | La bibliothèque des routines et des formatters, avec une étagère partagée et une par espace. |
| **Manuel de l'élève** | Le document destiné à l'élève. |
| **Fiches de leçons** | Le guide de l'enseignant. |
| **Brouillon** | Un ensemble de modifications en attente, pas encore officielles. |
| **Publier** | Rendre le brouillon officiel — la génération l'utilise alors. |
| **Bilan** | L'évaluation de fin de chapitre. |
| **Explorateur** | La page web de visualisation (lecture seule) du curriculum publié. |

## Besoin d'aide ?

- Pour un problème d'accès ou de compte → l'**administrateur** de votre espace de travail.
- Pour ajouter une matière ou un espace → voir [Administration et développement](admin-developer.md).
- Pour savoir ce que vous pouvez faire → demandez à Claude « Que puis-je faire ? ».
