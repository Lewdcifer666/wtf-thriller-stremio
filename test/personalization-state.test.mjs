import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readPersonalizedScores, personalizationState, FRESHNESS_MAX_AGE_MS, FRESHNESS_FUTURE_SKEW_MS } from "../scripts/personalized-scores.mjs";

// All writes and builds are in a disposable fixture; never touch live data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = {
  dna_dimensions: { dimensions: [{ id: "mystery" }] },
  dna_baseline: { weights: { mystery: 1 }, archetypes: [], completeness_defaults: {
    min_known_dimensions: 1, min_confidence: 0.5, required_known_dimensions: ["mystery"],
  } },
  dna_guardrails: { hard_exclusion: [], combination: [] },
  execution_preferences: { content_vs_execution: { content_fit: 0.8, execution_fit: 0.2 } },
  automation_rules: { minimum_match_score: 50, best_match_score: 80 },
};
const def = { id: "dna-match", name: "DNA Match", filter: "dna", sort: "dna", min_score: 50,
  dna: { mode: "baseline_profile", archetype_bonus_max: 0 } };
const catalogs = { manifest: { id: "test.personalization", name: "Test", version: "1.0.0", description: "Test" }, catalogs: [def] };
const item = { imdb_id: "tt1234567", type: "movie", title: "Fixture", year: 2026,
  status: "watch", reason: "Test", dna: { mystery: 7 }, dna_confidence: 1 };
const now = Date.parse("2026-09-25T12:00:00Z");
const iso = time => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
const payload = (time = now, items = { [item.imdb_id]: { dna_match: 90, execution_fit: 90 } }) =>
  ({ schema_version: 1, generated_at: iso(time), items });
const read = (value, clock = now) => readPersonalizedScores({
  existsSync: () => value !== undefined,
  readFileSync: () => typeof value === "string" ? value : JSON.stringify(value),
}, "fixture", clock);
const state = (snapshot, overrides = {}) => personalizationState({ snapshot, profile, catalogs, publicItems: [item], ...overrides });
const check = (value, expected, enabled = false, overrides = {}) => {
  const result = state(read(value), overrides);
  assert.equal(result.personalization_status, expected);
  assert.equal(result.personalization_enabled, enabled);
  assert.equal(result.personalization_applied_items, enabled ? 1 : 0);
};

check(undefined, "absent");
check("{", "invalid_json");
check({}, "bad_shape");
check({ ...payload(), schema_version: 99 }, "unsupported_schema");
check({ ...payload(), generated_at: "2026-02-30T12:00:00Z" }, "bad_timestamp");
check(payload(now - FRESHNESS_MAX_AGE_MS - 1000), "stale");
check(payload(now + FRESHNESS_FUTURE_SKEW_MS + 1000), "future");
check(payload(now - FRESHNESS_MAX_AGE_MS), "applied", true);
check(payload(now + FRESHNESS_FUTURE_SKEW_MS), "applied", true);
check(payload(now, {}), "empty");
check(payload(now, { [item.imdb_id]: { dna_match: 101, execution_fit: 80 } }), "empty");
check(payload(now, { tt9999999: { dna_match: 90, execution_fit: 90 } }), "no_applicable_items");
check(payload(), "no_applicable_items", false, { publicItems: [{ ...item, status: "seen" }] });
check(payload(), "no_applicable_items", false, { publicItems: [{ ...item, dna_confidence: 0 }] });
check(payload(), "no_applicable_items", false, { publicItems: [{ ...item, dna: {} }] });
check(payload(), "no_applicable_items", false, { catalogs: { catalogs: [] } });
check(payload(), "no_applicable_items", false, { profile: { ...profile, dna_dimensions: undefined } });
check(payload(), "no_applicable_items", false, { profile: { ...profile,
  dna_guardrails: { hard_exclusion: [{ dimension: "mystery", at_or_above: 7 }], combination: [] } } });
check(payload(), "no_applicable_items", false, { catalogs: { catalogs: [{ ...def,
  dna: { ...def.dna, gate: { all_of: [{ dimension: "mystery", at_or_above: 8 }] } } }] } });
check(payload(), "applied", true);
check(payload(now, { [item.imdb_id]: { dna_match: 0, execution_fit: 0 } }), "applied", true);
check(payload(now, { ...payload().items, tt999: { dna_match: -1, execution_fit: 50 } }), "applied", true);
const unreadable = readPersonalizedScores({ existsSync: () => true, readFileSync: () => { throw new Error("unreadable"); } }, "fixture", now);
assert.equal(state(unreadable).personalization_status, "unreadable");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtf-personalization-state-"));
try {
  fs.cpSync(path.join(root, "scripts"), path.join(tmp, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "data"));
  fs.mkdirSync(path.join(tmp, "config"));
  const write = (file, value) => fs.writeFileSync(path.join(tmp, file), JSON.stringify(value) + "\n");
  write("data/taste-profile.json", profile);
  write("data/library.json", { items: [item] });
  write("config/catalogs.json", catalogs);
  const snapshotFile = path.join(tmp, "data/personalized-scores.json");
  const run = (script, ...args) => execFileSync(process.execPath, [path.join(tmp, "scripts", script), ...args], { cwd: tmp, encoding: "utf8" });
  const report = () => {
    const before = fs.existsSync(snapshotFile) ? fs.readFileSync(snapshotFile) : null;
    run("export-automation-state.mjs");
    const output = JSON.parse(fs.readFileSync(path.join(tmp, "data/automation-state.json")));
    if (fs.existsSync(path.join(tmp, "scripts/automation-preflight.mjs"))) {
      const preflight = JSON.parse(run("automation-preflight.mjs", "snapshot"));
      for (const key of ["state_token", "personalization_enabled", "personalization_status", "personalization_applied_items"]) {
        assert.equal(preflight[key], output[key], `preflight/export agreement: ${key}`);
      }
    }
    if (before) assert.deepEqual(fs.readFileSync(snapshotFile), before, "reporting must preserve snapshot bytes and timestamp");
    else assert.equal(fs.existsSync(snapshotFile), false, "reporting must not create a snapshot");
    return output;
  };
  const buildCatalog = () => {
    run("build-site.mjs");
    return fs.readFileSync(path.join(tmp, "site/catalog/movie/dna-match-movie.json"), "utf8");
  };
  assert.equal(report().personalization_enabled, false);
  const baseline = buildCatalog();
  write("data/personalized-scores.json", payload(Date.now() - FRESHNESS_MAX_AGE_MS - 10000));
  assert.equal(report().personalization_status, "stale");
  const expiredBytes = fs.readFileSync(snapshotFile);
  assert.equal(buildCatalog(), baseline, "expired snapshot must build identical baseline DNA catalog");
  assert.deepEqual(fs.readFileSync(snapshotFile), expiredBytes);
  write("data/personalized-scores.json", payload(Date.now()));
  assert.equal(report().personalization_enabled, true);
  assert.notEqual(buildCatalog(), baseline, "valid optional personalization still affects DNA scores");
  write("data/personalized-scores.json", payload(Date.now(), {}));
  assert.equal(report().personalization_enabled, false);
  assert.equal(buildCatalog(), baseline);
  fs.writeFileSync(snapshotFile, "{");
  assert.equal(report().personalization_status, "invalid_json");
  assert.equal(buildCatalog(), baseline);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("Personalization state: validity, applicability, baseline fallback and snapshot preservation passed.");
