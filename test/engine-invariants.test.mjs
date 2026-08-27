// Structural invariants every genre profile must satisfy.
//
// These are the rules that are easy to state, easy to believe you have
// satisfied, and expensive to get wrong. Each one exists because getting it
// wrong produces a failure that is silent, delayed, or actively misleading:
//
//   T22  an archetype touching an unmeasurable dimension CRASHES the builder
//   T24  a registry that does not cover itself scores against a partial vector
//   T27  min_known does NOT gate the baseline row, however much it looks like it
//   T28  a metadata preference must never behave like a score
//   HX   a hard exclusion must be able to fire on a value being too LOW
//
// Run with: node test/engine-invariants.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateProfile } from "../scripts/validate-profile.mjs";
import { makePolicy, requiredFor, hardExcluded, exclusionCondition, evalCondition } from "../scripts/dna-score.mjs";
import { sortItems, tieBreak } from "../scripts/sort.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let passed = 0, failed = 0;
const check = (id, description, condition, detail) => {
  if (condition) { passed++; console.log(`  ok   ${id}  ${description}`); }
  else { failed++; console.error(`  FAIL ${id}  ${description}${detail ? `\n         ${detail}` : ""}`); }
};

const clone = value => JSON.parse(JSON.stringify(value));
const profile = JSON.parse(fs.readFileSync(path.join(root, "data", "taste-profile.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root, "config", "catalogs.json"), "utf8"));

console.log("Engine invariants");
console.log("");

// ---------------------------------------------------------------------------
// baseline: the real profile is valid
// ---------------------------------------------------------------------------
const baseErrors = validateProfile(profile);
check("BASE", "this repo's taste-profile.json validates", baseErrors.length === 0, baseErrors.join("\n         "));

const isSchema3 = profile.schema_version === 3;
const policy = isSchema3 ? makePolicy(profile) : null;

// ---------------------------------------------------------------------------
// T24 - registry coverage
// ---------------------------------------------------------------------------
if (isSchema3) {
  const registry = new Set(profile.dna_dimensions.dimensions.map(d => d.id));
  const weights = new Set(Object.keys(profile.dna_baseline.weights));
  const unweighted = new Set(profile.dna_baseline.unweighted);
  const completeness = profile.dna_baseline.completeness_defaults;
  const required = new Set(completeness.required_known_dimensions);

  check("T24a", "weights and unweighted are disjoint",
    [...weights].every(d => !unweighted.has(d)));
  check("T24b", "weights u unweighted covers the registry exactly",
    [...registry].every(d => weights.has(d) || unweighted.has(d))
    && weights.size + unweighted.size === registry.size);
  check("T24c", "count equals dimensions.length",
    profile.dna_dimensions.count === profile.dna_dimensions.dimensions.length);

  const slowToFast = profile.dna_dimensions.dimensions.filter(d => d.direction === "slow_to_fast");
  check("T24d", "exactly one slow_to_fast dimension, and it is pace_speed",
    slowToFast.length === 1 && slowToFast[0].id === "pace_speed",
    `found: ${slowToFast.map(d => d.id).join(", ") || "none"}`);

  const guardrailDims = new Set();
  for (const rule of profile.dna_guardrails.hard_exclusion) guardrailDims.add(rule.dimension);
  for (const rule of profile.dna_guardrails.combination) {
    for (const c of [...(rule.all_of || []), ...(rule.any_of || [])]) guardrailDims.add(c.dimension);
  }
  check("T24e", "required_known covers every guardrail-referenced dimension",
    [...guardrailDims].every(d => required.has(d)),
    [...guardrailDims].filter(d => !required.has(d)).join(", "));
  check("T24f", "min_known_dimensions is at least required_known_dimensions.length",
    completeness.min_known_dimensions >= required.size);

  // and the validator actually rejects a broken registry, rather than the
  // profile merely happening to be correct
  const broken = clone(profile);
  delete broken.dna_baseline.weights[[...weights][0]];
  check("T24g", "the validator REJECTS a dimension covered by neither weights nor unweighted",
    validateProfile(broken).some(e => e.includes("is in neither")));
}

// ---------------------------------------------------------------------------
// T22 - archetype completeness
// ---------------------------------------------------------------------------
if (isSchema3) {
  const weights = new Set(Object.keys(profile.dna_baseline.weights));
  const required = new Set(profile.dna_baseline.completeness_defaults.required_known_dimensions);
  const measurable = new Set([...weights, ...required]);

  let offenders = [];
  for (const archetype of profile.dna_baseline.archetypes) {
    for (const map of [archetype.emphasis, archetype.penalise || {}]) {
      for (const id of Object.keys(map)) if (!measurable.has(id)) offenders.push(`${archetype.id}.${id}`);
    }
  }
  check("T22a", "every archetype dimension is weighted or required-known",
    offenders.length === 0, offenders.join(", "));

  // prove the rule is enforced, not merely satisfied by luck: move a dimension
  // out of the weights into unweighted while an archetype still emphasises it
  const emphasised = Object.keys(profile.dna_baseline.archetypes[0].emphasis)
    .find(id => weights.has(id) && !required.has(id));
  if (emphasised) {
    const broken = clone(profile);
    delete broken.dna_baseline.weights[emphasised];
    broken.dna_baseline.unweighted.push(emphasised);
    check("T22b", "the validator REJECTS an archetype dimension that is neither weighted nor required-known",
      validateProfile(broken).some(e => e.includes("bestArchetype() would")),
      validateProfile(broken).join("\n         "));
  } else {
    check("T22b", "the validator REJECTS an unmeasurable archetype dimension", true,
      "(skipped: every emphasised dimension is also required-known here)");
  }
}

// ---------------------------------------------------------------------------
// T27 - min_known does NOT gate the baseline_profile row
//
// This is the invariant that keeps coming back as a wrong answer. Lowering
// min_known_dimensions looks like it should reduce how much research a title
// needs. It does not: it only relaxes dnaEligible(). requiredFor() independently
// demands EVERY weighted dimension for a baseline_profile row. Lowering it
// therefore relieves nothing that binds, while quietly weakening the
// eligibility floor - the worst of both.
// ---------------------------------------------------------------------------
if (isSchema3) {
  const baselineRow = config.catalogs.find(c => c.dna && c.dna.mode === "baseline_profile");
  check("T27a", "exactly one baseline_profile row exists",
    config.catalogs.filter(c => c.dna && c.dna.mode === "baseline_profile").length === 1);

  if (baselineRow) {
    const weightKeys = Object.keys(profile.dna_baseline.weights);
    const before = requiredFor(policy, baselineRow).sort();

    check("T27b", "requiredFor(baseline row) includes every weighted dimension",
      weightKeys.every(d => before.includes(d)),
      weightKeys.filter(d => !before.includes(d)).join(", "));

    const lowered = clone(profile);
    lowered.dna_baseline.completeness_defaults.min_known_dimensions =
      Math.max(0, lowered.dna_baseline.completeness_defaults.min_known_dimensions - 10);
    const after = requiredFor(makePolicy(lowered), baselineRow).sort();

    check("T27c", "lowering min_known_dimensions by 10 leaves requiredFor identical",
      JSON.stringify(before) === JSON.stringify(after),
      `before ${before.length} dims, after ${after.length} dims`);
  }
}

// ---------------------------------------------------------------------------
// HX - hard exclusions fire in BOTH directions
// ---------------------------------------------------------------------------
{
  const lowPolicy = { hardExclusions: [{ id: "too_low", dimension: "probe", at_or_below: 3 }] };
  const highPolicy = { hardExclusions: [{ id: "too_high", dimension: "probe", at_or_above: 7 }] };

  check("HX1", "at_or_below excludes a LOW value", hardExcluded(lowPolicy, { probe: 2 }));
  check("HX2", "at_or_below does not exclude a value above the bound", !hardExcluded(lowPolicy, { probe: 4 }));
  check("HX3", "at_or_below excludes exactly at the bound", hardExcluded(lowPolicy, { probe: 3 }));
  check("HX4", "at_or_above still excludes a HIGH value", hardExcluded(highPolicy, { probe: 8 }));
  check("HX5", "at_or_above does not exclude a low value", !hardExcluded(highPolicy, { probe: 1 }));

  // Unknown never excludes, in EITHER direction. That is safe rather than
  // fail-open only because guardrail dimensions are forced into
  // required_known_dimensions and dnaEligible() runs first.
  check("HX6", "an unknown value does not trigger an at_or_below exclusion",
    !hardExcluded(lowPolicy, { probe: null }) && !hardExcluded(lowPolicy, {}));
  check("HX7", "an unknown value does not trigger an at_or_above exclusion",
    !hardExcluded(highPolicy, { probe: null }));

  check("HX8", "exclusionCondition preserves the direction",
    Object.prototype.hasOwnProperty.call(exclusionCondition({ dimension: "probe", at_or_below: 3 }), "at_or_below")
    && Object.prototype.hasOwnProperty.call(exclusionCondition({ dimension: "probe", at_or_above: 7 }), "at_or_above"));
  check("HX9", "evalCondition agrees with hardExcluded on the low direction",
    evalCondition({ dimension: "probe", at_or_below: 3 }, { probe: 1 }) === true);

  if (isSchema3) {
    const withLow = clone(profile);
    const dim = profile.dna_baseline.completeness_defaults.required_known_dimensions[0];
    withLow.dna_guardrails.hard_exclusion.push({ id: "probe_low", dimension: dim, at_or_below: 1 });
    check("HX10", "the validator ACCEPTS an at_or_below hard exclusion",
      validateProfile(withLow).length === 0, validateProfile(withLow).join("\n         "));

    const both = clone(profile);
    both.dna_guardrails.hard_exclusion.push({ id: "probe_both", dimension: dim, at_or_above: 8, at_or_below: 1 });
    check("HX11", "the validator REJECTS a hard exclusion carrying both bounds",
      validateProfile(both).some(e => e.includes("not both")));

    const neither = clone(profile);
    neither.dna_guardrails.hard_exclusion.push({ id: "probe_neither", dimension: dim });
    check("HX12", "the validator REJECTS a hard exclusion carrying neither bound",
      validateProfile(neither).some(e => e.includes("exactly one of at_or_above / at_or_below")));
  }
}

// ---------------------------------------------------------------------------
// T28 - tie_break_rank is a tie-break, never a score
// ---------------------------------------------------------------------------
{
  const scores = new Map();
  const scoreFor = (def, item) => scores.get(item.title);
  const def = { sort: "dna_score" };
  const base = { added_at: "2026-01-01T00:00:00Z", imdb_id: "tt1" };

  const equalScores = [
    { ...base, title: "Plain", tie_break_rank: 0 },
    { ...base, title: "Preferred", tie_break_rank: 1 }
  ];
  scores.set("Plain", 70); scores.set("Preferred", 70);
  check("T28a", "among EQUAL scores, the ranked title sorts first",
    sortItems(def, equalScores, scoreFor)[0].title === "Preferred");

  const unequalScores = [
    { ...base, title: "Preferred", tie_break_rank: 99 },
    { ...base, title: "Better", tie_break_rank: 0 }
  ];
  scores.set("Better", 90);
  check("T28b", "a HIGHER score always outranks any tie_break_rank",
    sortItems(def, unequalScores, scoreFor)[0].title === "Better");

  scores.set("Preferred", 70); scores.set("Better", 71);
  check("T28c", "even a one-point score difference outranks tie_break_rank 99",
    sortItems(def, unequalScores, scoreFor)[0].title === "Better");

  // match_score is compared before tie_break_rank too
  const byMatch = [
    { ...base, title: "Preferred", match_score: 80, tie_break_rank: 99 },
    { ...base, title: "Better", match_score: 90, tie_break_rank: 0 }
  ];
  scores.set("Preferred", 70); scores.set("Better", 70);
  check("T28d", "match_score is compared before tie_break_rank",
    sortItems(def, byMatch, scoreFor)[0].title === "Better");

  check("T28e", "a missing tie_break_rank is treated as 0, not as an error",
    tieBreak({ title: "a" }, { title: "b" }) === 0);

  // the recency feed is deliberately not reorderable by a metadata preference
  const newestRow = [
    { title: "Older", added_at: "2026-01-01T00:00:00Z", tie_break_rank: 99 },
    { title: "Newer", added_at: "2026-06-01T00:00:00Z", tie_break_rank: 0 }
  ];
  check("T28f", "tie_break_rank does not reorder the 'newest' recency feed",
    sortItems({ sort: "newest" }, newestRow, scoreFor)[0].title === "Newer");

  // and it must not exist as a DNA dimension anywhere
  if (isSchema3) {
    check("T28g", "tie_break_rank is not a DNA dimension",
      !profile.dna_dimensions.dimensions.some(d => d.id === "tie_break_rank"));
  }
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
