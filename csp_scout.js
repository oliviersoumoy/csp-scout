const { chromium } = require("playwright");

// === CONFIG ===
const WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbySgCcg7KY1dcSlt8o_qGiaEjB84LzCU3oyWPFMQzukqK3AR8uLGfvhGKoA0ku2FmpP/exec";
const EMAIL_TO = "olivier.soumoy@gmail.com";

// tes URLs CSP (liste)
const LIST_URLS = [
  "https://choisirleservicepublic.gouv.fr/nos-offres/filtres/mot-cles/num%C3%A9rique/localisation/283-284/domaine/3505-3506-3507-3512-3513-3514-3522-3530-3531/categorie/4327-4328-1805/"
];

const MAX_OFFERS_PER_LIST = 20; // ajuste
const HEADLESS = true;          // mets false si tu veux voir le navigateur

// === SCORING ===
// important: les valeurs négatives sont OK. Elles pénalisent sans "exclure".
const THEME_WEIGHTS = [
  { k: "numérique", w: 300 },
  { k: "santé", w: 200 },
  { k: "transport", w: 150 },
  { k: "mobilité", w: 150 },
  { k: "écologie", w: 100 },
  { k: "agriculture", w: 80 },
  { k: "éducation", w: 100 },
  { k: "formation", w: 50 },

  { k: "ressources humaines", w: -500 },
  { k: "affaires juridiques", w: -500 },
  { k: "animation, jeunesse et sports", w: -500 },
  { k: "gestion budgétaire", w: -300 },
  { k: "médical et paramédical", w: -200 },
];

function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function frDateToDMY(s) {
  if (!s) return "";
  const m = s.match(/(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+(\d{4})/i);
  if (!m) return "";

  const day = m[1].padStart(2, "0");
  const year = m[3];

  const months = {
    janvier: "01", février: "02", mars: "03", avril: "04", mai: "05", juin: "06",
    juillet: "07", août: "08", septembre: "09", octobre: "10", novembre: "11", décembre: "12"
  };

  const month = months[m[2].toLowerCase()];
  return `${day}/${month}/${year}`;
}


function cleanTheme(s) {
  if (!s) return "";
  // retire "Postuler..." et tout ce qui suit
  const stops = [
    "Postuler", "Postuler sur le site employeur", "Postuler par mail",
    "Télécharger PDF", "Ajouter aux favoris", "Partager", "-->"
  ];
  let out = s;
  for (const st of stops) {
    const i = out.toLowerCase().indexOf(st.toLowerCase());
    if (i >= 0) out = out.slice(0, i);
  }
  return norm(out);
}

function normalizeCategory(v) {
  if (!v) return "";
  const s = String(v);
  const m = s.match(/A\+|A\b|B\b|C\b/i);
  if (!m) return norm(s);
  return m[0].toUpperCase();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function themeScoreAndWhy(theme) {
  const t = (theme || "").toLowerCase();
  for (const tw of THEME_WEIGHTS) {
    if (t.includes(tw.k.toLowerCase())) {
      return { w: tw.w, why: `Thème: ${theme} (${tw.w})` };
    }
  }
  return { w: 0, why: theme ? `Thème: ${theme} (0)` : "" };
}

function scoreOffer(o) {
  let score = 0;
  const why = [];

  // Catégorie
  if (o.Category === "A+") { score += 120; why.push("Catégorie A+ (+120)"); }
  else if (o.Category === "A") { score += 0;  }
  else if (o.Category) { score += 0;  }

  // Management
  if ((o.Management || "").toLowerCase() === "oui") { score += 150; why.push("Management (+150)"); }

  // Expérience
  const exp = (o.Experience || "").toLowerCase();
  if (exp.includes("expert")) { score += 10; why.push("Expérience: expert (+10)"); }
  if (exp.includes("confirm")) { score += 80; why.push("Expérience: confirmé (+80)"); }

  // Thème
  const ts = themeScoreAndWhy(o.Theme);
  score += ts.w;
  if (ts.why) why.push(ts.why);

  // Titre: direction / programme / produit
  const title = (o.Title || "").toLowerCase();
  if (title.includes("directeur") || title.includes("directrice") || title.includes("direction")) {
    score += 80; why.push("Titre: direction (+80)");
  }
  if (title.includes("programme")) { score += 300; why.push("Titre: programme (+300)"); }
  if (title.includes("produit") || title.includes("product")) { score += 180; why.push("Titre: produit (+180)"); }
  if (title.includes("projet")) { score += 20; why.push("Titre: projet (+20)"); }
  if (title.includes("adjoint")) { score += 400; why.push("Titre: adjoint (+400)"); }

  return { Score: score, Why: why.join(" | ") };
}


async function extractOfferImage_(page) {
  // 1) OG / Twitter meta
  const metaUrl = await page.evaluate(() => {
    const pick = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
    return (
      pick('meta[property="og:image"]') ||
      pick('meta[name="twitter:image"]') ||
      pick('meta[property="og:image:secure_url"]') ||
      ""
    );
  }).catch(() => "");

  if (metaUrl && metaUrl.startsWith("http")) return metaUrl;

  // 2) JSON-LD (schema.org)
  const jsonLdUrl = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const n of nodes) {
      try {
        const j = JSON.parse(n.textContent || "{}");
        const arr = Array.isArray(j) ? j : [j];
        for (const it of arr) {
          const img = it?.image;
          if (typeof img === "string" && img.startsWith("http")) return img;
          if (Array.isArray(img) && img[0]?.startsWith?.("http")) return img[0];
          if (img?.url?.startsWith?.("http")) return img.url;
        }
      } catch (_) {}
    }
    return "";
  }).catch(() => "");

  if (jsonLdUrl) return jsonLdUrl;

  // 3) Fallback: première image dans le contenu (en évitant header)
  const fallback = await page.locator("main img").first().evaluate(el => el.src).catch(() => "");
  return fallback || "";
}


// Fonction récupère texte alt des images
// [CORRECTION] Récupère l'URL absolue pour que Google Sheets puisse l'afficher
async function extractLogo_(page) {
    const candidates = [
        'header img[alt]',
        'main img[alt]',
        'img[alt*="Minist" i]',
        'img[alt*="Agence" i]',
        'img[src*="logo" i]',
    ];
    for (const sel of candidates) {
        const img = page.locator(sel).first();
        if ((await img.count()) === 0) continue;
        
        // On utilise evaluate pour obtenir la propriété 'src' complète (http...)
        // et non l'attribut (qui peut être relatif genre /assets/logo.png)
        const src = await img.evaluate(el => el.src).catch(() => "");
        const alt = (await img.getAttribute("alt")) || "";
        
        if (src) return { logoAlt: alt.trim(), logoSrc: src };
    }
    return { logoAlt: "", logoSrc: "" };
}


//fonction logo
async function extractOfferImageBeforeRecommended_(page) {
  // 1) Essaye de prendre la dernière image wp-content/uploads avant le titre "recommandées"
  const loc = page.locator(
    'xpath=(//*[contains(normalize-space(), "Des offres d\'emplois recommandées pour vous")]/preceding::img[contains(@src,"/wp-content/uploads/") or contains(@data-src,"/wp-content/uploads/")])[last()]'
  ).first();

  if (await loc.count() > 0) {
    const src = await loc.evaluate(el => el.currentSrc || el.src || el.getAttribute("data-src") || "").catch(() => "");
    if (src && src.length > 20) return src;
  }

  // 2) Fallback : ta fonction existante (logo page détail)
  const { logoSrc } = await extractLogo_(page);
  if (logoSrc && logoSrc.length > 20) return logoSrc;


  return "";
}

async function extractEmployerLogoUrl_(page) {
  // 1) Sélecteurs très probables sur la page détail
  const selectors = [
    '.offer-header__logo img',
    '.structure-logo img',
    '.offer-header img',
    'header img',
    'main img'
  ];

  for (const sel of selectors) {
    const img = page.locator(sel).first();
    if (await img.count() === 0) continue;

    const src = await img.evaluate(el => el.currentSrc || el.src || el.getAttribute("data-src") || "").catch(() => "");
    if (src && src.startsWith("https://choisirleservicepublic.gouv.fr/wp-content/uploads/")) {
      return src;
    }
  }

  // 2) Fallback: prendre la 1ère image uploads de la page (mais en évitant les pictos)
  const fallback = page.locator('img').filter({ hasNotText: '' }); // noop, juste pour garder locator
  const img2 = page.locator('img[src*="/wp-content/uploads/"], img[data-src*="/wp-content/uploads/"]').first();
  if (await img2.count() > 0) {
    const src2 = await img2.evaluate(el => el.currentSrc || el.src || el.getAttribute("data-src") || "").catch(() => "");
    if (src2 && src2.startsWith("https://choisirleservicepublic.gouv.fr/wp-content/uploads/")) return src2;
  }

  return "";
}



// Extraction robuste "Label : Value" (regex) + fallback lignes
async function extractDetail(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
const employerLogoUrl = await extractEmployerLogoUrl_(page);


const offerImageUrl = await extractOfferImage_(page);

  const { logoAlt, logoSrc } = await extractLogo_(page);

  const title = norm(await page.locator("h1").first().innerText().catch(() => ""));

  // 1) récupère le texte principal (main ou body)
  let mainText = await page.locator("main").innerText().catch(() => "");
  if (!mainText) {
    mainText = await page.locator("body").innerText().catch(() => "");
  }

  // 2) calcule la date de publication depuis la page détail (si présente)
  let postedDetail = "";
  const mPosted = String(mainText).match(/En ligne depuis le\s+([^\n]+)/i);
  if (mPosted) postedDetail = frDateToDMY(mPosted[1].trim());

  const lines = String(mainText)
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  // ... puis tu gardes le reste de ta fonction inchangé (getKV, employer, etc.)

const remunerationContractuels = extractRemunerationContractuels(lines);


  function getKV(label, fallbacks = []) {
    const candidates = [label, ...fallbacks].filter(Boolean);

    // 1) Regex multiline "Label : Value"
    for (const lab of candidates) {
      const re = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(lab)}\\s*:\\s*([^\\n]+)`, "i");
      const m = String(mainText).match(re);
      if (m && m[1]) return m[1].trim();
    }

    // 2) Line-based
    const labelsLC = candidates.map(x => x.toLowerCase());
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i].toLowerCase();

      // "Label: Value" sur une ligne (espaces variables)
      for (const lab of labelsLC) {
        if (L.startsWith(lab) && lines[i].includes(":")) {
          const v = lines[i].split(":").slice(1).join(":").trim();
          if (v) return v;
        }
      }

      // "Label" seul puis valeur sur la ligne suivante
      if (labelsLC.includes(L)) {
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const v = lines[j];
          // stop si on retombe sur un label
          if (!labelsLC.includes(v.toLowerCase())) return v.trim();
        }
      }
    }
    return "";
  }

  const employer = norm(getKV("Employeur"));
  const location = norm(getKV("Localisation", ["Lieu"]));

  const domainRaw = getKV("Domaine", ["Thème"]);
  const theme = cleanTheme(domainRaw);

  const categoryRaw = getKV("Catégorie");
  const category = normalizeCategory(categoryRaw);

  const management = norm(getKV("Management"));
  const experience = norm(getKV("Expérience souhaitée", ["Experience souhaitée", "Expérience demandée"]));
  const deadline = norm(getKV("Date limite de candidature", ["Date limite", "Date limite :"]));

  // PostedDate: souvent pas sur la page détail -> on le gèrera depuis la liste plus tard si besoin
  return {
    Title: title || "(titre non détecté)",
    Employer: employer,
    Location: location,
    Theme: theme,
    Category: category,
    Management: management,
    Experience: experience,
    Deadline: deadline,
    URL: url,
 OfferImageURL: offerImageUrl,
EmployerLogoURL: employerLogoUrl,
RemunerationContractuels: remunerationContractuels,

    PostedDateDetail: postedDetail,
    // texte brut si tu veux (optionnel)
  };
}

function extractRemunerationContractuels(lines) {
  const norm = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const startNeedle = "fourchette indicative pour les contractuels";
  const endNeedle = "fourchette indicative pour les fonctionnaires";

  const startIdx = lines.findIndex((l) => norm(l) === startNeedle);
  if (startIdx < 0) return "";

  const endIdx = lines.findIndex((l, idx) => idx > startIdx && norm(l) === endNeedle);

  // si pas de borne de fin, on prend une fenêtre raisonnable
  const sliceEnd = (endIdx > -1) ? endIdx : Math.min(startIdx + 8, lines.length);

  // contenu entre les 2 titres
  const chunk = lines
    .slice(startIdx + 1, sliceEnd)
    .map(s => String(s || "").trim())
    .filter(Boolean);

  // on enlève les doublons évidents et libellés parasites
  const cleaned = chunk.filter(l => {
    const n = norm(l);
    if (n === startNeedle || n === endNeedle) return false;
    if (n === "rémunération") return false;
    return true;
  });

  return cleaned.join(" ");
}




function withPageInPath_(baseUrl, pageNum) {
  let u = baseUrl.replace(/\/page\/\d+\/?/gi, "/");
  if (!u.endsWith("/")) u += "/";
  return u + "page/" + pageNum + "/";
}


async function extractListLinks(page, listUrl) {
  const results = [];
  const seen = new Set();

  const MAX_PAGES = 50; // sécurité
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const url = (pageNum === 1) ? listUrl : withPageInPath_(listUrl, pageNum);

const offerImageUrl = await extractOfferImageBeforeRecommended_(page);

await page.goto(url, { waitUntil: "domcontentloaded" });

const html = await page.locator('a[href*="/offre-emploi/"]').first().evaluate(a => a.closest("article, li, div")?.outerHTML || "");
console.log(html.slice(0, 1500));


await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(800);


    const pageItems = await page.$$eval('a[href*="/offre-emploi/"]', (as) => {
      const out = [];
      const uniq = new Set();

      const pickFromImg = (img) => {
        // Le plus fiable pour responsive/lazy : currentSrc
        const cur = (img.currentSrc || "").trim();
        if (cur) return cur;

        // Attributs lazy-load courants
        const raw =
          (img.getAttribute("data-src") || "").trim() ||
          (img.getAttribute("data-lazy-src") || "").trim() ||
          (img.getAttribute("data-original") || "").trim() ||
          (img.getAttribute("src") || "").trim();

        if (raw) return raw;

        // srcset (1ère URL)
        const srcset = (img.getAttribute("srcset") || "").trim();
        if (srcset) {
          const first = srcset.split(",")[0].trim().split(" ")[0];
          if (first) return first;
        }
        return "";
      };

      const pickBackgroundUrl = (root) => {
        const el = root.querySelector('[style*="background-image"]');
        if (!el) return "";
        const style = el.getAttribute("style") || "";
        const m = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
        return m ? (m[1] || "") : "";
      };

      as.forEach((a) => {
        const href = (a.href || "").split("#")[0];
        if (!href) return;
        if (uniq.has(href)) return;
        uniq.add(href);

        const card = a.closest("article, li, div");

        let posted = "";
        let imgUrl = "";

        if (card) {
 // Date "En ligne depuis le ..." : on cible le bon <li> de la card
const liDate =
  card.querySelector("li.fr-icon-calendar-line") ||
  Array.from(card.querySelectorAll("li")).find(li => (li.textContent || "").includes("En ligne depuis le"));

if (liDate) {
  const t = (liDate.textContent || "").replace(/\s+/g, " ").trim();
  const m = t.match(/En ligne depuis le\s+(.+)$/i);
  if (m) posted = m[1].trim();
}


          // 1) Images <img> dans la card
          const imgs = Array.from(card.querySelectorAll("img"));

          const candidates = imgs
            .map(pickFromImg)
            .filter((src) =>
              src &&
              src.includes("/wp-content/uploads/") &&
              !/marianne|republique|choisir/i.test(src)
            );

          imgUrl = candidates[0] || "";

          // 2) Fallback : 1ère image wp-content/uploads (sans filtre)
          if (!imgUrl) {
            imgUrl =
              imgs
                .map(pickFromImg)
                .find((src) => src && src.includes("/wp-content/uploads/")) || "";
          }

          // 3) Fallback : background-image
          if (!imgUrl) {
            const bg = pickBackgroundUrl(card);
            if (bg) imgUrl = bg;
          }
        }

        out.push({ url: href, posted, imgUrl });
      });

      return out;
    });

    // Si cette page ne contient aucune offre, on stop la pagination
    if (!pageItems || pageItems.length === 0) break;

    // Normaliser imgUrl en absolu (hors $$eval, côté Node)
    for (const it of pageItems) {
      if (it.imgUrl && !it.imgUrl.startsWith("http")) {
        try {
          it.imgUrl = new URL(it.imgUrl, url).href; // base = la page courante (avec /page/N/)
        } catch (_) {
          // on garde tel quel
        }
      }

      if (!seen.has(it.url)) {
        seen.add(it.url);
        results.push(it);
      }

      if (results.length >= MAX_OFFERS_PER_LIST) break;
    }

    if (results.length >= MAX_OFFERS_PER_LIST) break;
  }

  return results.slice(0, MAX_OFFERS_PER_LIST);
}


async function pushToSheet(rows) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows, emailTo: EMAIL_TO, runCleanup: true })
  });
  const txt = await res.text();
  console.log("Webhook response:", txt);
}

async function run() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();
  
  // Tableau pour stocker toutes les offres de toutes les listes
  const allRows = [];

  for (const listUrl of LIST_URLS) {
    console.log(`\n--- Processing List: ${listUrl} ---`);
    const sourceName = `CSP`; // Ou tu peux mettre listUrl pour être plus précis

    // 1. Récupère les liens de la page de liste
    const items = await extractListLinks(page, listUrl);

console.log("DEBUG first item:", items[0]);           // doit montrer imgUrl
console.log("DEBUG first imgUrl:", items[0]?.imgUrl); // doit être non vide

for (const it of items) {
  if (it.imgUrl && !it.imgUrl.startsWith("http")) {
    it.imgUrl = new URL(it.imgUrl, listUrl).href;
  }
}

    console.log(`Found ${items.length} links.`);

    // 2. Pour chaque offre, va chercher le détail
    for (const it of items) {
      // Petite pause pour ne pas spammer brutalement
      // await page.waitForTimeout(700); 

const d = await extractDetail(page, it.url);

// 🔧 Normalisation URL image → chemin relatif uploads/
const UPLOADS_PREFIX = "https://choisirleservicepublic.gouv.fr/wp-content/uploads/";

if (d.EmployerLogoURL && d.EmployerLogoURL.startsWith(UPLOADS_PREFIX)) {
  d.EmployerLogoURL = d.EmployerLogoURL.slice(UPLOADS_PREFIX.length);
} else {
  d.EmployerLogoURL = "";
}

      
      // Conversion date
      const postedDate = frDateToDMY(it.posted);

      // SCORING
      const s = scoreOffer(d);

      // Préparation de la ligne pour Google Sheet
      // L'ordre des clés ici n'importe pas (c'est le Apps Script qui gère l'ordre des colonnes),
      // mais il faut bien envoyer toutes les données.
      
const deadlineDMY = frDateToDMY(d.Deadline) || d.Deadline || "";


allRows.push({
  "Score": 0,
  "URL de l'annonce": d.URL,
"Date de publication de l'annonce": postedDate || "",
  "Theme": d.Theme,
  "Organisation": d.Employer,
  "Titre annonce": d.Title,
  "Catégorie": d.Category,
"Rémunération": d.RemunerationContractuels || "",

  "Management": d.Management,
  "Lieu": d.Location,
  "Experience": d.Experience,
  "Date limite de candidature": deadlineDMY,
  "URL image": d.EmployerLogoURL || "",
  "Détail score": ""
  // FirstSeen/LastSeen laissés vides si Apps Script les remplit
});





      // Debug console compact pour suivre l'avancement
      console.log(`[${s.Score}] ${d.Employer} - ${d.Title}`);
    }
  }

  await browser.close();

  // === CORRECTION IMPORTANTE ===
  // Tri du tableau global par Score décroissant (du plus grand au plus petit)
  // Cela garantit que le JSON envoyé est déjà dans le bon ordre.
  allRows.sort((a, b) => b.Score - a.Score);

  console.log(`\nReady to send ${allRows.length} rows to Sheet...`);
  
  // Envoi vers Google Sheet
  await pushToSheet(allRows);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
