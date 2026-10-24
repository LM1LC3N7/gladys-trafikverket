# Météo routière Trafikverket

**Connecteur non officiel, sans lien avec Trafikverket** (l'administration
suédoise des transports). Il amène dans Gladys les mesures des **stations
météo routières** de votre choix le long des routes suédoises (température
de l'air et de la chaussée, point de rosée, humidité, vent, précipitations,
glace, neige et eau sur la route), lues par l'**API ouverte officielle de
Trafikverket** avec une clé d'API gratuite à votre nom.

> **Cette intégration n'a jamais été testée avec une vraie clé.** Elle suit
> pytrafikverket, la bibliothèque de l'intégration Home Assistant, et la
> documentation de l'API. Merci de signaler ce que vous voyez sur le forum
> Gladys.

## Ce que vous obtenez

Un appareil Gladys par station, nommé « Trafikverket <station> », avec les
capteurs dont la station dispose :

| Capteur                                     | Unité   | Remarques                                         |
| ------------------------------------------- | ------- | ------------------------------------------------- |
| Température de l'air                        | °C      |                                                   |
| Température de la route                     | °C      | sonde (hors de la moyenne de la pièce)            |
| Point de rosée                              | °C      | sonde (hors de la moyenne de la pièce)            |
| Humidité                                    | %       |                                                   |
| Visibilité                                  | m       | toutes les stations ne la mesurent pas            |
| Vitesse du vent, rafale (30 min)            | m/s     | moyenne sur 10 minutes ; plus forte rafale de 3 s |
| Direction du vent                           | degré   |                                                   |
| Précipitations                              | mm/h    | eau des 30 dernières minutes, multipliée par 2    |
| Pluie (30 min)                              | oui/non | pluie vue dans les 30 dernières minutes           |
| Chute de neige (30 min)                     | oui/non | neige vue dans les 30 dernières minutes           |
| Glace, neige, eau sur la route              | oui/non | ce que voit le capteur de chaussée (givre, glace) |
| Épaisseur de glace, hauteur de neige, d'eau | mm      | sur la chaussée                                   |

- Seul ce que la station envoie est créé ; un capteur créé n'est jamais
  retiré de l'appareil.
- Les unités sont celles que Gladys liste pour chaque type de capteur ;
  l'API les envoie déjà, seules les précipitations sont converties (mm par
  30 minutes en mm/h). Les capteurs oui/non sont en lecture seule : rien ne
  peut les actionner.
- Les noms des capteurs sont en anglais ; renommez-les à leur création si
  vous le souhaitez.
- Les trains, les ferries et les caméras routières de Trafikverket ne font
  pas partie de cette intégration.

## Installation

1. Créez un compte gratuit sur **data.trafikverket.se** et obtenez-y une
   **clé d'API**.
2. Installez l'intégration depuis le catalogue de Gladys (Gladys 5.1 ou
   plus récent).
3. Dans l'écran **Configuration**, collez la clé et saisissez jusqu'à cinq
   stations : le nom exactement comme Trafikverket l'écrit sur la carte de
   ses stations météo routières (« Kungälv »), ou l'identifiant de la station
   (il commence par « SE_STA_VVIS »). Majuscules et minuscules sont
   indifférentes.
4. Cliquez sur **Tester Trafikverket** : le message affiche la dernière
   mesure de chaque station et son âge.
5. Ouvrez l'onglet **Découverte** et ajoutez les appareils. Leurs valeurs
   arrivent dès leur création, si la dernière mesure est récente.

## Configuration

| Champ                 | Défaut | Rôle                                                        |
| --------------------- | ------ | ----------------------------------------------------------- |
| Clé d'API             |        | votre clé de l'API ouverte                                  |
| Station 1 à 5         |        | un nom ou un identifiant de station                         |
| Intervalle de lecture | 10 min | 5 à 60 minutes ; une seule requête pour toutes les stations |

La **clé d'API** est gardée par Gladys dans sa base, jamais réaffichée ; elle
est envoyée seulement à Trafikverket (api.trafikinfo.trafikverket.se), dans
le corps de la requête, jamais dans une URL ni un journal, et jamais écrite
sous `/data`.

Un nom porté par plusieurs stations est refusé : le statut liste alors leurs
identifiants, saisissez l'un d'eux. Une station introuvable est désignée par
son numéro dans le statut (« Station 3 introuvable ») : ce que vous avez saisi
n'y est jamais réaffiché.

## Fonctionnement

- **Une seule requête** pour toutes vos stations à chaque intervalle. **Rien
  ne lit plus tôt** : ni le bouton de test, ni une reconnexion à Gladys, ni
  une configuration enregistrée, ni un redémarrage du conteneur (l'heure de
  la dernière requête est gardée sous `/data`). Une nouvelle clé est essayée
  une minute après la dernière requête.
- **Mesures récentes seulement.** Chaque mesure porte l'heure à laquelle la
  station l'a faite. Une mesure n'est publiée que si elle est **plus récente
  que la dernière publiée** pour cette station (son heure brute et son instant
  sont gardés sous `/data` : un redémarrage propre ne la republie pas) et
  **récente** : une heure au plus (deux intervalles si c'est plus long,
  jamais plus de deux heures), mesurée à l'horloge de Trafikverket. Un arrêt
  brutal (coupure de courant, `docker kill`) dans la minute qui suit une
  lecture peut republier une fois la dernière mesure au redémarrage, jamais
  au-delà de cette limite d'âge. Une station qui ne mesure plus affiche
  « pas de mesure récente » dans le statut et ne publie rien.
- **Clé refusée** (HTTP 401 ou 403) : l'intégration cesse de demander ; le
  statut indique « clé d'API refusée » tant que le refus tient. Le
  refus est gardé sous `/data` (seulement une empreinte salée de la clé
  refusée, jamais la clé) et survit à un redémarrage. Il est levé quand vous
  saisissez une autre clé, ou quand le bouton de test réussit (il essaie une
  fois, l'intervalle écoulé).
- **Trop de requêtes (429) ou service indisponible (5xx)** : une pause,
  d'après le `Retry-After` de la réponse, sinon 5 minutes doublées à chaque
  nouvel échec, entre 1 minute et 6 heures, gardée sous `/data`.
- Autres échecs : nouvel essai à l'intervalle suivant. Le statut distingue
  « requête refusée par Trafikverket » (autre HTTP 4xx, ou erreur dans la
  réponse) de « pas de réponse » (réseau, délai dépassé) ; « (pause) »
  n'apparaît que pendant une pause.
- Un nom de station contenant un caractère de contrôle, un contrôle
  bidirectionnel, un séparateur de ligne ou un caractère interdit en XML est
  refusé et désigné par son numéro ; ces caractères sont aussi retirés des
  noms envoyés par Trafikverket.
- La réponse est bornée (256 Ko) et lue en JSON ; les stations sont
  rapprochées de vos saisies par leur identifiant ou leur nom.

## Lecture seule

L'intégration n'envoie que la requête de l'API ouverte. Elle n'a aucune
commande et ne modifie rien nulle part.

## Crédits

La requête et les champs lus viennent de **pytrafikverket**
(https://github.com/gjohansson-ST/pytrafikverket, licence MIT), portée en
JavaScript ; voir `THIRD_PARTY_NOTICES.md`.
