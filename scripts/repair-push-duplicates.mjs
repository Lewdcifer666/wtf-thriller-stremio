import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { identityKey } from "./identity.mjs";
import { normalizeTitle } from "./cinemeta.mjs";

function parseJsonArrayEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(x => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function gitChangedDiscoveryFiles() {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", "HEAD^", "HEAD", "--", "data/discoveries"],
      { encoding: "utf8" }
    );
    return output.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function itemKey(item) {
  return identityKey(item, normalizeTitle);
}

function itemLabel(item, key) {
  const title = typeof item?.title === "string" && item.title.trim() ? item.title.trim() : key;
  return item?.imdb_id ? `${title} (${item.imdb_id})` : title;
}

const touched = new Set([
  ...parseJsonArrayEnv("ADDED_FILES"),
  ...parseJsonArrayEnv("MODIFIED_FILES"),
  ...gitChangedDiscoveryFiles()
]);

const targetPaths = [...touched]
  .filter(file => /^data\/discoveries\/[^/]+\.json$/i.test(file))
  .filter(file => fs.existsSync(file))
  .sort();

if (targetPaths.length === 0) {
  console.log("Duplicate repair: this push did not add or modify a discovery JSON file.");
  process.exit(0);
}

const library = JSON.parse(fs.readFileSync("data/library.json", "utf8"));
const seen = new Set();
for (const item of library.items || []) seen.add(itemKey(item));

const targetSet = new Set(targetPaths.map(file => path.normalize(file)));
const discoveryDir = path.join("data", "discoveries");
if (fs.existsSync(discoveryDir)) {
  for (const name of fs.readdirSync(discoveryDir).filter(x => x.toLowerCase().endsWith(".json")).sort()) {
    const file = path.join(discoveryDir, name);
    if (targetSet.has(path.normalize(file))) continue;
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    const items = Array.isArray(payload) ? payload : payload.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) seen.add(itemKey(item));
  }
}

const removedByRun = new Map();
const survivorsByRun = new Map();
let totalRemoved = 0;

for (const file of targetPaths) {
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const items = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(items)) {
    throw new Error(`${file}: expected an items array; leaving validation to fail closed.`);
  }

  const survivors = [];
  const removed = [];
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) {
      removed.push({ item, key });
      continue;
    }
    seen.add(key);
    survivors.push(item);
  }

  if (removed.length === 0) {
    const runId = Array.isArray(payload)
      ? survivors[0]?.discovery_run_id
      : payload.run_id;
    if (runId) survivorsByRun.set(runId, survivors);
    continue;
  }

  totalRemoved += removed.length;
  const runId = Array.isArray(payload)
    ? (survivors[0]?.discovery_run_id || removed[0]?.item?.discovery_run_id)
    : payload.run_id;

  if (runId) {
    removedByRun.set(runId, [...(removedByRun.get(runId) || []), ...removed]);
    survivorsByRun.set(runId, survivors);
  }

  if (survivors.length === 0) {
    fs.unlinkSync(file);
    console.log(`Duplicate repair: removed empty discovery file ${file}.`);
  } else {
    const nextPayload = Array.isArray(payload) ? survivors : { ...payload, items: survivors };
    fs.writeFileSync(file, `${JSON.stringify(nextPayload, null, 2)}\n`);
  }

  for (const entry of removed) {
    console.log(`Duplicate repair: removed ${itemLabel(entry.item, entry.key)} because ${entry.key} already exists.`);
  }
}

if (totalRemoved === 0) {
  console.log("Duplicate repair: no duplicates introduced by this push.");
  process.exit(0);
}

const logPath = "data/discovery-log.json";
if (!fs.existsSync(logPath)) {
  throw new Error("Duplicate repair removed public items but data/discovery-log.json is missing; fail closed.");
}

const log = JSON.parse(fs.readFileSync(logPath, "utf8"));
if (!Array.isArray(log.runs)) {
  throw new Error("data/discovery-log.json: expected a runs array; fail closed.");
}

for (const [runId, removed] of removedByRun) {
  const run = log.runs.find(entry => entry?.run_id === runId);
  if (!run) {
    throw new Error(`Duplicate repair could not find discovery-log run ${runId}; fail closed.`);
  }

  const removedIds = new Set(removed.map(x => x.item?.imdb_id).filter(Boolean));
  const survivors = survivorsByRun.get(runId) || [];

  run.duplicates = (Number.isInteger(run.duplicates) ? run.duplicates : 0) + removed.length;
  run.accepted = survivors.length;

  if (Array.isArray(run.accepted_items)) {
    run.accepted_items = run.accepted_items.filter(id => !removedIds.has(id));
  } else {
    run.accepted_items = survivors.map(item => item.imdb_id).filter(Boolean);
  }

  const labels = removed.map(x => itemLabel(x.item, x.key)).join(", ");
  const baseSummary = typeof run.rejection_summary === "string" ? run.rejection_summary.trim() : "";
  const repairSentence = `Automatic pre-validation duplicate repair removed ${labels} because ${removed.length === 1 ? "its public identity already exists" : "their public identities already exist"}; this supersedes any earlier duplicate-count statement for this run.`;
  run.rejection_summary = baseSummary ? `${baseSummary} ${repairSentence}` : repairSentence;
}

fs.writeFileSync(logPath, `${JSON.stringify(log)}\n`);
console.log(`Duplicate repair complete: removed ${totalRemoved} duplicate item${totalRemoved === 1 ? "" : "s"} before validation.`);
