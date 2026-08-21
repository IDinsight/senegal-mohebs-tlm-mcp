# Ajouter un espace de travail ou une matière

Cette page couvre deux tâches d'installation :

- **Créer un espace de travail et gérer ses membres** — se fait **en discutant avec Claude**, par un administrateur.
- **Ajouter une nouvelle matière** (avec son graphe de départ) — demande d'écrire du **code** et d'exécuter des **commandes** : c'est une tâche de **développeur** ayant accès au dépôt et au déploiement.

Les deux ne s'adressent pas au même public : la première partie ne demande aucune compétence technique ; la seconde, si.

---

## Partie 1 — Espaces de travail et membres (par la discussion)

### Qu'est-ce qu'un espace de travail ?

Un **espace de travail** est le conteneur d'un programme (par exemple *Sénégal* ou *Kenya*). Il possède l'ensemble des curriculums de ce programme, et c'est à ce niveau que sont attribués les **rôles**. Son identifiant devient le premier segment de chaque adresse interne : `senegal/ci/maths`, `kenya/ci/maths`, etc.

### Les rôles, du plus large au plus restreint

| Rôle | Portée | Peut… |
|---|---|---|
| **super-admin** | tous les espaces | tout, y compris créer/supprimer des espaces et accorder n'importe quel rôle |
| **admin** | un espace | gérer les membres de cet espace, plus tout ce que fait l'approbateur |
| **approbateur** | un espace | publier, plus tout ce que fait le curateur |
| **curateur** | un espace | préparer, appliquer, abandonner des brouillons |
| *(aucun rôle)* | — | ne peut pas entrer dans l'espace |

Le rôle de **super-admin ne s'accorde pas** depuis l'outil : il est fixé par une variable d'environnement du serveur (`TLM_SUPER_ADMINS`), par un développeur.

### Créer un espace de travail

Réservé au **super-admin** :

> « Crée un espace de travail “kenya”, nom affiché “Kenya”. »

L'identifiant doit être un slug court (`kenya`). Créer l'espace **ne crée pas** ses curriculums : les importer est une étape à part (voir la partie 2).

### Gérer les membres

Réservé aux **admins** de l'espace (ou au super-admin) :

> « Ajoute cet utilisateur comme curateur de l'espace Sénégal. »
>
> « Liste les membres de l'espace Sénégal. »
>
> « Retire cet utilisateur de l'espace Sénégal. »

L'identifiant d'un utilisateur est son sujet d'identité (le `sub` de son jeton). Quelques garde-fous :

- réaccorder un rôle **met à jour** le rôle existant ;
- on **ne peut pas retirer le dernier admin** d'un espace — nommez-en un autre d'abord ;
- un admin **ne peut pas** accorder le rang de super-admin.

Chaque changement d'espace ou de membre est **immédiat** (pas de brouillon) et **journalisé**.

---

## Partie 2 — Ajouter une nouvelle matière (code + commandes)

!!! warning "Tâche de développeur"
    Cette partie suppose l'accès au dépôt de code et au déploiement (Cloud Run). Toutes les commandes se lancent depuis le dossier `backend/` (`cd backend` d'abord). En cas de doute, appuyez-vous sur la compétence interne **rollout**, qui décrit la procédure pas à pas.

Ajouter une matière, c'est **du code puis des données**.

### Étape 1 — Décrire la matière (code)

Chaque matière est décrite par un **profil** (`SubjectProfile`), un objet de configuration — pas de code de comportement à écrire. Ajoutez un fichier sous `backend/src/adapters/profiles/`, sur le modèle de `ci-maths.ts`. Le profil dit à l'outil comment lire le graphe de cette matière (d'où vient l'ordre des unités, quels liens de contenance suivre…) et peut embarquer un **guide** en markdown que la génération lira.

### Étape 2 — Enregistrer le profil (code)

Dans `backend/src/adapters/index.ts`, ajoutez la clé `"<classe>/<matière>"` à la table des profils (et à celle des guides si la matière en a un). Plusieurs classes/matières peuvent pointer vers le même profil quand leurs graphes ont la même forme.

### Étape 3 — Construire et déployer

Le profil étant du code, un **redéploiement du serveur** (Cloud Run) est nécessaire pour que la nouvelle matière soit reconnue.

```bash
npm run build
```

### Étape 4 — Importer le graphe (données)

Une fois la matière connue du serveur, importez son graphe de départ :

```bash
npm run import:kg-store -- <espace> <classe> <matière> <graphe.json>
```

Ajoutez `--dry-run` pour un essai à blanc (rien n'est écrit). L'import **refuse** de tourner si aucun profil n'est enregistré pour cette matière — d'où l'ordre : code d'abord, données ensuite.

!!! danger "Le piège de l'import sur un espace existant"
    L'import écrit **toujours** dans l'emplacement `a` et **ne repointe jamais** un espace déjà existant. Sur un espace neuf, c'est parfait. Sur un espace déjà publié, votre graphe atterrit dans une copie que **personne ne lit** : pour le publier, il faut passer par la boucle du curateur (qui, elle, bascule le pointeur). L'import est fait pour un **nouvel** espace, une restauration ou un clone.

### À quoi ressemble le fichier de graphe

C'est une enveloppe **Learning Commons** : `{ nodes, relationships }`. Les `nodes` sont des nœuds étiquetés (cadre de référence, objectif, leçon…) avec leurs propriétés ; les `relationships` sont les liens typés entre eux (contenance, alignement…). Le stock est en LC canonique.

### Sauvegarder (l'inverse de l'import)

Avant toute manipulation, faites une **sauvegarde** en exportant le graphe publié :

```bash
npm run export:kg-store -- <espace> <classe> <matière> [sortie.json]
```

Le fichier produit se réimporte tel quel pour restaurer ou cloner. Les deux scripts ont besoin des accès Firebase (variables `SERVICE_ACCOUNT_KEY_PATH`, `FIREBASE_STORAGE_BUCKET`, `TLM_BUCKET_PREFIX`).

### Vérifier après import

- `set_context` doit **activer** la matière (un profil invalide est refusé à l'activation) ;
- un état des lieux (« fais-moi un panorama de cette matière ») doit rendre les comptes attendus ;
- le guide de la matière doit être celui que vous vouliez.

### Modifier une matière existante ≠ en ajouter une

Retoucher le **profil** ou le **guide** d'une matière **déjà en place** ne demande **ni code ni redéploiement** : cela se fait par la discussion, comme une modification de curriculum (aperçu → confirmation → brouillon → publication). Seul l'ajout d'une matière *nouvelle* passe par le code.
