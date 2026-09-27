import fs from "node:fs";
import path from "node:path";
import { validatedIdentityKey } from "./identity.mjs";
import { normalizeTitle } from "./cinemeta.mjs";

const DIR = path.join("data", "run-logs");
const DISC = path.join("data", "discoveries");
const LEGACY = path.join("data", "discovery-log.json");
const jsonFiles = dir => fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith(".json")).sort() : [];
let errors = 0;
const fail = message => { console.error(`run-logs: ${message}`); errors++; };
function read(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${file}: invalid JSON (${error.message})`); return null; }
}

// Legacy entries remain immutable history. They satisfy the audit requirement
// for old discovery files, but a bare filename or an unrelated run never does.
const legacy = new Map();
if (fs.existsSync(LEGACY)) {
  const payload = read(LEGACY);
  if (!Array.isArray(payload?.runs)) fail(`${LEGACY}: expected runs array`);
  else for (const run of payload.runs) {
    if (!run || typeof run.run_id !== "string") { fail(`${LEGACY}: invalid run_id`); continue; }
    if (legacy.has(run.run_id)) fail(`${LEGACY}: duplicate run_id ${run.run_id}`);
    legacy.set(run.run_id, run);
  }
}

const runs = new Map();
const files = jsonFiles(DIR);
for (const name of files) {
  const run = read(path.join(DIR, name));
  if (!run || Array.isArray(run) || typeof run !== "object") { fail(`${name}: expected one run object`); continue; }
  if (typeof run.run_id !== "string" || !/^[A-Za-z0-9._-]+$/.test(run.run_id)) { fail(`${name}: invalid run_id`); continue; }
  if (name !== `${run.run_id}.json`) fail(`${name}: filename must equal ${run.run_id}.json`);
  if (runs.has(run.run_id)) fail(`${name}: duplicate run_id ${run.run_id}`);
  runs.set(run.run_id, run);
  if (!Number.isFinite(Date.parse(run.timestamp || ""))) fail(`${name}: invalid timestamp`);
  for (const key of ["searched", "accepted", "rejected", "duplicates"]) {
    if (!Number.isInteger(run[key]) || run[key] < 0) fail(`${name}: ${key} must be a non-negative integer`);
  }
  if (!Array.isArray(run.accepted_items)) fail(`${name}: accepted_items must be an array`);
  if (Array.isArray(run.accepted_items) && run.accepted_items.length !== run.accepted) fail(`${name}: accepted must equal accepted_items.length`);
  const summary = run.rejection_summary;
  if (!(typeof summary === "string" || Array.isArray(summary)
      || (summary !== null && typeof summary === "object"))) {
    fail(`${name}: rejection_summary must be a string, array, or object`);
  }
}

function checkAccepted(run, items, label) {
  if (!Array.isArray(run.accepted_items)) { fail(`${label}: accepted_items must be an array`); return; }
  if (!Number.isInteger(run.accepted) || run.accepted !== items.length
      || run.accepted_items.length !== items.length) {
    fail(`${label}: accepted count does not match discovery item count and accepted_items`);
  }
  const discoveryKeys = items.map(item => validatedIdentityKey(item, normalizeTitle));
  if (discoveryKeys.some(key => !key)) fail(`${label}: discovery contains an invalid identity`);
  const acceptedKeys = run.accepted_items.map((entry, index) => {
    let key;
    if (typeof entry === "string" && /^tt\d+$/.test(entry)) {
      // Historical string entries omit type. Resolve it only from exactly one
      // matching discovery identity, never by guessing movie versus series.
      const matches = items.filter(item => item?.imdb_id === entry);
      key = matches.length === 1 ? validatedIdentityKey(matches[0], normalizeTitle) : null;
    } else {
      key = validatedIdentityKey(entry, normalizeTitle);
    }
    if (!key) fail(`${label}: accepted_items[${index}] has an invalid or ambiguous identity`);
    return key;
  });
  if (new Set(acceptedKeys).size !== acceptedKeys.length) fail(`${label}: duplicate accepted_items identity`);
  if (new Set(discoveryKeys).size !== discoveryKeys.length) fail(`${label}: duplicate discovery identity`);
  if (JSON.stringify(acceptedKeys.sort()) !== JSON.stringify(discoveryKeys.sort())) {
    fail(`${label}: accepted_items identities do not match discovery file`);
  }
}

const discoveredRuns = new Set();
for (const name of jsonFiles(DISC)) {
  const file = path.join(DISC, name);
  const payload = read(file);
  const items = Array.isArray(payload) ? payload : payload?.items;
  if (!Array.isArray(items)) { fail(`${file}: expected items array`); continue; }
  const runId = name.slice(0, -5);
  discoveredRuns.add(runId);
  if (!Array.isArray(payload) && payload.run_id !== runId) fail(`${file}: run_id must match filename`);
  if (items.some(item => item?.discovery_run_id !== undefined && item.discovery_run_id !== runId)) {
    fail(`${file}: item discovery_run_id must match filename`);
  }
  const run = runs.get(runId) || legacy.get(runId);
  if (!run) { fail(`${file}: no matching immutable or legacy run log`); continue; }
  if (run.accepted === 0) fail(`${file}: accepted is 0 but a same-run discovery file exists`);
  checkAccepted(run, items, file);
}

for (const [runId, run] of runs) {
  if (discoveredRuns.has(runId)) continue;
  if (run.accepted > 0) fail(`${runId}.json: accepted > 0 but ${path.join(DISC, `${runId}.json`)} is missing`);
  // Even a zero-finding record must not hide malformed accepted entries.
  checkAccepted(run, [], `${runId}.json`);
}
if (errors) process.exit(1);
console.log(`Run-log validation OK: ${files.length} immutable run log${files.length === 1 ? "" : "s"}, ${discoveredRuns.size} audited discovery files.`);
