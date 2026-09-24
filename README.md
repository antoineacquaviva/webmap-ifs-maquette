# Webmap de l'Initiative Fleuve Sénégal : maquette

Maquette fonctionnelle réalisée par Antoine Acquaviva pour la réponse à l'appel d'offres « Webmap Initiative Fleuve Sénégal ».

> **Données fictives.** Les projets, bailleurs, partenaires, montants et la couche historique sont inventés pour la démonstration. Les limites administratives, les cours d'eau et les localités sont réels.

## Ce que montre la maquette

- **La carte** (`index.html`) : projets par région et par unité administrative de niveau 2 (bascule automatique selon le zoom), cinq indicateurs (projets, organisations, partenaires, bailleurs, bénéficiaires), filtres croisés (pays, région, unité, thématique, organisation, bailleur, partenaire, état, période), synthèse chiffrée et graphiques, fiche de chaque projet, couche historique 2010-2020, trois fonds de carte (plan clair, OpenStreetMap, satellite).
- **Les liens partageables** : chaque vue (filtres, territoire, projet ouvert) a sa propre adresse.
- **L'intégration** : `index.html?embed=1` affiche une version allégée pour Sahelink ou les sites des membres. Le code à copier est dans « À propos de la carte ».
- **La mise à jour sans compétence technique** (`admin.html`) : on dépose un export Kobo (Excel ou CSV), un rapport de contrôle explique chaque anomalie en français avec une suggestion de correction, puis on publie. Dans la maquette, la publication reste dans le navigateur.

## Publier la maquette sur GitHub Pages (15 minutes)

1. **Créer un dépôt.** Sur [github.com](https://github.com), bouton **New repository**. Nom conseillé : `webmap-ifs-maquette`. Cocher **Public**. Créer.
2. **Déposer les fichiers.** Dans le dépôt, **Add file > Upload files**. Glisser **le contenu** du dossier décompressé (pas le dossier lui-même). Valider avec **Commit changes**.
3. **Vérifier le fichier de publication.** Le dépôt doit contenir `.github/workflows/publier.yml`. Sur Mac, ce dossier est masqué et n'est souvent pas envoyé. S'il manque : **Add file > Create new file**, taper `.github/workflows/publier.yml` comme nom, coller le contenu donné en annexe, puis **Commit changes**.
4. **Activer Pages.** **Settings > Pages**, rubrique **Build and deployment**, **Source : GitHub Actions**.
5. **Lancer la publication.** Onglet **Actions**, **Publier la maquette**, **Run workflow**. Attendre la coche verte (2 à 3 minutes). Une première exécution en échec (croix rouge), lancée avant l'étape 4, est normale : il suffit de relancer.
6. **Ouvrir le site** : `https://<votre-compte>.github.io/webmap-ifs-maquette/`

**Contrôle :** ouvrir « À propos de la carte ». La ligne « Limites administratives » doit indiquer **geoBoundaries**. Si elle indique Natural Earth, le téléchargement des limites a échoué : relancer l'étape 5. La carte reste utilisable, au niveau régional.

## Tester la mise à jour

Sur le site publié, cliquer sur **Mettre à jour les données**, puis **Essayer avec un export d'exemple**. Le fichier contient 5 nouveaux projets, 2 projets modifiés et 5 erreurs volontaires (3 bloquantes, 2 avertissements). Après **Publier sur la carte**, la carte affiche les nouvelles données, avec un bandeau pour revenir aux données de démonstration.

## Comment ça marche

À chaque publication, GitHub exécute `scripts/preparer_donnees.py` :

1. téléchargement des limites geoBoundaries (niveaux 1 et 2) des quatre pays ;
2. délimitation d'une zone indicative autour du fleuve et de ses affluents (Bafing, Bakoye, Baoulé, Falémé), puis sélection des unités qui la recoupent ;
3. génération des données fictives au format d'un export Kobo (`data/projets.csv`) ;
4. mise en ligne du site statique.

Le site n'a ni serveur ni base de données : des fichiers, une page, une carte. Il coûte zéro euro d'hébergement et reste lisible sur une connexion lente.

Pour la version finale, le périmètre indicatif sera remplacé par la liste des 76 unités validée par l'IFS, et les thématiques par la nomenclature du Traverse n°50.

## Règles de calcul (provisoires, à arrêter au cadrage)

- Un projet présent dans plusieurs unités compte dans chacune d'elles, mais une seule fois pour une région ou pour le bassin.
- Les bénéficiaires d'un projet sont répartis à parts égales entre ses unités.
- Un projet est retenu dans une période s'il est actif au moins une année de cette période.

## Contenu du dépôt

```
index.html                 la carte
admin.html                 la démonstration de mise à jour
assets/                    styles, code, bibliothèques et police (embarquées, sans service tiers)
data/projets.csv           projets (fictifs), format export Kobo
data/exemple_export_kobo.csv  export d'exemple pour tester la mise à jour
data/referentiels/         thématiques, organisations, unités administratives
data/geo/                  couches géographiques préparées
data/sources/              extraits Natural Earth (repli et cours d'eau)
scripts/preparer_donnees.py   préparation des données
.github/workflows/publier.yml publication automatique
```

## Aperçu sur son ordinateur

Les navigateurs bloquent la lecture des fichiers de données quand on ouvre `index.html` directement. Pour un aperçu local, dans le dossier : `python3 -m http.server 8000`, puis ouvrir `http://localhost:8000`. La version livrée affiche le niveau régional ; le niveau 2 apparaît après la publication par GitHub.

## Sources et licences

- Limites administratives : [geoBoundaries](https://www.geoboundaries.org), licence CC BY 4.0.
- Frontières, cours d'eau, localités : [Natural Earth](https://www.naturalearthdata.com), domaine public.
- Fonds de carte : Esri (plan clair, satellite), contributeurs OpenStreetMap (ODbL).
- Bibliothèques : Leaflet (BSD-2-Clause), Chart.js et Papa Parse (MIT), SheetJS (Apache-2.0). Police Atkinson Hyperlegible (SIL OFL 1.1).
- Code de la maquette : licence MIT, © 2026 Antoine Acquaviva. Il est librement réutilisable par l'IFS.

## Transparence sur l'usage de l'IA

Cette maquette a été conçue et réalisée par Antoine Acquaviva avec l'aide d'un assistant d'IA (Claude, d'Anthropic). Les choix, la relecture et les tests sont les miens. Aucune donnée réelle de l'IFS n'a été transmise à un service d'IA.

## Annexe : contenu de `.github/workflows/publier.yml`

```yaml
name: Publier la maquette

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  construire:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Installer la dépendance
        run: pip install shapely==2.0.6
      - name: Préparer les données (limites, zone du bassin, données fictives)
        env:
          GB_DIR: ${{ runner.temp }}/geoboundaries
        run: python scripts/preparer_donnees.py
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .

  deployer:
    needs: construire
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploiement.outputs.page_url }}
    steps:
      - id: deploiement
        uses: actions/deploy-pages@v4
```
