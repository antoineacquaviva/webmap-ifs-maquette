/* Maquette webmap IFS — démonstration de mise à jour sans compétence technique */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const E = IFS.echapper, N = IFS.formatNombre;
  const OBLIGATOIRES = ["id_projet", "intitule", "organisation", "unites_admin2", "annee_debut", "annee_fin"];
  const COMPARES = ["intitule", "organisation", "thematiques", "odd", "annee_debut", "annee_fin", "etat", "resume",
    "unites_admin2", "partenaires", "bailleurs", "budget_eur", "beneficiaires"];
  let ref = null, actuels = new Map(), resultat = null, nomFichier = "";

  async function demarrer() {
    try {
      ref = await IFS.chargerReferentiels("data/");
      const imp = IFS.importLocal();
      const rangs = imp && Array.isArray(imp.rangs) ? imp.rangs : await IFS.lireCSV("data/projets.csv");
      rangs.forEach((r) => actuels.set(String(r.id_projet || "").trim(), r));
      if (imp) message("#message-publication", "ok", `Un import du ${E(imp.date)} (« ${E(imp.fichier)} ») est actuellement affiché sur la carte, dans ce navigateur.`);
    } catch (err) {
      message("#message-lecture", "erreur", `Les référentiels n'ont pas pu être chargés (${E(err.message)}). Consultez la version publiée du site.`);
      return;
    }
    const depot = $("#depot");
    ["dragenter", "dragover"].forEach((t) => depot.addEventListener(t, (e) => { e.preventDefault(); depot.classList.add("survol"); }));
    ["dragleave", "drop"].forEach((t) => depot.addEventListener(t, (e) => { e.preventDefault(); depot.classList.remove("survol"); }));
    depot.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) lireFichier(e.dataTransfer.files[0]); });
    $("#fichier").addEventListener("change", (e) => { if (e.target.files[0]) lireFichier(e.target.files[0]); });
    $("#essayer-exemple").addEventListener("click", async () => {
      const rangs = await IFS.lireCSV("data/exemple_export_kobo.csv");
      traiter(rangs, "exemple_export_kobo.csv");
    });
    $("#publier").addEventListener("click", publier);
    $("#annuler-publication").addEventListener("click", () => {
      IFS.effacerImport();
      message("#message-publication", "ok", `La carte affiche de nouveau les données de démonstration. <a href="index.html">Voir la carte</a>`);
    });
  }

  function message(cible, type, html) {
    $(cible).innerHTML = html ? `<div class="message ${type}">${html}</div>` : "";
  }

  function lireFichier(fichier) {
    const ext = fichier.name.split(".").pop().toLowerCase();
    const lecteur = new FileReader();
    lecteur.onerror = () => message("#message-lecture", "erreur", "Le fichier n'a pas pu être lu. Réessayez, ou exportez-le de nouveau depuis Kobo.");
    if (ext === "csv") {
      lecteur.onload = () => traiter(IFS.lireCSVTexte(lecteur.result), fichier.name);
      lecteur.readAsText(fichier, "utf-8");
    } else if (ext === "xlsx" || ext === "xls") {
      lecteur.onload = () => {
        try {
          const classeur = XLSX.read(new Uint8Array(lecteur.result), { type: "array" });
          const feuille = classeur.Sheets[classeur.SheetNames[0]];
          traiter(XLSX.utils.sheet_to_json(feuille, { defval: "", raw: false }), fichier.name);
        } catch (e) {
          message("#message-lecture", "erreur", "Ce fichier Excel n'a pas pu être lu. Vérifiez qu'il s'agit bien d'un export Kobo.");
        }
      };
      lecteur.readAsArrayBuffer(fichier);
    } else {
      message("#message-lecture", "erreur", `Format non reconnu (.${E(ext)}). Déposez un fichier .xlsx ou .csv exporté de Kobo.`);
    }
  }

  function traiter(rangs, nom) {
    nomFichier = nom;
    if (!rangs.length) return message("#message-lecture", "erreur", "Le fichier est vide.");
    const colonnes = Object.keys(rangs[0]);
    const manquantes = OBLIGATOIRES.filter((c) => !colonnes.includes(c));
    if (manquantes.length) {
      return message("#message-lecture", "erreur", `Il manque des colonnes attendues : ${manquantes.map((c) => `<b>${E(c)}</b>`).join(", ")}.
        Vérifiez que l'export utilise les noms de colonnes « XML » de Kobo, ou partez du modèle de fichier.`);
    }
    message("#message-lecture", "ok", `Fichier « ${E(nom)} » lu : ${N(rangs.length)} lignes.`);
    resultat = IFS.controler(rangs, ref);
    resultat.nbLignes = rangs.length;
    afficherRapport();
    $("#etape-2").classList.remove("inactive");
    $("#etape-3").classList.remove("inactive");
    $("#publier").disabled = !resultat.projets.length;
    message("#message-publication", "", "");
    $("#etape-2").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function comparer() {
    const vus = new Set();
    let nouveaux = 0, modifies = 0, inchanges = 0;
    const norm = (v) => String(v ?? "").trim();
    for (const p of resultat.projets) {
      vus.add(p.id);
      const avant = actuels.get(p.id);
      if (!avant) nouveaux++;
      else if (COMPARES.some((c) => norm(avant[c]) !== norm(p.brut[c]))) modifies++;
      else inchanges++;
    }
    const idsFichier = new Set(resultat.lignes.map((l) => l.id));
    const retires = [...actuels.keys()].filter((id) => id && !idsFichier.has(id)).length;
    return { nouveaux, modifies, inchanges, retires };
  }

  function afficherRapport() {
    const l = resultat.lignes;
    const valides = l.filter((x) => x.statut === "valide").length;
    const avert = l.filter((x) => x.statut === "avertissement").length;
    const rejet = l.filter((x) => x.statut === "rejetee").length;
    const d = comparer();
    const anomalies = [...resultat.anomalies].sort((a, b) => (a.gravite === b.gravite ? a.ligne - b.ligne : a.gravite === "bloquant" ? -1 : 1));
    $("#rapport").innerHTML = `
      <div class="bilan">
        <div><b>${N(resultat.nbLignes)}</b><span>lignes lues</span></div>
        <div class="ok"><b>${N(valides)}</b><span>lignes valides</span></div>
        <div class="attention"><b>${N(avert)}</b><span>publiées avec un avertissement</span></div>
        <div class="alerte"><b>${N(rejet)}</b><span>bloquées, non publiées</span></div>
      </div>
      <p class="aide">Par rapport aux données actuellement en ligne :</p>
      <div class="changements">
        <span class="etiquette">${N(d.nouveaux)} nouveau${d.nouveaux > 1 ? "x" : ""} projet${d.nouveaux > 1 ? "s" : ""}</span>
        <span class="etiquette">${N(d.modifies)} projet${d.modifies > 1 ? "s" : ""} modifié${d.modifies > 1 ? "s" : ""}</span>
        <span class="etiquette">${N(d.inchanges)} inchangé${d.inchanges > 1 ? "s" : ""}</span>
        <span class="etiquette">${N(d.retires)} absent${d.retires > 1 ? "s" : ""} du fichier</span>
      </div>
      ${anomalies.length ? `
      <div class="tableau-defile">
        <table class="anomalies">
          <thead><tr><th scope="col">Ligne</th><th scope="col">Projet</th><th scope="col">Problème</th><th scope="col">Que faire ?</th></tr></thead>
          <tbody>${anomalies.map((a) => `
            <tr>
              <td>${a.ligne}</td>
              <td><b>${E(a.id)}</b><br><span class="aide">${E(a.intitule || "")}</span></td>
              <td><span class="gravite ${a.gravite}">${a.gravite === "bloquant" ? "Bloquant" : "Avertissement"}</span><br>${E(a.message)}</td>
              <td>${E(a.suggestion) || "–"}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>` : `<div class="message ok">Aucune anomalie : toutes les lignes peuvent être publiées.</div>`}`;
  }

  function publier() {
    if (!resultat) return;
    const d = comparer();
    const ok = IFS.enregistrerImport({
      date: new Date().toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" }),
      fichier: nomFichier,
      rangs: resultat.projets.map((p) => p.brut),
    });
    if (!ok) return message("#message-publication", "erreur", "La publication de démonstration a échoué : le stockage du navigateur est peut-être désactivé.");
    resultat.projets.forEach((p) => actuels.set(p.id, p.brut));
    message("#message-publication", "ok", `Publié : ${N(resultat.projets.length)} projets sont maintenant sur la carte (${N(d.nouveaux)} nouveaux, ${N(d.modifies)} modifiés), dans ce navigateur.
      <a href="index.html">Voir la carte mise à jour</a>`);
  }

  document.addEventListener("DOMContentLoaded", demarrer);
})();
