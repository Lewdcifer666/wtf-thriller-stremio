import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { identityForms, validatedIdentityKey } from "./identity.mjs";
import { normalizeTitle, resolveItem } from "./cinemeta.mjs";
import { watchedEvidenceIdentities } from "./validate-profile.mjs";
import { readPersonalizedScores, personalizationState } from "./personalized-scores.mjs";

const itemsOf = value => Array.isArray(value) ? value : value?.items || [];
const sortedUnique = values => [...new Set(values)].sort();
const EFFECTIVE_KEYS = ["personalization_enabled", "personalization_status", "personalization_applied_items"];

export function readAutomationInputs(root) {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  const exists = file => fs.existsSync(path.join(root, file));
  const discoveryDir = path.join(root, "data/discoveries");
  const discoveries = fs.existsSync(discoveryDir) ? fs.readdirSync(discoveryDir)
    .filter(name => name.toLowerCase().endsWith(".json")).sort().map(name => `data/discoveries/${name}`) : [];
  const publicItems = [...itemsOf(read("data/library.json"))];
  for (const file of discoveries) publicItems.push(...itemsOf(read(file)));
  const profile = read("data/taste-profile.json");
  const catalogs = read("config/catalogs.json");
  const rejections = exists("data/rejections.json") ? itemsOf(read("data/rejections.json")) : [];
  const files = ["config/catalogs.json", "data/library.json", "data/taste-profile.json",
    ...(exists("data/rejections.json") ? ["data/rejections.json"] : []),
    ...(exists("data/personalized-scores.json") ? ["data/personalized-scores.json"] : []),
    ...discoveries,
    "scripts/identity.mjs", "scripts/cinemeta.mjs", "scripts/validate-profile.mjs",
    "scripts/dna-score.mjs", "scripts/validate.mjs", "scripts/personalized-scores.mjs",
    "scripts/automation-state.mjs", "scripts/build-site.mjs",
  ];
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(fs.readFileSync(path.join(root, file))).update("\0");
  return { profile, catalogs, publicItems, rejections, discoveries, inputToken: hash.digest("hex") };
}

// Shared by build and standalone state inspection, including resolution failures.
export async function resolveWatchItems(publicItems, warn = console.warn) {
  const watch = [];
  for (const original of publicItems.filter(item => item.status === "watch")) {
    try { watch.push(original.imdb_id ? original : await resolveItem(original)); }
    catch (error) { warn(`Skipping unresolved item: ${error.message}`); }
  }
  return watch;
}

function effectiveFields(state) {
  return Object.fromEntries(EFFECTIVE_KEYS.map(key => [key, state[key]]));
}

function stateFor(inputs, effective) {
  // Only meaningful effective-state transitions change the token when source
  // bytes are unchanged. Do not hash the continuously changing clock itself.
  const stateToken = crypto.createHash("sha256").update(inputs.inputToken).update("\0")
    .update(JSON.stringify(effectiveFields(effective))).digest("hex");
  return {
    schema_version: 1,
    state_token: stateToken,
    minimum_match_score: inputs.profile?.automation_rules?.minimum_match_score ?? null,
    best_match_score: inputs.profile?.automation_rules?.best_match_score ?? null,
    ...effectiveFields(effective),
    discovery_file_count: inputs.discoveries.length,
    public_identities: sortedUnique(inputs.publicItems.map(item => validatedIdentityKey(item, normalizeTitle)).filter(Boolean)),
    watched_identity_forms: sortedUnique(watchedEvidenceIdentities(inputs.profile).flatMap(item => identityForms(item, normalizeTitle))),
    rejection_identity_forms: sortedUnique(inputs.rejections.flatMap(item => identityForms(item, normalizeTitle))),
  };
}

export async function createAutomationState(root, { now = Date.now(), resolvedItems, snapshot } = {}) {
  const inputs = readAutomationInputs(root);
  const effective = personalizationState({
    snapshot: snapshot ?? readPersonalizedScores(fs, path.join(root, "data/personalized-scores.json"), now),
    profile: inputs.profile, catalogs: inputs.catalogs,
    publicItems: resolvedItems ?? await resolveWatchItems(inputs.publicItems),
  });
  return stateFor(inputs, effective);
}

export function createBuildStateReceipt(root, state, now) {
  const inputs = readAutomationInputs(root);
  if (JSON.stringify(stateFor(inputs, state)) !== JSON.stringify(state)) throw new Error("Automation inputs changed during the site build");
  return { schema_version: 1, evaluated_at: new Date(now).toISOString(), input_token: inputs.inputToken, state };
}

// Export the artifact's actual decision, even if its snapshot expires in transit.
export function stateFromBuildReceipt(root, receipt) {
  const inputs = readAutomationInputs(root);
  if (!receipt || receipt.schema_version !== 1 || !Number.isFinite(Date.parse(receipt.evaluated_at)) || receipt.input_token !== inputs.inputToken) {
    throw new Error("Build-state receipt does not match the validated repository inputs; rebuild before exporting");
  }
  const state = receipt.state;
  const statuses = ["applied", "absent", "unreadable", "invalid_json", "bad_shape", "unsupported_schema", "bad_timestamp", "stale", "future", "empty", "no_applicable_items"];
  if (!state || typeof state.personalization_enabled !== "boolean" || !statuses.includes(state.personalization_status)
    || !Number.isInteger(state.personalization_applied_items) || state.personalization_applied_items < 0
    || state.personalization_enabled !== (state.personalization_status === "applied")
    || state.personalization_enabled !== (state.personalization_applied_items > 0)
    || JSON.stringify(stateFor(inputs, state)) !== JSON.stringify(state)) {
    throw new Error("Invalid build-state receipt");
  }
  return state;
}
