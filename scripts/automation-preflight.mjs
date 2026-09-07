import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { identityKey } from "./identity.mjs";
import { normalizeTitle } from "./cinemeta.mjs";
import { watchedEvidenceIdentities } from "./validate-profile.mjs";
import { makePolicy, scoreItem } from "./dna-score.mjs";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const DISCOVERY_DIR = path.join(DATA, "discoveries");
const IMDB_RE = /^tt\d+$/;

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function existing(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function discoveryFiles() {
  if (!fs.existsSync(DISCOVERY_DIR)) return [];
  return fs.readdirSync(DISCOVERY_DIR)
    .filter(name => name.toLowerCase().endsWith(".json"))
    .sort()
    .map(name => `data/discoveries/${name}`);
}

function payloadItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

function loadPublicItems() {
  const library = readJson("data/library.json");
  const out = [...payloadItems(library)];
  for (const file of discoveryFiles()) out.push(...payloadItems(readJson(file)));
  return out;
}

function identityForms(item) {
  const forms = [];
  if (!item || (item.type !== "movie" && item.type !== "series")) return forms;
  if (typeof item.imdb_id === "string" && IMDB_RE.test(item.imdb_id)) {
    forms.push(`${item.type}:${item.imdb_id}`);
  }
  if (typeof item.title === "string" && Number.isInteger(item.year)) {
    forms.push(`${item.type}:${normalizeTitle(item.title)}:${item.year}`);
  }
  return [...new Set(forms)];
}

function canonicalIdentity(item) {
  try {
    return identityKey(item, normalizeTitle);
  } catch {
    return null;
  }
}

function loadRejections() {
  if (!existing("data/rejections.json")) return [];
  const payload = readJson("data/rejections.json");
  return payloadItems(payload);
}

function stateToken(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readText(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function buildState() {
  const profile = readJson("data/taste-profile.json");
  const publicItems = loadPublicItems();
  const publicIdentities = new Map();
  const duplicatePublic = [];

  for (const item of publicItems) {
    const key = canonicalIdentity(item);
    if (!key) continue;
    if (publicIdentities.has(key)) {
      duplicatePublic.push({ key, first: publicIdentities.get(key), second: item.title || null });
    } else {
      publicIdentities.set(key, item.title || null);
    }
  }

  const watchedForms = new Set();
  for (const item of watchedEvidenceIdentities(profile)) {
    for (const form of identityForms(item)) watchedForms.add(form);
  }

  const rejectionForms = new Set();
  for (const item of loadRejections()) {
    for (const form of identityForms(item)) rejectionForms.add(form);
  }

  const trackedFiles = [
    "config/catalogs.json",
    "data/library.json",
    "data/taste-profile.json",
    "data/discovery-log.json",
    ...(existing("data/rejections.json") ? ["data/rejections.json"] : []),
    ...(existing("data/personalized-scores.json") ? ["data/personalized-scores.json"] : []),
    ...discoveryFiles(),
    "scripts/identity.mjs",
    "scripts/cinemeta.mjs",
    "scripts/validate-profile.mjs",
    "scripts/dna-score.mjs",
    "scripts/validate.mjs",
  ];

  return {
    profile,
    publicItems,
    publicIdentities,
    duplicatePublic,
    watchedForms,
    rejectionForms,
    trackedFiles,
    token: stateToken(trackedFiles),
    personalization_enabled: existing("data/personalized-scores.json"),
  };
}

function snapshot(state) {
  return {
    state_token: state.token,
    public_identity_count: state.publicIdentities.size,
    watched_identity_forms: state.watchedForms.size,
    rejection_identity_forms: state.rejectionForms.size,
    personalization_enabled: state.personalization_enabled,
    discovery_file_count: discoveryFiles().length,
    public_duplicate_count: state.duplicatePublic.length,
  };
}

function loadCandidateBatch(file) {
  if (!file) throw new Error("candidate JSON path is required for check");
  const payload = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && typeof payload === "object") return [payload];
  throw new Error("candidate JSON must be an object, an array, or an object with items[]");
}

function checkCandidates(state, candidates) {
  const seenBatch = new Set();
  const eligible = [];
  const excluded = [];

  for (const candidate of candidates) {
    const key = canonicalIdentity(candidate);
    const forms = identityForms(candidate);
    const reasons = [];

    if (!key) reasons.push("invalid_identity");
    if (key && state.publicIdentities.has(key)) reasons.push("duplicate_public_identity");
    if (key && seenBatch.has(key)) reasons.push("duplicate_within_candidate_batch");
    if (forms.some(form => state.watchedForms.has(form))) reasons.push("watched_baseline_evidence");
    if (forms.some(form => state.rejectionForms.has(form))) reasons.push("explicit_user_rejection");

    if (key) seenBatch.add(key);

    const record = {
      type: candidate?.type ?? null,
      imdb_id: candidate?.imdb_id ?? null,
      title: candidate?.title ?? null,
      year: candidate?.year ?? null,
      identity: key,
    };

    if (reasons.length) excluded.push({ ...record, reasons });
    else eligible.push(record);
  }

  return {
    state_token: state.token,
    checked: candidates.length,
    eligible_count: eligible.length,
    excluded_count: excluded.length,
    eligible,
    excluded,
  };
}

function scoreCandidates(state, candidates) {
  const catalogs = readJson("config/catalogs.json")?.catalogs || [];
  const baselineDef = catalogs.find(def => def?.dna?.mode === "baseline_profile");
  if (!baselineDef) throw new Error("config/catalogs.json has no baseline_profile DNA catalog");

  const policy = makePolicy(state.profile);
  const def = { ...baselineDef, min_score: 0 };
  const minimum = state.profile?.automation_rules?.minimum_match_score;
  if (!Number.isFinite(minimum)) throw new Error("taste profile has no finite automation_rules.minimum_match_score");

  const scored = candidates.map(candidate => {
    const result = scoreItem(policy, def, candidate, null);
    return {
      type: candidate?.type ?? null,
      imdb_id: candidate?.imdb_id ?? null,
      title: candidate?.title ?? null,
      year: candidate?.year ?? null,
      identity: canonicalIdentity(candidate),
      match_score: result.score,
      score_reason: result.reason,
      minimum_match_score: minimum,
      qualifies: Number.isInteger(result.score) && result.score >= minimum,
    };
  });

  return { state_token: state.token, minimum_match_score: minimum, scored };
}

function selfTest(state) {
  const errors = [];
  if (state.duplicatePublic.length) {
    errors.push(`current public state contains ${state.duplicatePublic.length} duplicate canonical identit${state.duplicatePublic.length === 1 ? "y" : "ies"}`);
  }
  if (!/^[0-9a-f]{64}$/.test(state.token)) errors.push("state token is not a SHA-256 digest");
  if (!Number.isInteger(state.publicIdentities.size)) errors.push("public identity set did not build");

  if (errors.length) {
    for (const error of errors) console.error(`automation-preflight: ${error}`);
    process.exit(1);
  }

  console.log(
    `Automation preflight OK: ${state.publicIdentities.size} public identities, ` +
    `${state.watchedForms.size} watched identity forms, ${state.rejectionForms.size} rejection identity forms.`
  );
}

const command = process.argv[2] || "snapshot";
const state = buildState();

if (command === "snapshot") {
  console.log(JSON.stringify(snapshot(state), null, 2));
} else if (command === "check" || command === "check-strict") {
  const result = checkCandidates(state, loadCandidateBatch(process.argv[3]));
  console.log(JSON.stringify(result, null, 2));
  if (command === "check-strict" && result.excluded_count) process.exit(2);
} else if (command === "score") {
  console.log(JSON.stringify(scoreCandidates(state, loadCandidateBatch(process.argv[3])), null, 2));
} else if (command === "self-test") {
  selfTest(state);
} else {
  console.error("Usage: node scripts/automation-preflight.mjs [snapshot|self-test|check <candidates.json>|check-strict <candidates.json>|score <candidates.json>]");
  process.exit(64);
}
