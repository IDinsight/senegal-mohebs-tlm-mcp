# Créer un graphe de connaissances

Le **graphe de connaissances** est la structure du curriculum : ce que les élèves doivent apprendre, et le matériel qui l'enseigne, reliés entre eux. C'est cette structure qui alimente la génération des manuels et des fiches de leçons. Cette page explique **de quoi un graphe est fait** et **comment il voit le jour**. Pour le remplir ensuite, voir [Construire les standards et les composants](build-standards.md).

!!! info "Réservé aux curateurs"
    Créer et modifier le curriculum demande le rôle de **curateur** (ou plus). Tout le monde peut le lire et le visualiser. Si vous n'êtes pas sûr : « Que puis-je faire ? »

## Le graphe a deux couches

Une bonne image pour tout comprendre : le graphe superpose **deux couches**, reliées l'une à l'autre.

- **Les standards** — *ce que l'élève doit maîtriser*. C'est l'ossature stable : les grands domaines (ex. *Arithmétique*), puis les objectifs précis à l'intérieur (ex. *Compter jusqu'à 20*). Cette couche change rarement.
- **Le contenu** — *ce qui enseigne ces standards*. Les cours, les chapitres et les leçons que vous rédigez. Cette couche vit et évolue.

Les deux couches sont **cousues ensemble** : chaque leçon est **alignée** sur le standard qu'elle enseigne. C'est ce lien qui permet à l'outil de vérifier que le curriculum couvre bien tous les objectifs, et de fournir le bon contexte au moment de générer un document.

!!! example "Un exemple concret"
    Le standard dit : « L'élève sait comparer deux nombres jusqu'à 20. »
    La leçon *« Plus grand, plus petit »* du chapitre 3 est **alignée** sur ce standard : c'est elle qui l'enseigne. Si un jour ce standard n'est enseigné par aucune leçon, l'outil peut vous le signaler.

## Comment un graphe voit le jour

Il y a deux moments à distinguer.

### Au tout début : l'import d'un graphe de départ

Quand une **nouvelle matière** arrive dans le système (par exemple les mathématiques d'une nouvelle classe), l'ossature de départ — le cadre des standards et sa première arborescence — est **importée** à partir d'un fichier par un administrateur ou un développeur. Ce n'est pas une opération qui se fait par la discussion ; elle est décrite dans [Ajouter un espace de travail ou une matière](admin-developer.md).

À retenir : **le cadre de référence des standards** (la racine de la couche « standards ») entre dans le système par cet import. Vous n'avez pas à le créer vous-même.

### Ensuite : vous bâtissez la structure par la discussion

Une fois la matière en place, **tout le reste se construit en discutant avec Claude** — c'est là votre travail d'expert curriculum :

- ajouter des **objectifs** et des **composants d'apprentissage** sous les standards → [Construire les standards et les composants](build-standards.md) ;
- créer des **cours, chapitres et leçons**, et les aligner sur les standards → [Ajouter et modifier un cours et ses leçons](courses-lessons.md).

Vous pouvez même démarrer un **nouveau cours** de zéro par la discussion (un cours est une « racine » de la couche contenu) ; seule la racine des *standards* dépend de l'import initial.

## Se repérer avant de construire

Avant de créer quoi que ce soit, prenez la mesure de ce qui existe déjà. Deux réflexes :

> « Fais-moi un état des lieux de cette matière. »

Claude vous donne un **panorama** : combien de standards, de cours, de leçons, quels sont les points de départ (les « racines ») et si un brouillon est déjà ouvert. C'est le meilleur point de départ.

> « Montre-moi la structure à partir de ce cours. »

Claude **parcourt** le graphe depuis un point que vous indiquez et vous en liste le contenu, page par page.

Vous pouvez aussi ouvrir l'**[explorateur](explorer.md)** pour *voir* l'arborescence publiée sous forme visuelle — pratique pour se faire une idée d'ensemble avant de toucher à quoi que ce soit.

!!! note "Rien n'est officiel tant que ce n'est pas publié"
    Comme toute modification du curriculum, ce que vous créez ici part d'abord dans un **brouillon** — un espace de travail à part, invisible pour la génération de documents, jusqu'à ce qu'un approbateur le publie. Vous construisez donc tranquillement. Voir [Relire, publier ou abandonner un brouillon](review-approve.md).
