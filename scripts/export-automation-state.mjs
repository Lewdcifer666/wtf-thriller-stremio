import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { identityKey } from "./identity.mjs";
import { normalizeTitle } from "./cinemeta.mjs";
import { watchedEvidenceIdentities } from "./validate-profile.mjs";
import { readPersonalizedScores, personalizationState } from "./personalized-scores.mjs";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const DISCOVERY_DIR = path.join(DATA, "discoveries");
const outFile = process.argv[2] || path.join("data", "automation-state.json");
const IMDB_RE = /^tt\d+$/;

const readText = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readJson = rel => JSON.parse(readText(rel));
const exists = rel => fs.existsSync(path.join(ROOT, rel));

function payloadItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}
function discoveryFiles() {
  if (!fs.existsSync(DISCOVERY_DIR)) return [];
  return fs.readdirSync(DISCOVERY_DIR).filter(n => n.toLowerCase().endsWith(".json")).sort().map(n => `data/discoveries/${n}`);
}
function identityForms(item) {
  const forms=[];
  if (!item || (item.type!=="movie" && item.type!=="series")) return forms;
  if (typeof item.imdb_id==="string" && IMDB_RE.test(item.imdb_id)) forms.push(`${item.type}:${item.imdb_id}`);
  if (typeof item.title==="string" && Number.isInteger(item.year)) forms.push(`${item.type}:${normalizeTitle(item.title)}:${item.year}`);
  return [...new Set(forms)];
}
function canonical(item) {
  try { return identityKey(item, normalizeTitle); } catch { return null; }
}
function hashFiles(files) {
  const h=crypto.createHash("sha256");
  for (const file of files) { h.update(file); h.update("\0"); h.update(readText(file)); h.update("\0"); }
  return h.digest("hex");
}

const profile=readJson("data/taste-profile.json");
const library=readJson("data/library.json");
const discoveries=discoveryFiles();
const publicItems=[...payloadItems(library)];
for (const file of discoveries) publicItems.push(...payloadItems(readJson(file)));

const publicIdentities=[...new Set(publicItems.map(canonical).filter(Boolean))].sort();
const watched=[...new Set(watchedEvidenceIdentities(profile).flatMap(identityForms))].sort();
const rejectionPayload=exists("data/rejections.json") ? readJson("data/rejections.json") : [];
const rejections=[...new Set(payloadItems(rejectionPayload).flatMap(identityForms))].sort();

const tracked=[
  "config/catalogs.json",
  "data/library.json",
  "data/taste-profile.json",
  ...(exists("data/rejections.json") ? ["data/rejections.json"] : []),
  ...(exists("data/personalized-scores.json") ? ["data/personalized-scores.json"] : []),
  ...discoveries,
  "scripts/identity.mjs",
  "scripts/cinemeta.mjs",
  "scripts/validate-profile.mjs",
  "scripts/dna-score.mjs",
  "scripts/validate.mjs",
  "scripts/personalized-scores.mjs"
];

const state={
  schema_version:1,
  state_token:hashFiles(tracked),
  minimum_match_score:profile?.automation_rules?.minimum_match_score ?? null,
  best_match_score:profile?.automation_rules?.best_match_score ?? null,
  ...personalizationState({
    snapshot:readPersonalizedScores(fs,path.join(DATA,"personalized-scores.json")),
    profile, catalogs:readJson("config/catalogs.json"), publicItems
  }),
  discovery_file_count:discoveries.length,
  public_identities:publicIdentities,
  watched_identity_forms:watched,
  rejection_identity_forms:rejections
};

const text=JSON.stringify(state,null,2)+"\n";
fs.mkdirSync(path.dirname(outFile),{recursive:true});
fs.writeFileSync(outFile,text,"utf8");
console.log(`Automation state: ${publicIdentities.length} public identities, ${watched.length} watched forms, ${rejections.length} rejection forms -> ${outFile}`);
