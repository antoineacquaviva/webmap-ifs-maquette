/* Maquette webmap IFS — module commun
   Lecture des référentiels et contrôle qualité des exports Kobo.
   Les mêmes règles servent à la carte et à la page de mise à jour. */
(function (global) {
  "use strict";

  const CLE_IMPORT = "ifs-maquette-import";
  const TYPES_UNITE = { SEN: "Département", MRT: "Moughataa", MLI: "Cercle", GIN: "Préfecture" };
  const NOMS_PAYS = { SEN: "Sénégal", MRT: "Mauritanie", MLI: "Mali", GIN: "Guinée" };

  async function lireTexte(url) {
    const rep = await fetch(url, { cache: "no-cache" });
    if (!rep.ok) throw new Error("Fichier introuvable : " + url);
    return rep.text();
  }
  async function lireJSON(url) { return JSON.parse(await lireTexte(url)); }
  function lireCSVTexte(texte) {
    const res = Papa.parse(texte.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy" });
    return res.data;
  }
  async function lireCSV(url) { return lireCSVTexte(await lireTexte(url)); }

  async function chargerReferentiels(base) {
    base = base || "data/";
    const [manifeste, thematiques, organisations, unites, contexte] = await Promise.all([
      lireJSON(base + "manifest.json"),
      lireCSV(base + "referentiels/thematiques.csv"),
      lireCSV(base + "referentiels/organisations.csv"),
      lireCSV(base + "referentiels/unites.csv"),
      lireJSON(base + "contexte.json"),
    ]);
    const ref = {
      manifeste, contexte,
      thematiques, organisations, unites,
      theme: Object.fromEntries(thematiques.map((t) => [t.code, t])),
      org: Object.fromEntries(organisations.map((o) => [o.code, o])),
      unite: Object.fromEntries(unites.map((u) => [u.code, u])),
    };
    return ref;
  }

  // ------------------------------------------------------------ outils texte
  function normaliser(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function distance(a, b) {
    a = normaliser(a); b = normaliser(b);
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prec = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cour = [i];
      for (let j = 1; j <= n; j++) {
        cour[j] = Math.min(prec[j] + 1, cour[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prec = cour;
    }
    return prec[n];
  }
  function plusProche(valeur, candidats, libelle) {
    let meilleur = null;
    for (const c of candidats) {
      const cles = [c.code, libelle ? c[libelle] : null].filter(Boolean);
      for (const k of cles) {
        const d = distance(valeur, k);
        if (!meilleur || d < meilleur.d) meilleur = { d, c };
      }
    }
    if (!meilleur) return null;
    const seuil = Math.max(2, Math.round(normaliser(valeur).length * 0.4));
    return meilleur.d <= seuil ? meilleur.c : null;
  }
  const liste = (v, sep) => String(v || "").split(sep).map((s) => s.trim()).filter(Boolean);
  function nombre(v) {
    if (v === null || v === undefined || String(v).trim() === "") return null;
    const s = String(v).replace(/\s/g, "").replace(",", ".");
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }
  function formatNombre(n) {
    if (n === null || n === undefined || isNaN(n)) return "–";
    return Math.round(n).toLocaleString("fr-FR");
  }
  function formatEuros(n) {
    if (!n) return "–";
    if (n >= 1e6) return (n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " M€";
    if (n >= 1e3) return Math.round(n / 1e3).toLocaleString("fr-FR") + " k€";
    return formatNombre(n) + " €";
  }
  function echapper(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ------------------------------------------------------------ contrôle qualité
  /* Renvoie { projets, anomalies, lignes } :
     - projets : projets valides, prêts pour la carte ;
     - anomalies : [{ ligne, id, champ, gravite: "bloquant"|"avertissement", message, suggestion }] ;
     - lignes : statut de chaque ligne ("valide" | "avertissement" | "rejetee"). */
  function controler(rangs, ref) {
    const anomalies = [];
    const projets = [];
    const lignes = [];
    const vus = new Map();
    const orgs = ref.organisations;
    const themes = ref.thematiques;
    const unitesListe = ref.unites;

    rangs.forEach((r, i) => {
      const num = i + 2; // ligne 1 = en-têtes
      const id = String(r.id_projet || "").trim();
      const intitule = String(r.intitule || "").trim();
      const pb = [];
      const ajouter = (champ, gravite, message, suggestion) => pb.push({ ligne: num, id: id || "(sans identifiant)", intitule, champ, gravite, message, suggestion: suggestion || "" });

      if (!id) ajouter("id_projet", "bloquant", "Identifiant manquant.", "Chaque projet doit avoir un identifiant unique.");
      else if (vus.has(id)) ajouter("id_projet", "bloquant", `Identifiant déjà utilisé à la ligne ${vus.get(id)}.`, "Corriger l'identifiant dans Kobo, ou supprimer le doublon.");
      else vus.set(id, num);
      if (!intitule) ajouter("intitule", "bloquant", "Intitulé manquant.", "");

      const org = String(r.organisation || "").trim();
      if (!ref.org[org]) {
        const s = plusProche(org, orgs, "nom");
        ajouter("organisation", "bloquant", `Organisation inconnue : « ${org || "vide"} ».`, s ? `Vouliez-vous dire « ${s.nom} » (${s.code}) ?` : "Choisir une organisation de la liste des membres.");
      }

      const codes = liste(r.unites_admin2, /[\s;,]+/);
      const connues = codes.filter((c) => ref.unite[c]);
      const inconnues = codes.filter((c) => !ref.unite[c]);
      if (!codes.length) ajouter("unites_admin2", "bloquant", "Aucune unité administrative renseignée.", "Sélectionner au moins une unité dans le formulaire.");
      inconnues.forEach((c) => {
        const s = plusProche(c, unitesListe, "nom");
        ajouter("unites_admin2", connues.length ? "avertissement" : "bloquant",
          `Unité inconnue du référentiel : « ${c} »${connues.length ? " (ignorée)" : ""}.`,
          s ? `Code proche : ${s.code} (${s.nom}).` : "Vérifier le code dans la liste des unités administratives.");
      });

      const debut = nombre(r.annee_debut), fin = nombre(r.annee_fin);
      const anneeOk = (a) => a !== null && !isNaN(a) && a >= 2000 && a <= 2035;
      if (!anneeOk(debut)) ajouter("annee_debut", "bloquant", `Année de début invalide : « ${r.annee_debut || "vide"} ».`, "Saisir une année sur 4 chiffres.");
      if (!anneeOk(fin)) ajouter("annee_fin", "bloquant", `Année de fin invalide : « ${r.annee_fin || "vide"} ».`, "Saisir une année sur 4 chiffres.");
      if (anneeOk(debut) && anneeOk(fin) && fin < debut)
        ajouter("annee_fin", "bloquant", `L'année de fin (${fin}) précède l'année de début (${debut}).`, "Les deux années sont probablement inversées.");

      const th = liste(r.thematiques, /[\s;,]+/);
      const thOk = th.filter((t) => ref.theme[t]);
      th.filter((t) => !ref.theme[t]).forEach((t) => {
        const s = plusProche(t, themes, "libelle");
        ajouter("thematiques", "avertissement", `Thématique inconnue : « ${t} » (ignorée).`, s ? `Thématique proche : ${s.libelle}.` : "Ajouter cette thématique au référentiel, ou choisir une thématique existante.");
      });
      if (!thOk.length && th.length) ajouter("thematiques", "avertissement", "Aucune thématique reconnue.", "");

      const benef = nombre(r.beneficiaires);
      if (benef !== null && isNaN(benef)) {
        const chiffres = String(r.beneficiaires).replace(/[^\d]/g, "");
        ajouter("beneficiaires", "avertissement", `Nombre de bénéficiaires non numérique : « ${r.beneficiaires} » (ignoré).`, chiffres ? `Saisir uniquement le nombre, par exemple ${Number(chiffres).toLocaleString("fr-FR")}.` : "Saisir uniquement un nombre.");
      }
      const budget = nombre(r.budget_eur);
      if (budget !== null && isNaN(budget)) ajouter("budget_eur", "avertissement", `Budget non numérique : « ${r.budget_eur} » (ignoré).`, "Saisir un montant en euros, sans texte.");

      let etat = String(r.etat || "").trim();
      if (etat && !["en_cours", "termine"].includes(etat)) {
        ajouter("etat", "avertissement", `État inconnu : « ${etat} ».`, "Valeurs attendues : en_cours ou termine. L'état est déduit des années.");
        etat = "";
      }
      if (!etat && anneeOk(fin)) etat = fin >= 2026 ? "en_cours" : "termine";

      anomalies.push(...pb);
      const rejetee = pb.some((p) => p.gravite === "bloquant");
      lignes.push({ ligne: num, id, statut: rejetee ? "rejetee" : pb.length ? "avertissement" : "valide" });
      if (rejetee) return;
      projets.push({
        id, intitule,
        organisation: org,
        thematiques: thOk,
        odd: liste(r.odd, /[\s;,]+/).map(Number).filter((n) => n >= 1 && n <= 17),
        debut, fin, etat,
        resume: String(r.resume || "").trim(),
        unites: connues,
        partenaires: liste(r.partenaires, /;/),
        bailleurs: liste(r.bailleurs, /;/),
        budget: budget !== null && !isNaN(budget) ? budget : null,
        beneficiaires: benef !== null && !isNaN(benef) ? benef : null,
        brut: r,
      });
    });
    return { projets, anomalies, lignes };
  }

  function importLocal() {
    try {
      const v = localStorage.getItem(CLE_IMPORT);
      return v ? JSON.parse(v) : null;
    } catch (e) { return null; }
  }
  function enregistrerImport(obj) {
    try { localStorage.setItem(CLE_IMPORT, JSON.stringify(obj)); return true; } catch (e) { return false; }
  }
  function effacerImport() {
    try { localStorage.removeItem(CLE_IMPORT); } catch (e) { /* rien */ }
  }

  global.IFS = {
    TYPES_UNITE, NOMS_PAYS, chargerReferentiels, lireCSV, lireCSVTexte, lireJSON, controler,
    normaliser, formatNombre, formatEuros, echapper, importLocal, enregistrerImport, effacerImport,
  };
})(window);
