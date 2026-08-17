# Prise en main

Quatre étapes avant de travailler : **demander votre accès**, **installer le connecteur** dans Claude, **vous connecter**, puis **choisir où vous travaillez** (l'espace de travail, la classe et la matière).

## 1. Demander votre accès (compte Supabase)

L'authentification passe par **Supabase**. Il n'y a pas encore d'auto-inscription : c'est l'administrateur du projet qui **crée votre compte**. Demandez-lui votre accès ; vous recevez un **e-mail** et un **mot de passe** de connexion.

!!! info "Pas encore de compte ?"
    Écrivez à l'administrateur du projet pour qu'il crée votre accès Supabase. Il vous transmettra aussi l'adresse du connecteur (étape 2) si elle n'apparaît pas déjà dans Claude.

## 2. Installer le connecteur dans Claude

L'outil se branche à Claude comme un **connecteur** nommé **« Teaching & Learning Materials authoring »**.

1. Dans Claude, ouvrez les paramètres des connecteurs.
2. Si le connecteur **« Teaching & Learning Materials authoring »** est déjà proposé par votre organisation, activez-le.
3. Sinon, ajoutez un **connecteur personnalisé** et collez l'**adresse fournie par votre administrateur** (une URL se terminant par `/mcp`), puis validez.

<!-- SCREENSHOT : écran d'ajout du connecteur dans Claude -->

## 3. Se connecter

À la première utilisation, Claude ouvre une page de connexion Supabase. Saisissez l'**e-mail** et le **mot de passe** de l'étape 1. Vous ne le referez pas à chaque fois.

<!-- SCREENSHOT : page de connexion -->

## 4. Choisir où vous travaillez

Le travail est toujours cadré par trois choses : un **espace de travail**, une **classe** et une **matière**.

- L'**espace de travail** est le grand conteneur d'un programme — par exemple *Sénégal*. Il regroupe tous les curriculums de ce programme, et c'est lui qui détermine votre rôle. Vous ne voyez que les espaces auxquels vous avez accès.
- À l'intérieur, vous travaillez sur **une classe + une matière à la fois** (par exemple *CI / mathématiques*).

Pour voir ce à quoi vous avez accès :

> « Quels espaces de travail puis-je ouvrir ? »
>
> « Quelles classes et matières sont disponibles ? »

Puis dites à Claude où aller :

> « Travaillons sur les mathématiques de CI dans l'espace Sénégal. »

Claude fixe le contexte. À partir de là, tout ce que vous demandez s'applique à ce périmètre.

!!! tip "Bon à savoir"
    Votre choix reste actif pendant votre session. Si vous changez de matière ou d'espace en cours de route, dites-le à Claude — il repart proprement sur le nouveau contexte, sans mélanger les deux.

!!! info "On vous refuse l'entrée d'un espace ?"
    On ne peut **entrer** que dans un espace de travail où l'on a un rôle. Si Claude vous répond que l'accès est refusé, demandez à l'administrateur de l'espace de vous ajouter (voir [Administration](admin-developer.md)).

## Et ensuite ?

- Pour construire ou corriger le curriculum → [Créer un graphe de connaissances](create-graph.md), [Construire les standards et les composants](build-standards.md), [Ajouter et modifier un cours et ses leçons](courses-lessons.md).
- Pour produire un document → [Générer du matériel pédagogique](create-materials.md).
- Pour visualiser le curriculum → [Explorer le graphe](explorer.md).
