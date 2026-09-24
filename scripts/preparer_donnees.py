#!/usr/bin/env python3
"""Prépare les données de la maquette de webmap de l'Initiative Fleuve Sénégal.

Étapes :
1. Télécharge les limites administratives ouvertes geoBoundaries (CC BY 4.0)
   des niveaux 1 et 2 pour le Sénégal, la Mauritanie, le Mali et la Guinée.
2. Délimite une zone indicative du bassin autour du fleuve et de ses affluents,
   et retient les unités de niveau 2 qui la recoupent.
3. Génère des données FICTIVES de projets, au format d'un export Kobo.

Si le téléchargement échoue, la carte est construite au niveau régional
à partir de Natural Earth (inclus dans le dépôt) : le site reste publiable.

Utilisation : python scripts/preparer_donnees.py
Dépendance : shapely
"""
import csv
import json
import os
import random
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import LineString, mapping, shape
from shapely.ops import unary_union

RACINE = Path(__file__).resolve().parent.parent
DATA = RACINE / "data"
SOURCES = DATA / "sources"
GEO = DATA / "geo"
REF = DATA / "referentiels"

PAYS = {
    "SEN": ("SN", "Sénégal"),
    "MRT": ("MR", "Mauritanie"),
    "MLI": ("ML", "Mali"),
    "GIN": ("GN", "Guinée"),
}
URLS_GEOBOUNDARIES = [
    "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/gbOpen/{iso}/{niv}/geoBoundaries-{iso}-{niv}_simplified.geojson",
    "https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/gbOpen/{iso}/{niv}/geoBoundaries-{iso}-{niv}_simplified.geojson",
]
# Tracé très approximatif de la Falémé (absente de Natural Earth).
# Il sert uniquement à délimiter la zone indicative, il n'est pas affiché.
FALEME = [(-11.25, 11.95), (-11.35, 12.35), (-11.45, 12.75), (-11.8, 13.1),
          (-12.05, 13.6), (-12.2, 14.1), (-12.2, 14.45), (-12.3, 14.75)]
COURS_EAU_BASSIN = {"Sénégal", "Bafing", "Bakoy"}
CIBLE_UNITES = (55, 95)   # proche des 76 unités de niveau 2 annoncées par les TdR
CIBLE_REGIONS = (12, 20)  # en mode de repli, proche des 15 régions
GRAINE = 2026


# ---------------------------------------------------------------- outils
def lire_json(chemin):
    return json.loads(Path(chemin).read_text(encoding="utf-8"))


def ecrire_json(obj, chemin):
    Path(chemin).parent.mkdir(parents=True, exist_ok=True)
    Path(chemin).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def ecrire_csv(lignes, colonnes, chemin):
    Path(chemin).parent.mkdir(parents=True, exist_ok=True)
    with open(chemin, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=colonnes)
        w.writeheader()
        for ligne in lignes:
            w.writerow({k: ligne.get(k, "") for k in colonnes})


def arrondir(geom, n=4):
    def r(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], n), round(c[1], n)]
        return [r(x) for x in c]
    m = mapping(geom)
    return {"type": m["type"], "coordinates": r(m["coordinates"])}


def entite(props, geom):
    return {"type": "Feature", "properties": props, "geometry": arrondir(geom)}


def collection(entites):
    return {"type": "FeatureCollection", "features": entites}


# ---------------------------------------------------------------- limites
def telecharger(iso, niveau):
    cache = Path(os.environ.get("GB_DIR", RACINE / ".cache_geoboundaries"))
    fichier = cache / f"{iso}-{niveau}.geojson"
    if fichier.exists():
        return lire_json(fichier)
    for modele in URLS_GEOBOUNDARIES:
        url = modele.format(iso=iso, niv=niveau)
        try:
            with urllib.request.urlopen(url, timeout=90) as rep:
                donnees = json.loads(rep.read().decode("utf-8"))
            if donnees.get("features"):
                cache.mkdir(parents=True, exist_ok=True)
                fichier.write_text(json.dumps(donnees), encoding="utf-8")
                print(f"  {iso} {niveau} : {len(donnees['features'])} entités")
                return donnees
        except Exception as err:  # réseau, format…
            print(f"  {iso} {niveau} : échec sur {url} ({err})")
    # Dernier recours : l'API geoBoundaries, qui indique l'adresse du fichier simplifié
    try:
        api = f"https://www.geoboundaries.org/api/current/gbOpen/{iso}/{niveau}/"
        with urllib.request.urlopen(api, timeout=90) as rep:
            meta = json.loads(rep.read().decode("utf-8"))
        with urllib.request.urlopen(meta["simplifiedGeometryGeoJSON"], timeout=120) as rep:
            donnees = json.loads(rep.read().decode("utf-8"))
        if donnees.get("features"):
            cache.mkdir(parents=True, exist_ok=True)
            fichier.write_text(json.dumps(donnees), encoding="utf-8")
            print(f"  {iso} {niveau} : {len(donnees['features'])} entités (via l'API)")
            return donnees
    except Exception as err:
        print(f"  {iso} {niveau} : échec via l'API geoBoundaries ({err})")
    return None


def geometries(donnees):
    sortie = []
    for f in donnees["features"]:
        g = shape(f["geometry"])
        if not g.is_valid:
            g = g.buffer(0)
        if not g.is_empty:
            sortie.append((f["properties"], g))
    return sortie


def zone_bassin(rayon):
    fleuves = lire_json(SOURCES / "ne_fleuves.geojson")["features"]
    lignes = [LineString(FALEME)]
    for f in fleuves:
        nom = f["properties"].get("nom")
        g = shape(f["geometry"])
        if nom in COURS_EAU_BASSIN:
            lignes.append(g)
        elif nom == "Baoulé" and g.centroid.x < -7.8 and g.centroid.y > 12.3:
            lignes.append(g)
    return unary_union(lignes).buffer(rayon)


def recoupe(g, zone):
    if not g.intersects(zone):
        return False
    part = g.intersection(zone).area
    return part > 0.15 * g.area or part > 0.05


def choisir_rayon(candidats, cible=CIBLE_UNITES):
    meilleur = None
    for rayon in [0.45, 0.4, 0.5, 0.35, 0.55, 0.3, 0.6, 0.25, 0.7]:
        zone = zone_bassin(rayon)
        n = sum(1 for _, g in candidats if recoupe(g, zone))
        ecart = 0 if cible[0] <= n <= cible[1] else min(abs(n - cible[0]), abs(n - cible[1]))
        if meilleur is None or ecart < meilleur[0]:
            meilleur = (ecart, rayon, zone, n)
        if ecart == 0:
            break
    print(f"  rayon retenu : {meilleur[1]} degré(s), {meilleur[3]} unités")
    return meilleur[1], meilleur[2]


def construire_limites():
    """Renvoie (regions, unites, mode, rayon, zone)."""
    print("Téléchargement des limites geoBoundaries…")
    brut = {}
    for iso in PAYS:
        for niveau in ("ADM1", "ADM2"):
            brut[(iso, niveau)] = telecharger(iso, niveau)
    complet = all(brut.values())

    if complet:
        mode = "admin2"
        candidats = []
        for iso in PAYS:
            for props, g in geometries(brut[(iso, "ADM2")]):
                candidats.append(({"iso": iso, "nom": props.get("shapeName", "").strip(),
                                   "source_id": props.get("shapeID", "")}, g))
        rayon, zone = choisir_rayon(candidats)
        adm1 = {iso: geometries(brut[(iso, "ADM1")]) for iso in PAYS}
        retenues = []
        for props, g in candidats:
            if not recoupe(g, zone):
                continue
            pt = g.representative_point()
            parent = None
            for p1, g1 in adm1[props["iso"]]:
                if g1.contains(pt):
                    parent = (p1, g1)
                    break
            if parent is None:  # repli : plus grande intersection
                parent = max(adm1[props["iso"]], key=lambda pg: pg[1].intersection(g).area)
            props["region_nom"] = parent[0].get("shapeName", "").strip()
            props["region_geom"] = parent[1]
            retenues.append((props, g))
    else:
        mode = "regions"
        print("Limites de niveau 2 indisponibles : repli sur les régions Natural Earth.")
        candidats = [({"iso": f["properties"]["iso"], "nom": f["properties"]["nom"],
                       "source_id": f["properties"].get("id", "")}, shape(f["geometry"]))
                     for f in lire_json(SOURCES / "ne_regions.geojson")["features"]]
        rayon, zone = choisir_rayon(candidats, CIBLE_REGIONS)
        retenues = []
        for props, g in candidats:
            if recoupe(g, zone):
                props["region_nom"] = props["nom"]
                props["region_geom"] = g
                retenues.append((props, g))

    # Codes lisibles, stables pour une même source
    regions, unites = {}, []
    for iso, (prefixe, nom_pays) in PAYS.items():
        du_pays = sorted([u for u in retenues if u[0]["iso"] == iso],
                         key=lambda u: (u[0]["region_nom"], u[0]["nom"]))
        noms_regions = sorted({u[0]["region_nom"] for u in du_pays})
        codes_regions = {n: f"{prefixe}-R{i + 1:02d}" for i, n in enumerate(noms_regions)}
        for i, (props, g) in enumerate(du_pays, start=1):
            code_region = codes_regions[props["region_nom"]]
            code = code_region if mode == "regions" else f"{prefixe}-{i:02d}"
            regions.setdefault(code_region, {"code": code_region, "nom": props["region_nom"], "pays": iso,
                                             "pays_nom": nom_pays, "geom": props["region_geom"]})
            unites.append({"code": code, "nom": props["nom"], "region": code_region,
                           "region_nom": props["region_nom"], "pays": iso, "pays_nom": nom_pays,
                           "source_id": props["source_id"], "geom": g})
    return list(regions.values()), unites, mode, rayon, zone


# ---------------------------------------------------------------- données fictives
MODELES = {
    "agri": ["Maraîchage irrigué et agroécologie à {lieu}", "Semences paysannes et sols vivants autour de {lieu}",
             "Aménagement de petits périmètres irrigués à {lieu}"],
    "elev": ["Sécurisation des parcours pastoraux autour de {lieu}", "Santé animale de proximité à {lieu}",
             "Points d'eau pastoraux et gestion concertée à {lieu}"],
    "eau": ["Accès à l'eau potable dans les villages de {lieu}", "Gestion concertée des forages de {lieu}",
            "Assainissement et hygiène dans les écoles de {lieu}"],
    "energie": ["Énergie solaire pour les services de base à {lieu}", "Foyers améliorés et bois-énergie à {lieu}",
                "Restauration des terres dégradées autour de {lieu}"],
    "eco": ["Accompagnement des entreprises rurales de {lieu}", "Filière riz local, de la parcelle au marché à {lieu}",
            "Transformation agroalimentaire par les femmes de {lieu}"],
    "alim": ["Prévention de la malnutrition infantile à {lieu}", "Banques de céréales villageoises de {lieu}",
             "Diversification alimentaire des ménages de {lieu}"],
    "migr": ["Investissements de la diaspora dans les services de {lieu}", "Accueil et insertion des jeunes de retour à {lieu}",
             "Mobilités et développement local à {lieu}"],
    "jeun": ["Formation professionnelle des jeunes ruraux de {lieu}", "Insertion des jeunes par les métiers de l'eau à {lieu}",
             "Centres de ressources pour la jeunesse à {lieu}"],
    "risques": ["Prévention des inondations et alerte précoce à {lieu}", "Réduction des risques de crue autour de {lieu}"],
    "gouv": ["Dialogue territorial entre communes de {lieu}", "Appui aux plans de développement communal de {lieu}"],
}
RESUMES = {
    "agri": "Le projet renforce les exploitations familiales grâce à des pratiques agroécologiques, un meilleur accès à l'eau d'irrigation et au conseil agricole.",
    "elev": "Le projet sécurise la mobilité du bétail, améliore l'accès à l'eau et aux soins vétérinaires et prévient les conflits d'usage.",
    "eau": "Le projet améliore l'accès durable à l'eau potable et à l'assainissement, avec des comités de gestion formés et des tarifs concertés.",
    "energie": "Le projet diffuse des solutions énergétiques sobres et restaure les ressources naturelles avec les communautés.",
    "eco": "Le projet accompagne des activités économiques locales, de la production à la commercialisation, avec un accent sur l'emploi des femmes et des jeunes.",
    "alim": "Le projet améliore la sécurité alimentaire et nutritionnelle des ménages vulnérables, en lien avec les services de santé.",
    "migr": "Le projet valorise la contribution des migrants et de leurs associations au développement de leur territoire d'origine.",
    "jeun": "Le projet propose des formations qualifiantes et un accompagnement vers l'emploi aux jeunes du territoire.",
    "risques": "Le projet renforce la prévention des risques naturels, dont les inondations, et prépare les communes à y répondre.",
    "gouv": "Le projet appuie la concertation entre collectivités, services de l'État et société civile pour une gouvernance territoriale partagée.",
}
ODD = {"agri": [2, 12, 15], "elev": [2, 15], "eau": [6, 3], "energie": [7, 13, 15], "eco": [8, 1, 5],
       "alim": [2, 3], "migr": [10, 17], "jeun": [4, 8], "risques": [11, 13], "gouv": [16, 11, 17]}
PARTENAIRES = [
    "Union des groupements féminins", "Fédération des éleveurs", "Association des usagers du forage",
    "Coopérative rizicole villageoise", "Réseau des maires riverains", "Collectif des jeunes ruraux",
    "Agence régionale de développement", "Service régional de l'hydraulique", "Organisation paysanne faîtière",
    "Radio communautaire", "Comité villageois de gestion", "Mutuelle d'épargne et de crédit",
    "Centre de formation agricole", "Association des ressortissants en France", "Commission foncière communale",
    "Groupement de pêcheurs", "Plateforme des acteurs non étatiques", "Direction régionale de l'élevage",
]
BAILLEURS = [
    "Fondation Horizon Fleuve", "Fonds Sahel Solidaire", "Programme Eau et Territoires",
    "Coopération décentralisée (collectivités partenaires)", "Agence de coopération européenne",
    "Fonds pour les initiatives locales", "Fondation Terres d'avenir", "Programme régional de résilience",
]
ORGANISATIONS = ["ados", "avsf", "geres", "grdr", "gret", "lp"]
THEMES_PRINCIPAUX = ["agri", "elev", "eau", "energie", "eco", "alim", "migr", "jeun"]
COLONNES = ["id_projet", "intitule", "organisation", "thematiques", "odd", "annee_debut", "annee_fin", "etat",
            "resume", "unites_admin2", "partenaires", "bailleurs", "budget_eur", "beneficiaires",
            "_id", "_submission_time"]


def voisins(unites):
    idx = {}
    for u in unites:
        g = u["geom"].buffer(0.01)
        idx[u["code"]] = [v["code"] for v in unites if v is not u and v["pays"] == u["pays"] and g.intersects(v["geom"])]
    return idx


def generer_projet(rng, n, unites, par_code, vois, annee_min=2021):
    graine = rng.choice(unites)
    k = rng.choices([1, 2, 3, 4], weights=[45, 30, 18, 7])[0]
    codes = [graine["code"]]
    candidats = list(vois.get(graine["code"], []))
    rng.shuffle(candidats)
    codes += candidats[: k - 1]
    theme = rng.choice(THEMES_PRINCIPAUX)
    themes = [theme]
    if rng.random() < 0.35:
        themes.append(rng.choice([t for t in THEMES_PRINCIPAUX if t != theme]))
    if rng.random() < 0.28:
        themes.append(rng.choice(["risques", "gouv"]))
    debut = rng.choices(range(annee_min, 2026), weights=[18, 20, 22, 20, 20][: 2026 - annee_min])[0]
    fin = min(debut + rng.choice([1, 2, 2, 3, 3, 4]), 2027)
    etat = "en_cours" if fin >= 2026 else "termine"
    odd = sorted({o for t in themes for o in ODD[t]})
    budget = int(round(rng.lognormvariate(12.6, 0.8), -3))
    budget = max(40000, min(budget, 2500000))
    benef = int(round(rng.lognormvariate(8.3, 0.9), -1))
    benef = max(150, min(benef, 40000))
    lieu = graine["nom"]
    return {
        "id_projet": f"IFS-{debut}-{n:03d}",
        "intitule": rng.choice(MODELES[theme]).format(lieu=lieu),
        "organisation": rng.choice(ORGANISATIONS),
        "thematiques": " ".join(themes),
        "odd": " ".join(str(o) for o in odd),
        "annee_debut": debut,
        "annee_fin": fin,
        "etat": etat,
        "resume": RESUMES[theme],
        "unites_admin2": " ".join(codes),
        "partenaires": "; ".join(rng.sample(PARTENAIRES, rng.choice([1, 2, 2, 3]))),
        "bailleurs": "; ".join(rng.sample(BAILLEURS, rng.choice([1, 1, 2]))),
        "budget_eur": budget,
        "beneficiaires": benef,
        "_id": 480000 + n,
        "_submission_time": f"2026-0{rng.randint(6, 9)}-{rng.randint(10, 28)}T{rng.randint(8, 18):02d}:{rng.randint(0, 59):02d}:00",
    }


def generer_donnees(unites, zone):
    rng = random.Random(GRAINE)
    par_code = {u["code"]: u for u in unites}
    vois = voisins(unites)
    projets = [generer_projet(rng, n, unites, par_code, vois) for n in range(1, 73)]
    ecrire_csv(projets, COLONNES, DATA / "projets.csv")

    # Export d'exemple pour la démonstration de mise à jour
    nouveaux = [generer_projet(rng, n, unites, par_code, vois, annee_min=2024) for n in range(73, 78)]
    exemple = [dict(p) for p in projets]
    exemple[4]["beneficiaires"] = int(exemple[4]["beneficiaires"]) + 1200
    exemple[11]["etat"] = "termine"
    exemple[11]["annee_fin"] = 2025
    exemple += nouveaux
    anomalies = [generer_projet(rng, n, unites, par_code, vois, annee_min=2024) for n in range(78, 83)]
    anomalies[0]["annee_debut"], anomalies[0]["annee_fin"] = 2025, 2023
    anomalies[1]["unites_admin2"] = unites[0]["code"][:3] + "99"
    anomalies[2]["thematiques"] += " sante"
    anomalies[3]["beneficiaires"] = "environ 2000"
    anomalies[4]["id_projet"] = nouveaux[0]["id_projet"]
    exemple += anomalies
    ecrire_csv(exemple, COLONNES, DATA / "exemple_export_kobo.csv")
    ecrire_csv([projets[0]], COLONNES, DATA / "modele_import.csv")

    # Couche historique fictive (Traverse n°50, 2010-2020), placée sur des localités réelles
    villes = lire_json(SOURCES / "ne_villes.geojson")["features"]
    zone_large = zone.buffer(0.15)
    historique = []
    for f in villes:
        g = shape(f["geometry"])
        if f["properties"]["nom"] in ("Dakar", "Nouakchott", "Bamako", "Conakry") or not zone_large.contains(g):
            continue
        themes = rng.sample(THEMES_PRINCIPAUX, rng.choice([1, 2, 2, 3]))
        historique.append({"localite": f["properties"]["nom"], "pays": f["properties"]["iso"],
                           "lat": round(g.y, 4), "lon": round(g.x, 4), "nb_projets": rng.randint(1, 9),
                           "thematiques": " ".join(themes), "periode": "2010-2020"})
    ecrire_csv(historique, ["localite", "pays", "lat", "lon", "nb_projets", "thematiques", "periode"],
               DATA / "historique_traverses50.csv")
    return len(projets), len(historique)


# ---------------------------------------------------------------- programme
def main():
    regions, unites, mode, rayon, zone = construire_limites()
    ecrire_json(collection([entite({k: r[k] for k in ("code", "nom", "pays", "pays_nom")}, r["geom"])
                            for r in regions]), GEO / "regions.geojson")
    ecrire_json(collection([entite({k: u[k] for k in ("code", "nom", "region", "region_nom", "pays", "pays_nom")},
                                   u["geom"]) for u in unites]), GEO / "unites.geojson")
    ecrire_json(lire_json(SOURCES / "ne_pays.geojson"), GEO / "pays.geojson")
    fleuves = lire_json(SOURCES / "ne_fleuves.geojson")
    for f in fleuves["features"]:
        nom = f["properties"].get("nom")
        f["properties"]["principal"] = nom in COURS_EAU_BASSIN or nom == "Baoulé"
    ecrire_json(fleuves, GEO / "fleuves.geojson")
    ecrire_csv(unites, ["code", "nom", "region", "region_nom", "pays", "pays_nom", "source_id"],
               REF / "unites.csv")
    nb_projets, nb_hist = generer_donnees(unites, zone)
    manifeste = {
        "mode": mode,
        "genere_le": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "source_limites": "geoBoundaries (gbOpen, CC BY 4.0)" if mode == "admin2" else "Natural Earth (domaine public)",
        "rayon_zone_degres": rayon,
        "nb_pays": len({u["pays"] for u in unites}),
        "nb_regions": len(regions),
        "nb_unites": len(unites),
        "nb_projets": nb_projets,
        "nb_localites_historiques": nb_hist,
    }
    ecrire_json(manifeste, DATA / "manifest.json")
    print(json.dumps(manifeste, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
