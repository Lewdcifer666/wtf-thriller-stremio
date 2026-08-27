// Content DNA scoring engine (F2-8).
//
// This module is pure MECHANISM. It contains no dimension list, no weight and
// no threshold of its own: the taste policy comes from data/taste-profile.json
// and the catalog policy comes from config/catalogs.json. Everything it needs
// to know about magnitudes it derives at runtime.
//
// Two rules are load-bearing and easy to get wrong:
//
//   UNKNOWN IS NEVER ZERO. A dimension a row actually uses must be a real
//   integer. If any dimension in that row's required set is null or missing,
//   the item is INELIGIBLE for the row - it is never scored as if the value
//   were 0, which would silently invent "definitely absent" out of "not yet
//   measured".
//
//   CLAMP BEFORE GUARDRAILS. Row scores are clamped to 0..100 BEFORE the
//   guardrail deduction, so a saturated score cannot quietly absorb a penalty
//   and show the same number as a clean one.

export const DNA_ITEM_KEYS = ["dna", "dna_confidence", "dna_tags"];

// ---------------------------------------------------------------------------
// value access
// ---------------------------------------------------------------------------
export function isKnown(dna, id) {
  const value = dna?.[id];
  return Number.isInteger(value) && value >= 0 && value <= 10;
}

// Only ever called for dimensions already proven present by requiredFor().
function valueOf(dna, id) {
  const value = dna?.[id];
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error(`dna-score: '${id}' is not a known 0..10 value; the row's required set was not enforced`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// policy derived from taste-profile.json
// ---------------------------------------------------------------------------
export function makePolicy(profile) {
  const dimensions = profile.dna_dimensions.dimensions.map(d => d.id);
  const completeness = profile.dna_baseline.completeness_defaults;
  const weights = profile.dna_baseline.weights;

  // The denominator every magnitude in this engine is expressed against.
  // Derived, never authored, so there is no second copy of it anywhere.
  const baseMax = Object.values(weights).filter(w => w > 0).reduce((a, w) => a + w * 10, 0);

  // A firing guardrail counts as one full-strength negative signal on the
  // profile's own weight scale, converted into 0..100 points with the same
  // denominator. A -35 guardrail is then commensurate with a -35 authored
  // signal instead of erasing a third of the scale.
  const penaltyScale = 1000 / baseMax;

  return {
    profile,
    dimensions,
    completeness,
    weights,
    baseMax,
    penaltyScale,
    archetypes: profile.dna_baseline.archetypes,
    hardExclusions: profile.dna_guardrails.hard_exclusion,
    combinations: profile.dna_guardrails.combination,
    contentVsExecution: profile.execution_preferences.content_vs_execution
  };
}

// ---------------------------------------------------------------------------
// F2-6 condition grammar, reused verbatim for guardrails AND row gates
//   fires <=> every all_of is true AND (any_of empty OR some any_of is true)
//   a condition on an unknown dimension is FALSE, in both directions
// ---------------------------------------------------------------------------
export function evalCondition(condition, dna) {
  if (!isKnown(dna, condition.dimension)) return false;
  const value = dna[condition.dimension];
  return Object.prototype.hasOwnProperty.call(condition, "at_or_above")
    ? value >= condition.at_or_above
    : value <= condition.at_or_below;
}

export function evalRule(rule, dna) {
  const all = (rule.all_of || []).every(c => evalCondition(c, dna));
  const any = (rule.any_of || []).length === 0 || rule.any_of.some(c => evalCondition(c, dna));
  return all && any;
}

function ruleDimensions(rule) {
  return [...(rule.all_of || []), ...(rule.any_of || [])].map(c => c.dimension);
}

// ---------------------------------------------------------------------------
// eligibility
// ---------------------------------------------------------------------------
export function dnaEligible(policy, item) {
  const { completeness, dimensions } = policy;
  const dna = item.dna;
  const knownCount = dimensions.filter(d => isKnown(dna, d)).length;
  const confidence = typeof item.dna_confidence === "number" && Number.isFinite(item.dna_confidence)
    ? item.dna_confidence
    : 0;
  return knownCount >= completeness.min_known_dimensions
    && confidence >= completeness.min_confidence
    && completeness.required_known_dimensions.every(d => isKnown(dna, d));
}

// A hard exclusion carries EXACTLY ONE of at_or_above / at_or_below, the same
// grammar the combination rules and row gates already use. Two directions are
// needed because some profiles exclude on a value being too HIGH (superhero
// structure is central) and others on it being too LOW (an Action title with
// almost no action across its runtime is not an Action recommendation at all,
// however good its other properties are).
//
// Unknown still evaluates FALSE in both directions, so an unmeasured dimension
// never triggers an exclusion. That is safe rather than fail-open because the
// profile validator forces every guardrail-referenced dimension into
// required_known_dimensions, and scoreItem() runs dnaEligible() BEFORE
// hardExcluded() - an item missing the dimension is already ineligible.
export function exclusionCondition(rule) {
  return Object.prototype.hasOwnProperty.call(rule, "at_or_above")
    ? { dimension: rule.dimension, at_or_above: rule.at_or_above }
    : { dimension: rule.dimension, at_or_below: rule.at_or_below };
}

export function hardExcluded(policy, dna) {
  return policy.hardExclusions.some(rule => evalCondition(exclusionCondition(rule), dna));
}

export function firingCombinations(policy, dna) {
  return policy.combinations.filter(rule => evalRule(rule, dna));
}

export function guardrailPoints(policy, dna) {
  return firingCombinations(policy, dna)
    .reduce((total, rule) => total + Math.abs(rule.penalty) * policy.penaltyScale, 0);
}

// ---------------------------------------------------------------------------
// the set of dimensions a row must actually know before it may do arithmetic
// ---------------------------------------------------------------------------
export function requiredFor(policy, def) {
  const required = new Set(policy.completeness.required_known_dimensions);
  const config = def.dna || {};

  if (config.mode === "baseline_profile") {
    for (const d of Object.keys(policy.weights)) required.add(d);
  } else {
    for (const d of Object.keys(config.weights || {})) required.add(d);
    for (const d of Object.keys(config.penalties || {})) required.add(d);
    if (config.gate) for (const d of ruleDimensions(config.gate)) required.add(d);
  }
  return [...required];
}

// ---------------------------------------------------------------------------
// archetypes - best match only, never an average
// ---------------------------------------------------------------------------
export function bestArchetype(policy, dna) {
  let best = null;
  for (const archetype of policy.archetypes) {
    const satisfied = archetype.requires.map(r => evalCondition({ dimension: r.dimension, at_or_above: r.at_or_above }, dna));
    const matched = archetype.requires_mode === "any" ? satisfied.some(Boolean) : satisfied.every(Boolean);
    if (!matched) continue;

    let raw = 0;
    let max = 0;
    for (const [d, emphasis] of Object.entries(archetype.emphasis)) {
      raw += emphasis * valueOf(dna, d);
      max += emphasis * 10;
    }
    for (const [d, penalise] of Object.entries(archetype.penalise || {})) {
      raw -= penalise * valueOf(dna, d);
    }
    const base = 100 * clamp(raw, 0, max) / max;
    const effective = archetype.weight * base;
    if (!best || effective > best.effective) best = { id: archetype.id, base, weight: archetype.weight, effective };
  }
  return best;
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------
function clamp(value, lo, hi) { return Math.min(Math.max(value, lo), hi); }

// normalized weighted sum: 100 * clamp(SW+.v - SW-.v, 0, MAX) / MAX
function weightedBase(dna, weights, penalties) {
  let raw = 0;
  let max = 0;
  for (const [d, w] of Object.entries(weights)) { raw += w * valueOf(dna, d); max += w * 10; }
  for (const [d, w] of Object.entries(penalties || {})) raw -= w * valueOf(dna, d);
  return 100 * clamp(raw, 0, max) / max;
}

export function baselineContentPre(policy, item, archetypeBonusMax) {
  const dna = item.dna;
  let raw = 0;
  for (const [d, w] of Object.entries(policy.weights)) raw += w * valueOf(dna, d);
  const contentBase = 100 * clamp(raw, 0, policy.baseMax) / policy.baseMax;

  const archetype = bestArchetype(policy, dna);
  const archetypeBonus = archetype ? archetypeBonusMax * archetype.weight * (archetype.base / 100) : 0;

  // Clamp BEFORE any guardrail deduction, so a saturated score cannot absorb
  // the penalty and present itself as indistinguishable from a clean one.
  return {
    contentBase,
    archetype,
    archetypeBonus,
    contentPre: clamp(contentBase + archetypeBonus, 0, 100)
  };
}

/**
 * Score one item for one catalog definition.
 * Returns { score, reason } - score is null when the item does not belong in
 * the row, and reason names why.
 */
export function scoreItem(policy, def, item, personalized) {
  const dna = item.dna;
  const config = def.dna || {};

  if (!dnaEligible(policy, item)) return { score: null, reason: "dna_ineligible" };
  if (hardExcluded(policy, dna)) return { score: null, reason: "hard_excluded" };

  // UNKNOWN IS NEVER ZERO: every dimension this row uses must be measured.
  const missing = requiredFor(policy, def).filter(d => !isKnown(dna, d));
  if (missing.length) return { score: null, reason: `missing_required:${missing.sort().join(",")}` };

  // Gate evaluation keeps the defensive F2-6 semantics (unknown => false), but
  // by here every gate dimension is in the required set and therefore known.
  if (config.gate && !evalRule(config.gate, dna)) return { score: null, reason: "row_gate" };

  const points = guardrailPoints(policy, dna);
  let pre;

  if (config.mode === "baseline_profile") {
    const personal = personalized?.get(item.imdb_id);
    if (personal) {
      const { content_fit, execution_fit } = policy.contentVsExecution;
      pre = content_fit * personal.dna_match + execution_fit * personal.execution_fit;
    } else {
      pre = baselineContentPre(policy, item, config.archetype_bonus_max).contentPre;
    }
  } else {
    pre = weightedBase(dna, config.weights, config.penalties);
  }

  const score = Math.round(clamp(pre - points, 0, 100));
  if (Number.isFinite(def.min_score) && score < def.min_score) return { score: null, reason: "below_min_score" };
  return { score, reason: null };
}
