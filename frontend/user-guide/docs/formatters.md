# Créer des formatters

Un **formatter** décrit **l'apparence** d'un document : sa palette de couleurs, sa typographie, sa mise en page, le style de ses illustrations. C'est une consigne de mise en forme, écrite une fois et appliquée à un cours entier, pour que tous les documents produits se ressemblent.

!!! info "Une consigne, pas un moteur"
    L'outil ne fabrique jamais un `.docx` lui-même : c'est la génération, pilotée par Claude, qui rédige le document. Un formatter n'est donc pas un programme de mise en page — c'est **un texte de consignes que la génération lit et applique**. Exactement comme une routine, mais côté *forme* plutôt que côté *pédagogie*.

## Trois formatters concrets

| Formatter | Ce qu'il fixe | Portée |
|---|---|---|
| **Style maison MOHEBS (docx)** | Palette, typographie (ex. Calibri, corps 11–12 pt), mise en page, compression des images | Partagé — tout document `.docx` |
| **Style graphique (images)** | Le look des illustrations : dessin vectoriel 2-D façon manuel scolaire sénégalais, cohérence des personnages | Partagé — matières illustrées |
| **Mise en page des illustrations — maths CI** | Formats d'images, disposition des panneaux d'activité, couleurs des pastilles de réponse (A rouge / B bleu / C vert), tailles d'affichage | Espace de travail — spécifique à une matière |

!!! tip "Les formatters se superposent"
    Un formatter spécifique (la mise en page des illustrations de maths) **se pose par-dessus** les formatters partagés (le style maison, le style graphique). Le général donne le ton commun ; le spécifique ajoute les règles propres à la matière.

## Le catalogue : la même bibliothèque que les routines

Les formatters et les [routines pédagogiques](routines.md) partagent le **même catalogue** et les **mêmes deux étagères** :

- **Partagée** — commune à tous les programmes, réservée au **super-administrateur** ;
- **Espace de travail** — propre à votre programme, modifiable par ses **curateurs**.

Pour parcourir et lire le catalogue :

> « Qu'y a-t-il dans le catalogue ? »
>
> « Montre-moi le détail du formatter “Style maison MOHEBS”. »

## Appliquer un formatter à un cours

À la différence d'une routine (qui s'applique à une *leçon*), un formatter s'applique à un **cours** — la racine du document à produire :

> « Applique le formatter “Style maison MOHEBS” à ce cours. »

La génération de ce cours suivra alors la consigne de mise en forme. Comme pour une routine, l'application crée une **copie indépendante** rattachée au cours : une modification ultérieure du formatter du catalogue ne rejaillit pas sur les cours déjà servis.

## Créer ou modifier un formatter

On l'écrit et on le retouche **en discutant**, et tout part dans un **brouillon** :

> « Crée un formatter “Style des fiches de révision” : … »
>
> « Dans le style maison, passe la police du corps de texte à 12 pt. »

Le contenu d'un formatter est du **texte de consignes** : décrivez précisément ce que la génération doit respecter (couleurs, polices, tailles, marges, style des images…). Plus la consigne est claire, plus le résultat est régulier.

!!! info "Qui peut modifier quoi"
    Un formatter de l'étagère **espace de travail** se modifie par un **curateur** de cet espace. Un formatter **partagé** est réservé au **super-administrateur**, car il sert à tous les programmes.

!!! note "Un détail utile si vous inspectez le graphe"
    Dans l'explorateur, le lien qui rattache un formatter — comme celui qui rattache une routine — porte le même nom technique (`usesRoutine`). C'est normal : routines et formatters reposent sur le même mécanisme. Seul l'usage change (l'un sur une leçon, l'autre sur un cours).
