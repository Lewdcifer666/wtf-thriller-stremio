import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTitle, resolveItem } from "./cinemeta.mjs";
import { identityKey } from "./identity.mjs";
import { makePolicy, scoreItem } from "./dna-score.mjs";
import { readPersonalizedScores } from "./personalized-scores.mjs";
import { sortItems } from "./sort.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "site");
const dataDir = path.join(root, "data");
const library = JSON.parse(fs.readFileSync(path.join(dataDir, "library.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root, "config", "catalogs.json"), "utf8"));
const taste = JSON.parse(fs.readFileSync(path.join(dataDir, "taste-profile.json"), "utf8"));

// Content DNA policy comes from taste-profile.json; the per-row weights come
// from config/catalogs.json; this file owns neither. A schema-2 profile simply
// has no DNA sections, so the DNA rows produce nothing and everything else
// builds exactly as before.
const dnaPolicy = taste.dna_dimensions ? makePolicy(taste) : null;

// Optional, absent until F2-9 generates it. Absence is the normal state and is
// not a warning; any invalid file is ignored in favour of stable baseline
// scores, and the build never fails because of it.
const personalizedFile = path.join(dataDir, "personalized-scores.json");
const personalized = readPersonalizedScores(fs, personalizedFile);
if (personalized.status !== "absent") {
  console.log(`personalized-scores.json: ${personalized.status}` +
    (personalized.status === "applied"
      ? ` (${personalized.items.size} items, ${personalized.rejectedItems} rejected)`
      : " - falling back to stable baseline DNA scores"));
}

// Per-(def, item) DNA score cache, keyed by def id. Computed once, reused by
// matches() and sortItems() so a row can never filter on one number and sort
// on another.
const dnaScores = new Map();
function dnaScoreFor(def, item) {
  let byItem = dnaScores.get(def.id);
  if (!byItem) { byItem = new Map(); dnaScores.set(def.id, byItem); }
  const key = item.imdb_id || `${item.type}:${normalizeTitle(item.title)}:${item.year}`;
  if (!byItem.has(key)) {
    byItem.set(key, dnaPolicy ? scoreItem(dnaPolicy, def, item, personalized.items).score : null);
  }
  return byItem.get(key);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const now = Date.now();
const H24 = 24 * 60 * 60 * 1000;

function loadDiscoveryItems() {
  const dir = path.join(dataDir, "discoveries");
  if (!fs.existsSync(dir)) return [];

  const items = [];
  const files = fs.readdirSync(dir)
    .filter(name => name.toLowerCase().endsWith(".json"))
    .sort();

  for (const name of files) {
    const file = path.join(dir, name);
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    const discovered = Array.isArray(payload) ? payload : (payload.items || []);
    if (!Array.isArray(discovered)) throw new Error(`${name}: expected an items array`);
    for (const item of discovered) items.push(item);
  }

  return items;
}

// Fail closed on a duplicate public identity.
//
// This used to merge the two records with { ...old, ...item }, which let a
// later record silently overwrite an earlier one - including its Content DNA -
// so two copies of the same title could disagree and whichever was parsed last
// would win invisibly. validate.mjs rejects duplicates outright; the builder
// must not paper over one that reaches it anyway.
function dedupeSourceItems(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = identityKey(item, normalizeTitle);
    const seen = byKey.get(key);
    if (seen) {
      throw new Error(
        `duplicate public identity ${key} ("${seen.title}" and "${item.title}") - an identity may ` +
        `appear only once across data/library.json and data/discoveries/*.json. ` +
        `Run: node scripts/validate.mjs`);
    }
    byKey.set(key, item);
  }
  return [...byKey.values()];
}

const discoveryItems = loadDiscoveryItems();
const sourceItems = dedupeSourceItems([...(library.items || []), ...discoveryItems]);
const watch = [];

for (const original of sourceItems.filter(x => x.status === "watch")) {
  let item = original;
  try {
    if (!item.imdb_id) item = await resolveItem(item);
  } catch (error) {
    console.warn(`Skipping unresolved item: ${error.message}`);
    continue;
  }
  watch.push(item);
}

function matches(def, item) {
  if (def.filter === "watch") return true;
  if (def.filter === "past24") {
    const t = Date.parse(item.added_at || "");
    return item.added_by === "daily-automation" && Number.isFinite(t) && now - t >= 0 && now - t <= H24;
  }
  if (def.filter === "best") return (item.match_score || 0) >= taste.automation_rules.best_match_score || (item.tags || []).includes("best");
  if (def.filter === "tags") return (def.tags_any || []).some(tag => (item.tags || []).includes(tag));
  if (def.filter === "dna") return dnaScoreFor(def, item) !== null;
  return false;
}


// A DNA row ranks by its own row score, so showing the unrelated global
// match_score on the card would contradict the ordering the user is looking at.
// The row label is derived from def.name (its emoji prefix stripped) so the
// displayed name and the catalog name cannot drift apart.
function scoreLabel(def) {
  return def.name.replace(/^[^\p{L}]+/u, "").trim();
}

// Only the FINAL row score is ever displayed: post-personalization,
// post-archetype-bonus, post-guardrail, clamped. The dna vector, dna_confidence,
// dna_tags and the raw personalized dna_match / execution_fit inputs are never
// rendered and never leave the build.
function meta(item, def) {
  const title = item.canonical_title || item.title;
  const tagText = (item.tags || []).filter(t => t !== "best").join(", ");
  const added = item.added_by === "daily-automation" ? ` • Daily discovery ${item.added_at?.slice(0, 10)}` : "";

  let scoreText = item.match_score ? ` • Match ${item.match_score}/100` : "";
  if (def && def.filter === "dna") {
    const dnaScore = dnaScoreFor(def, item);
    scoreText = dnaScore === null ? "" : ` • ${scoreLabel(def)} ${dnaScore}/100`;
  }

  return {
    id: item.imdb_id,
    type: item.type,
    name: title,
    poster: `https://images.metahub.space/poster/medium/${item.imdb_id}/img`,
    posterShape: "poster",
    releaseInfo: String(item.year),
    description: `${item.reason}${scoreText}${added}${tagText ? ` • ${tagText}` : ""}`
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// Presentation copy belongs to the addon, not to the builder. config.site is
// optional; without it the page falls back to the manifest's own name and
// description, so a repo can never end up branded as a different addon.
const site = config.site || {};

// STREMIO APPENDS THE MEDIA TYPE ITSELF.
//
// A catalog entry's `type` is already rendered by the client as " - Movie" or
// " - Series", so putting "Movies" / "Series" in the NAME as well produced a
// visible duplication:
//
//     "Full Watchlist • Movies"  ->  "Full Watchlist • Movies - Movie"
//
// The name therefore carries the GENRE instead. That is the part the client
// cannot derive on its own, and it is what actually distinguishes one WTF
// addon's rows from another's when several are installed side by side:
//
//     "🧬 DNA Match • Mystery"   ->  "🧬 DNA Match • Mystery - Movie"
//     "⚡ High Suspense • Thriller" -> "⚡ High Suspense • Thriller - Series"
//
// site.genre is genre-owned presentation copy and stays OPTIONAL. Without it
// the row is simply "🧬 DNA Match - Movie" - still correct, still never
// duplicated. The builder must never invent a genre label of its own, because
// guessing one from the manifest name would brand a repo with a word its own
// config never chose.
//
// NOTE this affects the DISPLAY NAME ONLY. The catalog id stays `${def.id}-${type}`,
// so endpoints, sorting, filtering and every stored score are untouched.
const genre = typeof site.genre === "string" ? site.genre.trim() : "";
const rowName = def => genre ? `${def.name} • ${genre}` : def.name;

const manifestCatalogs = [];
for (const type of ["movie", "series"]) {
  for (const def of config.catalogs) {
    const id = `${def.id}-${type}`;
    manifestCatalogs.push({ type, id, name: rowName(def) });
    const selected = sortItems(def, watch.filter(x => x.type === type && matches(def, x)), dnaScoreFor);
    writeJson(path.join(out, "catalog", type, `${id}.json`), { metas: selected.map(item => meta(item, def)) });
    // Build log only, never user-facing: the type label here is for whoever is
    // reading the CI output.
    console.log(`${type === "movie" ? "Movies" : "Series"}: ${def.name} -> ${selected.length}`);
  }
}

const manifest = {
  id: config.manifest.id,
  version: config.manifest.version,
  name: config.manifest.name,
  description: config.manifest.description,
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: manifestCatalogs,
  idPrefixes: ["tt"]
};
writeJson(path.join(out, "manifest.json"), manifest);
fs.writeFileSync(path.join(out, ".nojekyll"), "", "utf8");

// site was resolved above, where the catalog row names are built.
const pageTitle = site.title || config.manifest.name;
const pageEmoji = site.emoji || "";
const pageHeading = `${pageEmoji ? pageEmoji + " " : ""}${pageTitle}`;
const pageBlurb = site.blurb || config.manifest.description;
const escapeHtml = value => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(pageTitle)}</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1117;color:#f5f7ff;margin:0;padding:32px}.card{max-width:820px;margin:auto;background:#191d28;border:1px solid #32394c;border-radius:18px;padding:30px}h1{margin-top:0}p{line-height:1.55;color:#cbd2e6}.btn{display:inline-block;background:#6d5dfc;color:#fff;text-decoration:none;border:0;border-radius:11px;padding:13px 18px;font-weight:700;margin:6px 8px 6px 0;cursor:pointer}code{display:block;background:#0b0d12;border:1px solid #303648;border-radius:8px;padding:10px;word-break:break-all}.small{font-size:.92rem;color:#929bb5}</style></head>
<body><div class="card"><h1>${escapeHtml(pageHeading)}</h1><p>${escapeHtml(pageBlurb)}</p><p><a id="install" class="btn" href="#">Install in Stremio</a><button id="copy" class="btn">Copy manifest URL</button></p><p>Manifest URL:</p><code id="manifest"></code><p class="small">Catalog contents update automatically when the repository deploys. You do not need to reinstall the addon for ordinary movie/series additions.</p></div>
<script>const u=new URL('manifest.json',location.href).href;document.getElementById('manifest').textContent=u;document.getElementById('install').href=u.replace(/^https:/,'stremio:');document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(u);document.getElementById('copy').textContent='Copied!'};</script></body></html>`;
fs.writeFileSync(path.join(out, "index.html"), html, "utf8");
console.log(`Built ${watch.length} watchlist items (${discoveryItems.length} from automation discovery files) into ${out}`);
