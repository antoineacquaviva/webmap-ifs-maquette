/* Maquette webmap IFS — application cartographique
   Carte Leaflet, filtres croisés, agrégats par unité et par région, synthèse et fiches projet. */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const E = IFS.echapper;
  const N = IFS.formatNombre;
  const PALETTE = ["#EFE6C8", "#C9DDB8", "#86BDB5", "#3A8DB0", "#17507A"];
  const INDICES_PALETTE = { 1: [4], 2: [2, 4], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] };
  const LIBELLES = {
    projets: "Nombre de projets",
    organisations: "Organisations membres présentes",
    partenaires: "Nombre de partenaires",
    bailleurs: "Nombre de bailleurs",
    beneficiaires: "Bénéficiaires (estimation)",
  };
  const ZOOM_UNITES = 7;

  const S = {
    ref: null, projets: [], filtres: null, tries: [],
    indicateur: "projets", echelle: "auto", fond: "clair",
    couches: { donnees: true, historique: false, fleuves: true, regions: true, pays: true },
    selection: null, projetOuvert: null,
    agg: null, bornes: [], niveau: "regions",
    regionDe: {}, paysDe: {}, geo: {}, annees: [2021, 2027],
  };
  let carte, fonds, couches = {}, graphiqueAnnees = null, vueInitiale = null;

  const filtresVides = () => ({ pays: [], region: "", unite: "", orgs: [], themes: [], bailleur: "", partenaire: "", etat: "", de: null, a: null });

  // ================================================================ démarrage
  async function demarrer() {
    const params = new URLSearchParams(location.search);
    if (params.get("embed") === "1") {
      document.body.classList.add("integre");
      const lien = $("#plein-ecran");
      const url = new URL(location.href); url.searchParams.delete("embed");
      lien.href = url.toString(); lien.classList.remove("masque");
    }
    try {
      const ref = await IFS.chargerReferentiels("data/");
      const [pays, regions, unites, fleuves, rangs, historique] = await Promise.all([
        IFS.lireJSON("data/geo/pays.geojson"), IFS.lireJSON("data/geo/regions.geojson"),
        IFS.lireJSON("data/geo/unites.geojson"), IFS.lireJSON("data/geo/fleuves.geojson"),
        IFS.lireCSV("data/projets.csv"), IFS.lireCSV("data/historique_traverses50.csv"),
      ]);
      S.ref = ref;
      S.geo = { pays, regions, unites, fleuves, historique };
      ref.unites.forEach((u) => { S.regionDe[u.code] = u.region; S.paysDe[u.code] = u.pays; });
      S.regions = Object.fromEntries(regions.features.map((f) => [f.properties.code, f.properties]));

      let source = rangs;
      const imp = IFS.importLocal();
      if (imp && Array.isArray(imp.rangs)) { source = imp.rangs; annoncerImport(imp); }
      S.projets = IFS.controler(source, ref).projets;
      const debuts = S.projets.map((p) => p.debut), fins = S.projets.map((p) => p.fin);
      S.annees = [Math.min(2021, ...debuts), Math.max(2026, ...fins)];
      S.filtres = filtresVides();
      if (ref.manifeste.mode === "regions") S.echelle = "regions";
      lireHash();
      construireFiltres();
      construireCarte();
      brancherInterface();
      rafraichir({ hash: false });
      if (S.selection) rendreDetail();
    } catch (err) {
      console.error(err);
      $("#panneau-synthese").innerHTML = `<div class="vide"><strong>Les données n'ont pas pu être chargées.</strong>
        Si vous avez ouvert le fichier directement depuis votre ordinateur, consultez plutôt la version publiée,
        ou lancez un serveur local (voir le mode d'emploi du dépôt). Détail : ${E(err.message)}</div>`;
    }
  }

  function annoncerImport(imp) {
    const bloc = $("#info-import");
    bloc.innerHTML = `<span>Vous consultez les données importées le ${E(imp.date)} depuis « ${E(imp.fichier)} », dans ce navigateur uniquement.</span>
      <button class="bouton" type="button" id="revenir-demo">Revenir aux données de démonstration</button>`;
    bloc.classList.remove("masque");
    document.body.classList.add("avec-info");
    $("#revenir-demo").addEventListener("click", () => { IFS.effacerImport(); location.reload(); });
  }

  // ================================================================ filtres
  function dansPerimetre(code) {
    const f = S.filtres;
    if (f.unite) return code === f.unite;
    if (f.region) return S.regionDe[code] === f.region;
    if (f.pays.length) return f.pays.includes(S.paysDe[code]);
    return true;
  }
  function passe(p, f) {
    if ((f.unite || f.region || f.pays.length) && !p.unites.some(dansPerimetre)) return false;
    if (f.orgs.length && !f.orgs.includes(p.organisation)) return false;
    if (f.themes.length && !p.thematiques.some((t) => f.themes.includes(t))) return false;
    if (f.bailleur && !p.bailleurs.includes(f.bailleur)) return false;
    if (f.partenaire && !p.partenaires.includes(f.partenaire)) return false;
    if (f.etat && p.etat !== f.etat) return false;
    if (f.de && p.fin < f.de) return false;
    if (f.a && p.debut > f.a) return false;
    return true;
  }
  function nbFiltresActifs() {
    const f = S.filtres;
    return f.pays.length + !!f.region + !!f.unite + f.orgs.length + f.themes.length + !!f.bailleur + !!f.partenaire + !!f.etat + !!(f.de || f.a);
  }

  // ================================================================ agrégats
  const vide = () => ({ projets: new Set(), orgs: new Set(), partenaires: new Set(), bailleurs: new Set(), benef: 0, themes: {} });
  function agreger(projets) {
    const U = {}, R = {};
    for (const p of projets) {
      const part = p.beneficiaires ? p.beneficiaires / p.unites.length : 0;
      for (const u of p.unites) {
        if (!dansPerimetre(u)) continue;
        const r = S.regionDe[u];
        for (const [cible, cle] of [[U, u], [R, r]]) {
          const a = cible[cle] || (cible[cle] = vide());
          if (!a.projets.has(p.id)) p.thematiques.forEach((t) => { a.themes[t] = (a.themes[t] || 0) + 1; });
          a.projets.add(p.id); a.orgs.add(p.organisation);
          p.partenaires.forEach((x) => a.partenaires.add(x));
          p.bailleurs.forEach((x) => a.bailleurs.add(x));
          a.benef += part;
        }
      }
    }
    return { U, R };
  }
  function valeur(a) {
    if (!a) return 0;
    switch (S.indicateur) {
      case "organisations": return a.orgs.size;
      case "partenaires": return a.partenaires.size;
      case "bailleurs": return a.bailleurs.size;
      case "beneficiaires": return Math.round(a.benef);
      default: return a.projets.size;
    }
  }
  function calculerBornes(valeurs) {
    const v = valeurs.filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return [];
    const uniques = [...new Set(v)];
    if (uniques.length <= 5) return uniques;
    const bornes = [];
    for (let i = 1; i <= 5; i++) {
      let q = v[Math.min(v.length - 1, Math.ceil((i / 5) * v.length) - 1)];
      if (S.indicateur === "beneficiaires" && i < 5) q = arrondiJoli(q);
      if (!bornes.length || q > bornes[bornes.length - 1]) bornes.push(q);
    }
    bornes[bornes.length - 1] = v[v.length - 1];
    return bornes;
  }
  function arrondiJoli(x) {
    const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(x)) - 1));
    return Math.round(x / p) * p;
  }
  function classe(val) {
    if (!val) return -1;
    for (let i = 0; i < S.bornes.length; i++) if (val <= S.bornes[i]) return i;
    return S.bornes.length - 1;
  }
  const couleur = (c) => PALETTE[INDICES_PALETTE[S.bornes.length][c]];

  // ================================================================ carte
  function construireCarte() {
    carte = L.map("carte", { zoomSnap: 0.5, minZoom: 4.5, maxZoom: 12, preferCanvas: false });
    fonds = {
      clair: L.layerGroup([
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
          maxNativeZoom: 16, maxZoom: 19, attribution: "Fond de carte &copy; Esri" }),
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
          maxNativeZoom: 16, maxZoom: 19, pane: "etiquettes" }),
      ]),
      osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>' }),
      satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 18, attribution: "Imagerie &copy; Esri, Maxar, Earthstar Geographics" }),
    };
    [["donnees", 410], ["limites", 420], ["fleuves", 430], ["etiquettes", 440]].forEach(([nom, z]) => {
      const p = carte.createPane(nom); p.style.zIndex = z;
      if (nom !== "donnees") p.style.pointerEvents = "none";
    });

    const surEntite = (niveau) => (f, couche) => {
      const code = f.properties.code;
      couche.on("click", (ev) => { L.DomEvent.stopPropagation(ev); cliquer(niveau, code); });
      couche.on("mouseover", () => { couche.setStyle({ weight: 2.5, color: "#15313C" }); couche.bringToFront(); });
      couche.on("mouseout", () => { styler(); });
      couche.bindTooltip(() => infobulle(niveau, code), { sticky: true, className: "infobulle", direction: "top", offset: [0, -8] });
    };
    couches.unites = L.geoJSON(S.geo.unites, { pane: "donnees", onEachFeature: surEntite("unite") });
    couches.regions = L.geoJSON(S.geo.regions, { pane: "donnees", onEachFeature: surEntite("region") });
    couches.limRegions = L.geoJSON(S.geo.regions, { pane: "limites", interactive: false,
      style: { color: "#15313C", weight: 1.4, opacity: 0.55, fill: false } });
    couches.pays = L.geoJSON(S.geo.pays, { pane: "limites", interactive: false,
      style: { color: "#15313C", weight: 2.4, opacity: 0.85, fill: false } });
    couches.fleuves = L.geoJSON(S.geo.fleuves, { pane: "fleuves", interactive: false,
      style: (f) => f.properties.lac
        ? { color: "#2F78B5", weight: 1, fillColor: "#7DB3DC", fillOpacity: 0.7 }
        : { color: "#2F78B5", weight: f.properties.principal ? 3.2 : 1.3, opacity: f.properties.principal ? 0.95 : 0.55, lineCap: "round" } });
    couches.historique = L.layerGroup(S.geo.historique.map((h) => {
      const nb = Number(h.nb_projets) || 1;
      const themes = String(h.thematiques || "").split(/\s+/).filter(Boolean).map((t) => S.ref.theme[t] ? S.ref.theme[t].libelle : t);
      return L.circleMarker([Number(h.lat), Number(h.lon)], {
        radius: 4 + nb * 1.3, color: "#FFFFFF", weight: 1.5, fillColor: "#A8741B", fillOpacity: 0.9,
      }).bindPopup(`<div class="popup-hist"><h4>${E(h.localite)}</h4>
        <p>${E(IFS.NOMS_PAYS[h.pays] || h.pays)}, période ${E(h.periode)}</p>
        <p><strong>${nb} projet${nb > 1 ? "s" : ""}</strong> recensé${nb > 1 ? "s" : ""} par le Traverse n°50</p>
        <p>${E(themes.join(", "))}</p>
        <p class="note">Couche historique, non actualisée</p></div>`);
    }));

    carte.on("click", () => { /* clic hors territoire : rien */ });
    carte.on("zoomend", () => { if (S.agg && S.echelle === "auto") { afficherCouches(); rendreLegende(); } });

    // Bouton « vue d'ensemble »
    const Accueil = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const div = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const a = L.DomUtil.create("a", "", div);
        a.href = "#"; a.title = "Revenir à la vue d'ensemble"; a.setAttribute("role", "button");
        a.setAttribute("aria-label", "Revenir à la vue d'ensemble");
        a.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style="margin-top:7px"><path d="M8 2 1.5 7.5h2V14h3.5V10h2v4h3.5V7.5h2z" fill="currentColor"/></svg>';
        L.DomEvent.on(a, "click", (e) => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); vueEnsemble(); });
        return div;
      },
    });
    carte.addControl(new Accueil());
    L.control.scale({ imperial: false, position: "bottomright" }).addTo(carte);

    const erreurs = {};
    Object.entries(fonds).forEach(([nom, couche]) => {
      const tuiles = couche instanceof L.LayerGroup ? couche.getLayers() : [couche];
      tuiles.forEach((t) => t.on("tileerror", () => {
        erreurs[nom] = (erreurs[nom] || 0) + 1;
        if (erreurs[nom] === 8 && S.fond === nom && nom !== "osm") {
          console.warn(`Fond « ${nom} » indisponible : bascule sur OpenStreetMap.`);
          changerFond("osm");
        }
      }));
    });

    vueInitiale = couches.unites.getBounds().pad(0.04);
    carte.setMaxBounds(vueInitiale.pad(0.8));
    carte.fitBounds(vueInitiale);
    // Vue d'ensemble par régions ; les unités de niveau 2 apparaissent dès le premier zoom
    S.zoomUnites = Math.max(6, carte.getZoom() + 1);
    fonds[S.fond].addTo(carte);
  }

  function changerFond(nom) {
    if (carte.hasLayer(fonds[S.fond])) carte.removeLayer(fonds[S.fond]);
    S.fond = nom; fonds[nom].addTo(carte);
    document.querySelectorAll('input[name="c-fond"]').forEach((i) => (i.checked = i.value === nom));
    styler(); ecrireHash();
  }

  function vueEnsemble() { carte.fitBounds(vueInitiale); }

  function niveauAffiche() {
    if (S.ref.manifeste.mode === "regions") return "regions";
    if (S.echelle === "auto") return carte.getZoom() >= (S.zoomUnites || ZOOM_UNITES) ? "unites" : "regions";
    return S.echelle;
  }

  function afficherCouches() {
    S.niveau = niveauAffiche();
    const voir = (couche, oui) => { if (oui && !carte.hasLayer(couche)) couche.addTo(carte); if (!oui && carte.hasLayer(couche)) carte.removeLayer(couche); };
    const donnees = S.couches.donnees;
    voir(couches.unites, donnees && S.niveau === "unites");
    voir(couches.regions, donnees && S.niveau === "regions");
    const regionChoisie = S.selection && S.selection.niveau === "region";
    voir(couches.limRegions, (S.couches.regions || regionChoisie) && (S.niveau === "unites" || !donnees));
    voir(couches.pays, S.couches.pays);
    voir(couches.fleuves, S.couches.fleuves);
    voir(couches.historique, S.couches.historique);
  }

  function styler() {
    const opacite = S.fond === "satellite" ? 0.82 : 0.72;
    const selection = S.selection;
    const styleDe = (niveau) => (f) => {
      const code = f.properties.code;
      const agg = niveau === "unite" ? S.agg.U[code] : S.agg.R[code];
      const dedans = niveau === "unite" ? dansPerimetre(code) : S.ref.unites.some((u) => u.region === code && dansPerimetre(u.code));
      const choisi = selection && selection.code === code && selection.niveau === niveau;
      let st;
      if (!dedans) st = { fillColor: "#FFFFFF", fillOpacity: 0.45, color: "#8A9AA0", weight: 0.6, dashArray: "2 3" };
      else {
        const c = classe(valeur(agg));
        st = c < 0
          ? { fillColor: "#FFFFFF", fillOpacity: 0.2, color: "#5F737B", weight: 0.8, dashArray: "3 3" }
          : { fillColor: couleur(c), fillOpacity: opacite, color: "#FFFFFF", weight: 0.9, opacity: 0.95, dashArray: null };
      }
      if (choisi) Object.assign(st, { color: "#15313C", weight: 3.2, dashArray: null, opacity: 1 });
      return st;
    };
    const zonesProjet = new Set();
    if (S.projetOuvert) { const p = S.projets.find((x) => x.id === S.projetOuvert); if (p) p.unites.forEach((u) => zonesProjet.add(u)); }
    const styleUnite = styleDe("unite");
    couches.unites.setStyle((f) => {
      const st = styleUnite(f);
      if (zonesProjet.has(f.properties.code)) Object.assign(st, { color: "#A8741B", weight: 3.2, dashArray: null, opacity: 1 });
      return st;
    });
    const zonesRegions = new Set([...zonesProjet].map((u) => S.regionDe[u]));
    const styleRegion = styleDe("region");
    couches.regions.setStyle((f) => {
      const st = styleRegion(f);
      if (zonesRegions.has(f.properties.code)) Object.assign(st, { color: "#A8741B", weight: 3.2, dashArray: null, opacity: 1 });
      return st;
    });
    couches.limRegions.setStyle((f) => (selection && selection.niveau === "region" && selection.code === f.properties.code)
      ? { color: "#15313C", weight: 3.4, opacity: 1, fill: false }
      : { color: "#15313C", weight: 1.4, opacity: 0.55, fill: false });
    if (zonesProjet.size) {
      couches.unites.eachLayer((l) => { if (zonesProjet.has(l.feature.properties.code) && carte.hasLayer(couches.unites)) l.bringToFront(); });
      couches.regions.eachLayer((l) => { if (zonesRegions.has(l.feature.properties.code) && carte.hasLayer(couches.regions)) l.bringToFront(); });
    }
    if (selection && !zonesProjet.size) {
      const c = selection.niveau === "unite" ? couches.unites : couches.regions;
      c.eachLayer((l) => { if (l.feature.properties.code === selection.code && carte.hasLayer(c)) l.bringToFront(); });
    }
  }

  function infobulle(niveau, code) {
    const props = niveau === "unite" ? S.ref.unite[code] : S.regions[code];
    const agg = niveau === "unite" ? S.agg.U[code] : S.agg.R[code];
    const nom = props ? props.nom : code;
    const sous = niveau === "unite" ? `${IFS.TYPES_UNITE[props.pays] || "Unité"}, région ${props.region_nom}` : `Région, ${props.pays_nom}`;
    const v = valeur(agg);
    return `<b>${E(nom)}</b><br>${E(sous)}<br>${E(LIBELLES[S.indicateur])} : <b>${N(v)}</b>`;
  }

  function cliquer(niveau, code) {
    if (niveau === "region" && S.echelle === "auto" && S.ref.manifeste.mode !== "regions") {
      const couche = couches.regions.getLayers().find((l) => l.feature.properties.code === code);
      S.selection = { niveau, code };
      if (couche) {
        const b = couche.getBounds();
        const z = Math.max(carte.getBoundsZoom(b, false, L.point(40, 40)), S.zoomUnites || ZOOM_UNITES);
        carte.setView(b.getCenter(), Math.min(z, 10));
      }
    } else {
      S.selection = { niveau, code };
    }
    S.projetOuvert = null;
    styler(); rendreDetail(); ouvrirOnglet("detail"); ecrireHash();
    if (window.innerWidth < 760) $(".volet-infos").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ================================================================ rafraîchissement
  function rafraichir(opts) {
    opts = opts || {};
    S.tries = S.projets.filter((p) => passe(p, S.filtres));
    S.agg = agreger(S.tries);
    afficherCouches(); rendreLegende(); // la légende calcule les classes du niveau affiché et applique les styles
    rendreSynthese(); majCompteurs();
    if (S.selection) rendreDetail();
    if (opts.hash !== false) ecrireHash();
  }

  function rendreLegende() {
    const niveau = niveauAffiche();
    const source = niveau === "unites" ? S.agg.U : S.agg.R;
    S.bornes = calculerBornes(Object.values(source).map(valeur));
    styler();
    let html = "";
    if (S.couches.donnees) {
      html += `<p class="aide" style="margin:0 0 .35rem">${E(LIBELLES[S.indicateur])}, par ${niveau === "unites" ? "unité de niveau 2" : "région"}</p><ul>`;
      const entier = S.indicateur !== "beneficiaires";
      S.bornes.forEach((b, i) => {
        const bas = i === 0 ? Math.min(...Object.values(source).map(valeur).filter((x) => x > 0)) : (entier ? S.bornes[i - 1] + 1 : S.bornes[i - 1]);
        const txt = bas >= b ? N(b) : (entier ? `${N(bas)} à ${N(b)}` : `${N(bas)} à ${N(b)}`);
        html += `<li><span class="carre" style="background:${couleur(i)}"></span>${txt}</li>`;
      });
      html += `<li><span class="carre aucun"></span>Aucun projet</li></ul>`;
      if (S.echelle === "auto" && S.ref.manifeste.mode !== "regions")
        html += `<p class="echelle-note">${niveau === "regions" ? "Zoomez pour afficher les unités de niveau 2." : "Dézoomez pour revenir aux régions."}</p>`;
    }
    if (S.couches.historique || S.couches.fleuves) {
      html += `<ul style="margin-top:.45rem">`;
      if (S.couches.historique) html += `<li><span class="rond"></span>Projets 2010-2020 (Traverse n°50), non actualisés</li>`;
      if (S.couches.fleuves) html += `<li><span class="ligne-fleuve"></span>Fleuve Sénégal et affluents</li>`;
      html += `</ul>`;
    }
    if (S.legendeOuverte === undefined) S.legendeOuverte = window.innerWidth >= 760;
    $("#legende").innerHTML = html ? `<details ${S.legendeOuverte ? "open" : ""}><summary>Légende</summary>${html}</details>` : "";
    $("#legende").classList.toggle("masque", !html);
    const d = $("#legende details");
    if (d) d.addEventListener("toggle", () => { S.legendeOuverte = d.open; });
  }

  function majCompteurs() {
    $("#nb-filtres").textContent = `${N(S.tries.length)} projet${S.tries.length > 1 ? "s" : ""}`;
    $("#nb-total").textContent = `sur ${N(S.projets.length)}`;
    $("#fermer-filtres").textContent = `Voir ${S.tries.length > 1 ? "les " + N(S.tries.length) + " projets" : S.tries.length ? "le projet" : "la carte"}`;
    const f = S.filtres, n = nbFiltresActifs();
    $("#nb-filtres-actifs").textContent = n ? `(${n})` : "";
    const txt = (x) => (x ? `${x} actif${x > 1 ? "s" : ""}` : "");
    $("#actif-territoire").textContent = txt(f.pays.length + !!f.region + !!f.unite);
    $("#actif-theme").textContent = txt(f.themes.length);
    $("#actif-org").textContent = txt(f.orgs.length);
    $("#actif-acteurs").textContent = txt(!!f.bailleur + !!f.partenaire);
    $("#actif-periode").textContent = txt(!!f.etat + !!(f.de || f.a));
  }

  // ================================================================ synthèse
  function totaux(projets) {
    const t = { orgs: new Set(), partenaires: new Set(), bailleurs: new Set(), benef: 0, budget: 0, pays: {}, themes: {}, orgsN: {}, annees: {} };
    for (const p of projets) {
      t.orgs.add(p.organisation); t.orgsN[p.organisation] = (t.orgsN[p.organisation] || 0) + 1;
      p.partenaires.forEach((x) => t.partenaires.add(x));
      p.bailleurs.forEach((x) => t.bailleurs.add(x));
      const dedans = p.unites.filter(dansPerimetre);
      if (p.beneficiaires) t.benef += p.beneficiaires * (dedans.length / p.unites.length);
      t.budget += p.budget || 0;
      p.thematiques.forEach((x) => { t.themes[x] = (t.themes[x] || 0) + 1; });
      new Set(dedans.map((u) => S.paysDe[u])).forEach((x) => { t.pays[x] = (t.pays[x] || 0) + 1; });
      for (let a = p.debut; a <= p.fin; a++) t.annees[a] = (t.annees[a] || 0) + 1;
    }
    return t;
  }

  function barres(entrees, total, options) {
    const max = Math.max(1, ...entrees.map((e) => e.n));
    return `<div class="barres">${entrees.map((e) => `
      <button type="button" class="barre" data-filtre="${options.filtre}" data-valeur="${E(e.code)}" aria-pressed="${e.actif ? "true" : "false"}"
        title="${options.titre ? E(options.titre) : ""}">
        <span class="libelle">${E(e.libelle)}</span><span class="valeur">${N(e.n)}</span>
        <span class="jauge"><i style="width:${(e.n / max) * 100}%;background:${e.couleur || "var(--fleuve)"}"></i></span>
      </button>`).join("")}</div>`;
  }

  function resumeFiltres() {
    const f = S.filtres, R = S.ref, puces = [];
    f.pays.forEach((p) => puces.push(["pays", p, IFS.NOMS_PAYS[p]]));
    if (f.region) puces.push(["region", f.region, "Région " + (S.regions[f.region] || {}).nom]);
    if (f.unite) puces.push(["unite", f.unite, (R.unite[f.unite] || {}).nom]);
    f.themes.forEach((t) => puces.push(["themes", t, R.theme[t].libelle]));
    f.orgs.forEach((o) => puces.push(["orgs", o, R.org[o].nom]));
    if (f.bailleur) puces.push(["bailleur", f.bailleur, f.bailleur]);
    if (f.partenaire) puces.push(["partenaire", f.partenaire, f.partenaire]);
    if (f.etat) puces.push(["etat", f.etat, f.etat === "en_cours" ? "En cours" : "Terminés"]);
    if (f.de || f.a) puces.push(["periode", "", `Actifs de ${f.de || S.annees[0]} à ${f.a || S.annees[1]}`]);
    return puces;
  }

  function rendreSynthese() {
    const t = totaux(S.tries), R = S.ref, f = S.filtres;
    const puces = resumeFiltres();
    const themes = R.thematiques.map((x) => ({ code: x.code, libelle: x.libelle + (x.type === "Transversale" ? " (transversale)" : ""), n: t.themes[x.code] || 0, couleur: x.couleur, actif: f.themes.includes(x.code) }))
      .filter((x) => x.n || x.actif).sort((a, b) => b.n - a.n);
    const orgs = R.organisations.map((o) => ({ code: o.code, libelle: o.nom, n: t.orgsN[o.code] || 0, actif: f.orgs.includes(o.code) }))
      .filter((x) => x.n || x.actif).sort((a, b) => b.n - a.n);
    const pays = Object.keys(IFS.NOMS_PAYS).map((p) => ({ code: p, libelle: IFS.NOMS_PAYS[p], n: t.pays[p] || 0, actif: f.pays.includes(p) }))
      .filter((x) => x.n || x.actif).sort((a, b) => b.n - a.n);

    const zone = $("#panneau-synthese");
    if (!S.tries.length) {
      zone.innerHTML = `<h2>Synthèse</h2>
        ${puces.length ? `<div class="etiquettes" style="margin:.5rem 0 0">${puces.map(pucesHTML).join("")}</div>` : ""}
        <div class="vide"><strong>Aucun projet ne correspond à ces filtres.</strong>Retirez un filtre, ou élargissez la période.</div>
        <button class="bouton" type="button" data-action="reinitialiser">Effacer les filtres</button>`;
      return;
    }
    zone.innerHTML = `
      <h2>Synthèse</h2>
      <p class="resume-filtres">${N(S.tries.length)} projet${S.tries.length > 1 ? "s" : ""} sur ${N(S.projets.length)}${puces.length ? ", selon les filtres :" : ", sans filtre"}</p>
      ${puces.length ? `<div class="etiquettes" style="margin-bottom:.9rem">${puces.map(pucesHTML).join("")}</div>` : ""}
      <div class="chiffres">
        <div class="chiffre"><b>${N(S.tries.length)}</b><span>projets</span></div>
        <div class="chiffre"><b>${N(t.orgs.size)}</b><span>organisations membres</span></div>
        <div class="chiffre"><b>${N(t.partenaires.size)}</b><span>partenaires</span></div>
        <div class="chiffre"><b>${N(t.bailleurs.size)}</b><span>bailleurs</span></div>
        <div class="chiffre"><b>${N(t.benef)}</b><span>bénéficiaires</span></div>
        <div class="chiffre"><b>${IFS.formatEuros(t.budget)}</b><span>budgets cumulés</span></div>
      </div>
      <h3>Par thématique</h3>
      ${barres(themes, S.tries.length, { filtre: "themes", titre: "Cliquer pour filtrer sur cette thématique" })}
      <p class="aide">Un projet peut relever de plusieurs thématiques. Cliquez sur une barre pour filtrer.</p>
      <h3>Projets actifs par année</h3>
      <div class="graphique"><canvas id="graphique-annees" aria-label="Nombre de projets actifs par année" role="img"></canvas></div>
      <h3>Par organisation membre</h3>
      ${barres(orgs, S.tries.length, { filtre: "orgs", titre: "Cliquer pour filtrer sur cette organisation" })}
      <h3>Par pays</h3>
      ${barres(pays, S.tries.length, { filtre: "pays", titre: "Cliquer pour filtrer sur ce pays" })}
      <p class="aide">Un projet transfrontalier compte dans chacun de ses pays.</p>`;
    dessinerAnnees(t);
  }

  function pucesHTML(p) {
    return `<button type="button" class="etiquette" data-retirer="${p[0]}" data-valeur="${E(p[1])}" title="Retirer ce filtre">${E(p[2])}</button>`;
  }

  function dessinerAnnees(t) {
    const annees = []; for (let a = S.annees[0]; a <= S.annees[1]; a++) annees.push(a);
    const toile = $("#graphique-annees");
    if (graphiqueAnnees) graphiqueAnnees.destroy();
    graphiqueAnnees = new Chart(toile, {
      type: "bar",
      data: { labels: annees.map(String), datasets: [{ data: annees.map((a) => t.annees[a] || 0), backgroundColor: "#3A8DB0", hoverBackgroundColor: "#17507A", borderRadius: 3, maxBarThickness: 28 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.y} projet${c.parsed.y > 1 ? "s" : ""} actif${c.parsed.y > 1 ? "s" : ""}` } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: "Atkinson", size: 11 }, color: "#566A73" } },
          y: { beginAtZero: true, ticks: { precision: 0, font: { family: "Atkinson", size: 11 }, color: "#566A73" }, grid: { color: "#E6ECEE" } },
        },
      },
    });
  }

  // ================================================================ détail d'un territoire
  function projetsDe(niveau, code) {
    return S.tries.filter((p) => p.unites.some((u) => (niveau === "unite" ? u === code : S.regionDe[u] === code) && dansPerimetre(u)));
  }

  function rendreDetail() {
    const zone = $("#panneau-detail");
    if (S.projetOuvert) return rendreFiche(zone);
    if (!S.selection) {
      zone.innerHTML = `<div class="vide"><strong>Choisissez un territoire.</strong>Cliquez sur une région ou une unité de la carte pour voir ses chiffres et la liste de ses projets.</div>`;
      return;
    }
    const { niveau, code } = S.selection;
    const props = niveau === "unite" ? S.ref.unite[code] : S.regions[code];
    if (!props) { S.selection = null; return rendreDetail(); }
    const agg = (niveau === "unite" ? S.agg.U[code] : S.agg.R[code]) || vide();
    const projets = projetsDe(niveau, code).sort((a, b) => b.debut - a.debut || a.intitule.localeCompare(b.intitule));
    const R = S.ref;
    const themes = Object.entries(agg.themes).map(([c, n]) => ({ code: c, libelle: R.theme[c].libelle, n, couleur: R.theme[c].couleur, actif: S.filtres.themes.includes(c) })).sort((a, b) => b.n - a.n);
    const fil = niveau === "unite"
      ? `${E(props.pays_nom)}, région ${E(props.region_nom)}`
      : `${E(props.pays_nom)}`;
    const type = niveau === "unite" ? (IFS.TYPES_UNITE[props.pays] || "Unité administrative") : "Région";
    let unitesRegion = "";
    if (niveau === "region" && S.ref.manifeste.mode !== "regions") {
      const us = S.ref.unites.filter((u) => u.region === code).map((u) => ({ u, n: (S.agg.U[u.code] || vide()).projets.size })).sort((a, b) => b.n - a.n);
      unitesRegion = `<h3>Unités de la région</h3><div class="barres">${us.map(({ u, n }) => `
        <button type="button" class="barre" data-unite="${E(u.code)}"><span class="libelle">${E(u.nom)}</span><span class="valeur">${N(n)} projet${n > 1 ? "s" : ""}</span>
        <span class="jauge"><i style="width:${(n / Math.max(1, ...us.map((x) => x.n))) * 100}%;background:var(--c4)"></i></span></button>`).join("")}</div>`;
    }
    zone.innerHTML = `
      <p class="fil">${fil}</p>
      <h2>${E(props.nom)}</h2>
      <p class="resume-filtres">${type}${nbFiltresActifs() ? ", selon les filtres en cours" : ""}</p>
      <div class="chiffres">
        <div class="chiffre"><b>${N(agg.projets.size)}</b><span>projets</span></div>
        <div class="chiffre"><b>${N(agg.orgs.size)}</b><span>organisations membres</span></div>
        <div class="chiffre"><b>${N(agg.partenaires.size)}</b><span>partenaires</span></div>
        <div class="chiffre"><b>${N(agg.bailleurs.size)}</b><span>bailleurs</span></div>
        <div class="chiffre"><b>${N(agg.benef)}</b><span>bénéficiaires</span></div>
        <div class="chiffre"><b>${N(themes.length)}</b><span>thématiques</span></div>
      </div>
      <div class="actions" style="margin-top:.75rem">
        <button class="bouton" type="button" data-action="filtrer-territoire">Filtrer sur ce territoire</button>
        <button class="bouton discret" type="button" data-action="fermer-detail">Fermer</button>
      </div>
      ${agg.orgs.size ? `<h3>Organisations présentes</h3><div class="etiquettes">${[...agg.orgs].map((o) => `<span class="etiquette">${E(R.org[o] ? R.org[o].nom : o)}</span>`).join("")}</div>` : ""}
      ${themes.length ? `<h3>Thématiques</h3>${barres(themes, 0, { filtre: "themes", titre: "Cliquer pour filtrer sur cette thématique" })}` : ""}
      <h3>Projets (${N(projets.length)})</h3>
      ${projets.length ? `<ul class="projets">${projets.map((p) => `
        <li><button type="button" data-projet="${E(p.id)}">
          <span class="titre">${E(p.intitule)}</span>
          <span class="meta"><span>${E(R.org[p.organisation].nom)}</span><span>${p.debut} à ${p.fin}</span><span class="etat ${p.etat}">${p.etat === "en_cours" ? "En cours" : "Terminé"}</span></span>
        </button></li>`).join("")}</ul>`
      : `<div class="vide"><strong>Aucun projet ici avec ces filtres.</strong>Retirez un filtre pour élargir la recherche.</div>`}
      ${unitesRegion}`;
  }

  function rendreFiche(zone) {
    const p = S.projets.find((x) => x.id === S.projetOuvert);
    if (!p) { S.projetOuvert = null; return rendreDetail(); }
    const R = S.ref;
    const retour = S.selection ? (S.selection.niveau === "unite" ? R.unite[S.selection.code] : S.regions[S.selection.code]) : null;
    const zones = p.unites.map((u) => R.unite[u]).filter(Boolean);
    zone.innerHTML = `
      <div class="fiche">
        <button class="bouton discret retour" type="button" data-action="retour">${retour ? "Retour à " + E(retour.nom) : "Retour"}</button>
        <p class="fil">${E(R.org[p.organisation].nom)}, organisation porteuse</p>
        <h2>${E(p.intitule)}</h2>
        <div class="projets"><span class="meta"><span class="etat ${p.etat}">${p.etat === "en_cours" ? "En cours" : "Terminé"}</span><span>Mise en œuvre de ${p.debut} à ${p.fin}</span></span></div>
        <p class="intro">${E(p.resume)}</p>
        <dl>
          <dt>Thématiques</dt><dd class="etiquettes">${p.thematiques.map((t) => `<span class="etiquette"><span class="puce" style="background:${R.theme[t].couleur}"></span>${E(R.theme[t].libelle)}</span>`).join("")}</dd>
          <dt>Objectifs de développement durable</dt><dd class="etiquettes">${p.odd.map((o) => `<span class="etiquette">ODD ${o}</span>`).join("") || "–"}</dd>
          <dt>Zones d'intervention</dt><dd>${zones.map((u) => `${E(u.nom)} (${E(u.pays_nom)})`).join(", ")}</dd>
          <dt>Partenaires techniques</dt><dd>${E(p.partenaires.join(", ")) || "–"}</dd>
          <dt>Bailleurs</dt><dd>${E(p.bailleurs.join(", ")) || "–"}</dd>
          <dt>Budget global</dt><dd>${p.budget ? N(p.budget) + " €" : "–"}</dd>
          <dt>Bénéficiaires</dt><dd>${p.beneficiaires ? N(p.beneficiaires) : "–"}</dd>
          <dt>Identifiant</dt><dd>${E(p.id)}</dd>
        </dl>
      </div>`;
  }

  function ouvrirOnglet(nom) {
    const s = nom === "synthese";
    $("#onglet-synthese").setAttribute("aria-selected", s);
    $("#onglet-detail").setAttribute("aria-selected", !s);
    $("#panneau-synthese").classList.toggle("masque", !s);
    $("#panneau-detail").classList.toggle("masque", s);
    if (s && graphiqueAnnees) graphiqueAnnees.resize();
  }

  // ================================================================ construction des filtres
  function options(liste, tous) {
    return `<option value="">${E(tous)}</option>` + liste.map((o) => `<option value="${E(o.v)}">${E(o.l)}</option>`).join("");
  }
  function construireFiltres() {
    const R = S.ref;
    const paysPresents = [...new Set(R.unites.map((u) => u.pays))];
    $("#f-pays").innerHTML = paysPresents.map((p) => `<label class="case"><input type="checkbox" value="${p}"> ${E(IFS.NOMS_PAYS[p])}</label>`).join("");
    const themeHTML = (t) => `<label class="case"><input type="checkbox" value="${t.code}"><span class="puce" style="background:${t.couleur}"></span>${E(t.libelle)}</label>`;
    $("#f-theme").innerHTML = R.thematiques.filter((t) => t.type !== "Transversale").map(themeHTML).join("")
      + `<p class="aide" style="margin:.35rem 0 0">Entrées transversales</p>` + R.thematiques.filter((t) => t.type === "Transversale").map(themeHTML).join("");
    $("#f-org").innerHTML = R.organisations.map((o) => `<label class="case"><input type="checkbox" value="${o.code}"> ${E(o.nom)}</label>`).join("");
    const uniques = (cle) => [...new Set(S.projets.flatMap((p) => p[cle]))].sort((a, b) => a.localeCompare(b, "fr"));
    $("#f-bailleur").innerHTML = options(uniques("bailleurs").map((b) => ({ v: b, l: b })), "Tous les bailleurs");
    $("#f-partenaire").innerHTML = options(uniques("partenaires").map((b) => ({ v: b, l: b })), "Tous les partenaires");
    const annees = []; for (let a = S.annees[0]; a <= S.annees[1]; a++) annees.push({ v: a, l: a });
    $("#f-de").innerHTML = options(annees, "Début");
    $("#f-a").innerHTML = options(annees, "Fin");
    majListesGeo();
    appliquerFiltresAuxChamps();
  }

  function majListesGeo() {
    const R = S.ref, f = S.filtres;
    const regions = Object.values(S.regions).filter((r) => !f.pays.length || f.pays.includes(r.pays)).sort((a, b) => a.pays_nom.localeCompare(b.pays_nom) || a.nom.localeCompare(b.nom, "fr"));
    const parPays = {};
    regions.forEach((r) => (parPays[r.pays_nom] = parPays[r.pays_nom] || []).push(r));
    $("#f-region").innerHTML = `<option value="">Toutes les régions</option>` + Object.entries(parPays).map(([p, rs]) =>
      `<optgroup label="${E(p)}">${rs.map((r) => `<option value="${E(r.code)}">${E(r.nom)}</option>`).join("")}</optgroup>`).join("");
    if (f.region && !regions.some((r) => r.code === f.region)) f.region = "";
    $("#f-region").value = f.region;
    const unites = R.unites.filter((u) => (!f.pays.length || f.pays.includes(u.pays)) && (!f.region || u.region === f.region));
    const parRegion = {};
    unites.forEach((u) => (parRegion[`${u.region_nom} (${u.pays_nom})`] = parRegion[`${u.region_nom} (${u.pays_nom})`] || []).push(u));
    const unitesSel = $("#f-unite");
    if (R.manifeste.mode === "regions") { unitesSel.innerHTML = `<option value="">Non disponible dans cette version</option>`; unitesSel.disabled = true; return; }
    unitesSel.innerHTML = `<option value="">Toutes les unités</option>` + Object.entries(parRegion).sort().map(([r, us]) =>
      `<optgroup label="${E(r)}">${us.sort((a, b) => a.nom.localeCompare(b.nom, "fr")).map((u) => `<option value="${E(u.code)}">${E(u.nom)}</option>`).join("")}</optgroup>`).join("");
    if (f.unite && !unites.some((u) => u.code === f.unite)) f.unite = "";
    unitesSel.value = f.unite;
  }

  function appliquerFiltresAuxChamps() {
    const f = S.filtres;
    document.querySelectorAll("#f-pays input").forEach((i) => (i.checked = f.pays.includes(i.value)));
    document.querySelectorAll("#f-theme input").forEach((i) => (i.checked = f.themes.includes(i.value)));
    document.querySelectorAll("#f-org input").forEach((i) => (i.checked = f.orgs.includes(i.value)));
    majListesGeo();
    $("#f-bailleur").value = f.bailleur; $("#f-partenaire").value = f.partenaire;
    $("#f-de").value = f.de || ""; $("#f-a").value = f.a || "";
    document.querySelectorAll("#f-etat button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.etat === f.etat)));
    $("#c-indicateur").value = S.indicateur;
    document.querySelectorAll('input[name="c-echelle"]').forEach((i) => { i.checked = i.value === S.echelle; i.disabled = S.ref.manifeste.mode === "regions" && i.value !== "regions"; });
    document.querySelectorAll('input[name="c-fond"]').forEach((i) => (i.checked = i.value === S.fond));
    ["donnees", "historique", "fleuves", "regions", "pays"].forEach((c) => ($("#c-" + c).checked = S.couches[c]));
  }

  const basculer = (tab, v) => (tab.includes(v) ? tab.filter((x) => x !== v) : [...tab, v]);

  // ================================================================ interactions
  function brancherInterface() {
    const f = () => S.filtres;
    const change = () => rafraichir();
    $("#f-pays").addEventListener("change", (e) => { f().pays = basculer(f().pays, e.target.value); majListesGeo(); change(); });
    $("#f-region").addEventListener("change", (e) => { f().region = e.target.value; f().unite = ""; majListesGeo(); change(); });
    $("#f-unite").addEventListener("change", (e) => { f().unite = e.target.value; change(); });
    $("#f-theme").addEventListener("change", (e) => { f().themes = basculer(f().themes, e.target.value); change(); });
    $("#f-org").addEventListener("change", (e) => { f().orgs = basculer(f().orgs, e.target.value); change(); });
    $("#f-bailleur").addEventListener("change", (e) => { f().bailleur = e.target.value; change(); });
    $("#f-partenaire").addEventListener("change", (e) => { f().partenaire = e.target.value; change(); });
    $("#f-de").addEventListener("change", (e) => { f().de = Number(e.target.value) || null; if (f().a && f().de && f().de > f().a) { f().a = f().de; $("#f-a").value = f().a; } change(); });
    $("#f-a").addEventListener("change", (e) => { f().a = Number(e.target.value) || null; if (f().a && f().de && f().de > f().a) { f().de = f().a; $("#f-de").value = f().de; } change(); });
    $("#f-etat").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      f().etat = b.dataset.etat;
      document.querySelectorAll("#f-etat button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      change();
    });
    $("#reinitialiser").addEventListener("click", reinitialiser);
    $("#copier-lien").addEventListener("click", copierLien);

    // Couches
    const panneau = $("#carte-couches"), bouton = $("#bouton-couches");
    bouton.addEventListener("click", () => {
      const ouvert = panneau.classList.toggle("masque") === false;
      bouton.setAttribute("aria-expanded", String(ouvert));
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panneau.classList.contains("masque")) { panneau.classList.add("masque"); bouton.setAttribute("aria-expanded", "false"); bouton.focus(); } });
    $("#c-indicateur").addEventListener("change", (e) => { S.indicateur = e.target.value; rafraichir(); });
    panneau.addEventListener("change", (e) => {
      const t = e.target;
      if (t.name === "c-echelle") { S.echelle = t.value; rafraichir(); }
      else if (t.name === "c-fond") {
        changerFond(t.value);
      } else if (t.id && t.id.startsWith("c-") && t.type === "checkbox") {
        S.couches[t.id.slice(2)] = t.checked; afficherCouches(); rendreLegende(); ecrireHash();
      }
    });

    // Onglets
    $("#onglet-synthese").addEventListener("click", () => ouvrirOnglet("synthese"));
    $("#onglet-detail").addEventListener("click", () => { rendreDetail(); ouvrirOnglet("detail"); });

    // Délégation dans le volet d'information
    $(".volet-infos").addEventListener("click", (e) => {
      const el = e.target.closest("button"); if (!el) return;
      if (el.dataset.filtre) {
        const cle = el.dataset.filtre, v = el.dataset.valeur;
        S.filtres[cle] = basculer(S.filtres[cle], v);
        appliquerFiltresAuxChamps(); rafraichir();
      } else if (el.dataset.retirer) {
        retirerFiltre(el.dataset.retirer, el.dataset.valeur);
      } else if (el.dataset.projet) {
        S.projetOuvert = el.dataset.projet; rendreDetail(); styler(); ecrireHash();
        if (window.innerWidth < 760) $("#panneau-detail").scrollIntoView({ behavior: "smooth", block: "start" });
        else $(".volet-infos").scrollTop = 0;
      } else if (el.dataset.unite) {
        cliquer("unite", el.dataset.unite);
        const couche = couches.unites.getLayers().find((l) => l.feature.properties.code === el.dataset.unite);
        if (couche && S.echelle !== "regions") carte.fitBounds(couche.getBounds(), { maxZoom: 9, padding: [30, 30] });
      } else if (el.dataset.action === "retour") {
        S.projetOuvert = null; rendreDetail(); styler(); ecrireHash();
      } else if (el.dataset.action === "fermer-detail") {
        S.selection = null; S.projetOuvert = null; styler(); rendreDetail(); ouvrirOnglet("synthese"); ecrireHash();
      } else if (el.dataset.action === "filtrer-territoire") {
        const { niveau, code } = S.selection;
        if (niveau === "unite") { S.filtres.unite = code; S.filtres.region = S.regionDe[code]; S.filtres.pays = [S.paysDe[code]]; }
        else { S.filtres.region = code; S.filtres.unite = ""; S.filtres.pays = [S.regions[code].pays]; }
        appliquerFiltresAuxChamps(); rafraichir();
      } else if (el.dataset.action === "reinitialiser") {
        reinitialiser();
      }
    });

    // Tiroir des filtres (écrans moyens et petits)
    $("#ouvrir-filtres").addEventListener("click", () => { document.body.classList.add("filtres-ouverts"); $("#fermer-filtres").focus(); });
    $("#fermer-filtres").addEventListener("click", () => { document.body.classList.remove("filtres-ouverts"); $("#ouvrir-filtres").focus(); });

    // À propos
    $("#ouvrir-apropos").addEventListener("click", ouvrirAPropos);
    $("#fermer-apropos").addEventListener("click", () => $("#apropos").close());
    $("#apropos").addEventListener("click", (e) => { if (e.target.id === "apropos") $("#apropos").close(); });

    window.addEventListener("resize", () => carte.invalidateSize());
  }

  function retirerFiltre(cle, v) {
    const f = S.filtres;
    if (cle === "periode") { f.de = null; f.a = null; }
    else if (Array.isArray(f[cle])) f[cle] = f[cle].filter((x) => x !== v);
    else f[cle] = "";
    if (cle === "pays") { f.region = ""; f.unite = ""; }
    if (cle === "region") f.unite = "";
    appliquerFiltresAuxChamps(); rafraichir();
  }

  function reinitialiser() {
    S.filtres = filtresVides();
    appliquerFiltresAuxChamps(); rafraichir();
  }

  function copierLien() {
    const b = $("#copier-lien"), url = location.href;
    const fini = (ok) => { b.textContent = ok ? "Lien copié" : "Copiez l'adresse de la page"; setTimeout(() => (b.textContent = "Copier le lien de cette vue"), 2200); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => fini(true), () => fini(false));
    else fini(false);
  }

  // ================================================================ lien partageable (adresse)
  function ecrireHash() {
    const f = S.filtres, p = new URLSearchParams();
    if (f.pays.length) p.set("pays", f.pays.join(","));
    if (f.region) p.set("region", f.region);
    if (f.unite) p.set("unite", f.unite);
    if (f.themes.length) p.set("themes", f.themes.join(","));
    if (f.orgs.length) p.set("orgs", f.orgs.join(","));
    if (f.bailleur) p.set("bailleur", f.bailleur);
    if (f.partenaire) p.set("partenaire", f.partenaire);
    if (f.etat) p.set("etat", f.etat);
    if (f.de) p.set("de", f.de);
    if (f.a) p.set("a", f.a);
    if (S.indicateur !== "projets") p.set("indicateur", S.indicateur);
    if (S.fond !== "clair") p.set("fond", S.fond);
    if (S.echelle !== "auto" && S.ref.manifeste.mode !== "regions") p.set("echelle", S.echelle);
    if (S.couches.historique) p.set("historique", "1");
    if (S.selection) p.set("territoire", `${S.selection.niveau}:${S.selection.code}`);
    if (S.projetOuvert) p.set("projet", S.projetOuvert);
    const h = p.toString();
    history.replaceState(null, "", location.pathname + location.search + (h ? "#" + h : ""));
  }
  function lireHash() {
    const p = new URLSearchParams(location.hash.slice(1)), f = S.filtres, R = S.ref;
    const liste = (k, ok) => (p.get(k) || "").split(",").filter((x) => x && ok(x));
    f.pays = liste("pays", (x) => IFS.NOMS_PAYS[x]);
    f.region = S.regions[p.get("region")] ? p.get("region") : "";
    f.unite = R.unite[p.get("unite")] ? p.get("unite") : "";
    f.themes = liste("themes", (x) => R.theme[x]);
    f.orgs = liste("orgs", (x) => R.org[x]);
    f.bailleur = p.get("bailleur") || ""; f.partenaire = p.get("partenaire") || "";
    f.etat = ["en_cours", "termine"].includes(p.get("etat")) ? p.get("etat") : "";
    f.de = Number(p.get("de")) || null; f.a = Number(p.get("a")) || null;
    if (LIBELLES[p.get("indicateur")]) S.indicateur = p.get("indicateur");
    if (["clair", "osm", "satellite"].includes(p.get("fond"))) S.fond = p.get("fond");
    if (["regions", "unites"].includes(p.get("echelle"))) S.echelle = p.get("echelle");
    if (p.get("historique") === "1") S.couches.historique = true;
    const t = (p.get("territoire") || "").split(":");
    if (t.length === 2 && ((t[0] === "unite" && R.unite[t[1]]) || (t[0] === "region" && S.regions[t[1]]))) S.selection = { niveau: t[0], code: t[1] };
    if (p.get("projet") && S.projets.some((x) => x.id === p.get("projet"))) S.projetOuvert = p.get("projet");
  }

  // ================================================================ à propos
  function ouvrirAPropos() {
    const C = S.ref.contexte, M = S.ref.manifeste;
    const url = new URL(location.href); url.hash = ""; url.searchParams.set("embed", "1");
    const iframe = `<iframe src="${url.toString()}" width="100%" height="620" style="border:0" title="Carte des actions de l'Initiative Fleuve Sénégal" loading="lazy"></iframe>`;
    $("#apropos-corps").innerHTML = `
      <p class="encadre">${E(C.avertissement)}</p>
      <h3>L'Initiative Fleuve Sénégal</h3><p>${E(C.ifs)}</p>
      <h3>Les membres</h3><p>${S.ref.organisations.map((o) => E(o.nom)).join(", ")}.</p>
      <h3>Le bassin du fleuve Sénégal</h3><p>${E(C.bassin)}</p>
      <p>Cette version couvre ${N(M.nb_unites)} ${M.mode === "regions" ? "régions" : "unités de niveau 2"} dans ${N(M.nb_regions)} régions de ${N(M.nb_pays)} pays. Le périmètre est indicatif : il sera remplacé par la liste validée par l'IFS.</p>
      <h3>Comment les chiffres sont calculés</h3><ul>${C.methode.map((m) => `<li>${E(m)}</li>`).join("")}</ul>
      <h3>Intégrer la carte sur un autre site</h3>
      <p>Copiez ce code dans une page de Sahelink ou du site d'un membre. Les filtres ajoutés à l'adresse sont conservés.</p>
      <pre class="code">${E(iframe)}</pre>
      <button class="bouton" type="button" id="copier-iframe">Copier le code d'intégration</button>
      <h3>Sources et licences</h3>
      <ul>
        <li>Limites administratives : ${E(M.source_limites)}. Frontières des pays, cours d'eau et localités : Natural Earth (domaine public).</li>
        <li>Fonds de carte : Esri (plan clair et image satellite), contributeurs OpenStreetMap.</li>
        <li>Bibliothèques : Leaflet, Chart.js, Papa Parse, SheetJS. Police : Atkinson Hyperlegible (Braille Institute).</li>
        <li>Données mises à jour le ${E(M.genere_le)}.</li>
      </ul>
      <h3>Cette maquette</h3><p>${E(C.auteur)}</p>`;
    $("#copier-iframe").addEventListener("click", (e) => {
      if (navigator.clipboard) navigator.clipboard.writeText(iframe).then(() => (e.target.textContent = "Code copié"));
    });
    $("#apropos").showModal();
  }

  document.addEventListener("DOMContentLoaded", demarrer);
})();
