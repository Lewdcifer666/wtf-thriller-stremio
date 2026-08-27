// Validation contract for data/taste-profile.json.
//
// schema_version has an EXCLUSIVE meaning. There is no hybrid state:
//
//   schema 2 - dna_dimensions, dna_baseline, dna_guardrails and
//              execution_preferences MUST ALL be absent.
//   schema 3 - all four MUST be present and are validated strictly.
//
// Unknown-key handling is CLOSED and RECURSIVE for every authored DNA
// configuration object: an unrecognised key is a hard failure, so a typo such
// as "scientfic_investigation" or "requires_mod" fails loudly instead of being
// silently ignored. The pre-schema-3 sections keep their existing permissive
// behaviour; tightening those is deliberately out of scope.
//
// THIS FILE IS GENRE-NEUTRAL AND VENDORED VERBATIM into every addon repo.
// The frozen registry it checks against is NOT here - it lives in the
// per-repo ./registry.mjs, which the generator writes once from that addon's own
// profile. The guard is exactly as strong as it was when the list was inline:
// the declared registry must equal the frozen list EXACTLY. What changed is
// only that each addon freezes its own vocabulary instead of sharing one.

import { CANONICAL_DIMENSIONS, CANONICAL_DNA_TAGS, SLOW_TO_FAST_DIMENSION } from "./registry.mjs";

export { CANONICAL_DIMENSIONS, CANONICAL_DNA_TAGS, SLOW_TO_FAST_DIMENSION };

export const SUPPORTED_SCHEMA_VERSIONS = [2, 3];
export const DNA_SECTIONS = ["dna_dimensions", "dna_baseline", "dna_guardrails", "execution_preferences"];

const ID_RE = /^[a-z0-9_]{1,64}$/;
const RUBRIC_ANCHORS = ["0", "3", "5", "8", "10"];
const REQUIRED_RUBRIC_ANCHORS = ["0", "5", "10"];

export function validateProfile(profile) {
  const errs = [];
  if (!isPlainObject(profile)) return ["profile must be an object"];

  // ---- schema version -----------------------------------------------------
  const sv = profile.schema_version;
  if (!Number.isInteger(sv)) {
    errs.push("schema_version must be an integer");
    return errs;
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(sv)) {
    errs.push(`unsupported schema_version ${sv} (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`);
    return errs;
  }

  // ---- exclusive structure ------------------------------------------------
  if (sv === 2) {
    for (const section of DNA_SECTIONS) {
      if (has(profile, section)) errs.push(`schema_version 2 must not contain ${section}`);
    }
  } else {
    for (const section of DNA_SECTIONS) {
      if (!has(profile, section)) errs.push(`schema_version 3 requires ${section}`);
    }
  }

  validateLegacySections(profile, errs);
  validateBaselineEvidence(profile.baseline_evidence, errs);
  if (sv !== 3 || DNA_SECTIONS.some(s => !has(profile, s))) return errs;

  const registryIds = validateDimensions(profile.dna_dimensions, errs);
  const guardrailDims = validateGuardrails(profile.dna_guardrails, registryIds, errs);
  validateBaseline(profile.dna_baseline, registryIds, guardrailDims, errs);
  validateExecutionPreferences(profile.execution_preferences, errs);
  return errs;
}

// ---------------------------------------------------------------------------
// Pre-schema-3 sections. Existing behaviour, plus explicit guards so a future
// edit that empties a production-consumed field fails loudly.
// ---------------------------------------------------------------------------
function validateLegacySections(profile, errs) {
  const tags = profile.controlled_tags;
  if (!Array.isArray(tags) || tags.length === 0) errs.push("controlled_tags must be a non-empty array");
  else if (!tags.every(t => typeof t === "string")) errs.push("controlled_tags entries must be strings");

  const rules = profile.automation_rules;
  if (!isPlainObject(rules)) {
    errs.push("automation_rules must be an object");
    return;
  }
  for (const key of ["minimum_match_score", "best_match_score"]) {
    if (!isFiniteNumber(rules[key])) errs.push(`automation_rules.${key} must be a finite number`);
  }
}

// ---------------------------------------------------------------------------
// dna_dimensions
// ---------------------------------------------------------------------------
function validateDimensions(section, errs) {
  const ids = new Set();
  if (!isPlainObject(section)) {
    errs.push("dna_dimensions must be an object");
    return ids;
  }

  strictKeys(section, "dna_dimensions",
    ["registry_version", "count", "scale", "principles", "tag_registry", "dimensions"],
    ["tag_registry_note"], errs);

  if (!Number.isInteger(section.registry_version) || section.registry_version < 1) {
    errs.push("dna_dimensions.registry_version must be an integer >= 1");
  }

  // scale
  if (!isPlainObject(section.scale)) {
    errs.push("dna_dimensions.scale must be an object");
  } else {
    strictKeys(section.scale, "dna_dimensions.scale", ["min", "max", "integer", "unknown"], [], errs);
    if (section.scale.min !== 0) errs.push("dna_dimensions.scale.min must be 0");
    if (section.scale.max !== 10) errs.push("dna_dimensions.scale.max must be 10");
    if (section.scale.integer !== true) errs.push("dna_dimensions.scale.integer must be true");
    if (section.scale.unknown !== null) errs.push("dna_dimensions.scale.unknown must be null");
  }

  // principles
  const principleKeys = ["descriptive_only", "unknown_is_not_zero", "unknown_never_satisfies", "unknown_is_not_safe", "independent_dimensions"];
  if (!isPlainObject(section.principles)) {
    errs.push("dna_dimensions.principles must be an object");
  } else {
    strictKeys(section.principles, "dna_dimensions.principles", principleKeys, [], errs);
    for (const key of principleKeys) {
      if (!isNonEmptyString(section.principles[key])) errs.push(`dna_dimensions.principles.${key} must be a non-empty string`);
    }
  }

  validateTagRegistry(section.tag_registry, errs);

  // dimensions
  if (!Array.isArray(section.dimensions)) {
    errs.push("dna_dimensions.dimensions must be an array");
    return ids;
  }

  let slowToFast = [];
  for (const [i, dim] of section.dimensions.entries()) {
    const at = `dna_dimensions.dimensions[${i}]`;
    if (!isPlainObject(dim)) { errs.push(`${at} must be an object`); continue; }
    strictKeys(dim, at, ["id", "label", "direction", "rubric"], [], errs);

    if (typeof dim.id !== "string" || !ID_RE.test(dim.id)) errs.push(`${at}.id must match ${ID_RE}`);
    else if (ids.has(dim.id)) errs.push(`${at}.id duplicate dimension '${dim.id}'`);
    else ids.add(dim.id);

    if (!isNonEmptyString(dim.label)) errs.push(`${at}.label must be a non-empty string`);

    if (dim.direction !== "absent_to_dominant" && dim.direction !== "slow_to_fast") {
      errs.push(`${at}.direction must be 'absent_to_dominant' or 'slow_to_fast'`);
    } else if (dim.direction === "slow_to_fast") {
      slowToFast.push(dim.id);
    }

    if (!isPlainObject(dim.rubric)) {
      errs.push(`${at}.rubric must be an object`);
    } else {
      strictKeys(dim.rubric, `${at}.rubric`, [], RUBRIC_ANCHORS, errs);
      for (const anchor of REQUIRED_RUBRIC_ANCHORS) {
        if (!has(dim.rubric, anchor)) errs.push(`${at}.rubric is missing required anchor "${anchor}"`);
      }
      for (const [anchor, textValue] of Object.entries(dim.rubric)) {
        if (!isNonEmptyString(textValue)) errs.push(`${at}.rubric["${anchor}"] must be a non-empty string`);
      }
    }
  }

  if (slowToFast.length !== 1 || slowToFast[0] !== SLOW_TO_FAST_DIMENSION) {
    errs.push(`exactly one dimension may be slow_to_fast and it must be ${SLOW_TO_FAST_DIMENSION} (found: ${slowToFast.join(", ") || "none"})`);
  }

  // the id set must equal this repo's frozen registry EXACTLY
  reportSetDifference(ids, new Set(CANONICAL_DIMENSIONS), "dna_dimensions.dimensions", "dimension", errs);

  if (!Number.isInteger(section.count) || section.count !== section.dimensions.length) {
    errs.push(`dna_dimensions.count must equal dimensions.length (${section.dimensions.length})`);
  } else if (section.count !== CANONICAL_DIMENSIONS.length) {
    errs.push(`dna_dimensions.count must be ${CANONICAL_DIMENSIONS.length}`);
  }

  return ids;
}

function validateTagRegistry(registry, errs) {
  if (!Array.isArray(registry)) {
    errs.push("dna_dimensions.tag_registry must be an array");
    return;
  }
  const seen = new Set();
  for (const [i, tag] of registry.entries()) {
    if (typeof tag !== "string") { errs.push(`dna_dimensions.tag_registry[${i}] must be a string`); continue; }
    if (!ID_RE.test(tag)) errs.push(`dna_dimensions.tag_registry[${i}] '${tag}' must match ${ID_RE}`);
    if (seen.has(tag)) errs.push(`dna_dimensions.tag_registry has duplicate tag '${tag}'`);
    seen.add(tag);
  }
  reportSetDifference(seen, new Set(CANONICAL_DNA_TAGS), "dna_dimensions.tag_registry", "tag", errs);
}

// ---------------------------------------------------------------------------
// dna_guardrails
// ---------------------------------------------------------------------------
function validateGuardrails(section, registryIds, errs) {
  const referenced = new Set();
  if (!isPlainObject(section)) {
    errs.push("dna_guardrails must be an object");
    return referenced;
  }

  strictKeys(section, "dna_guardrails", ["hard_exclusion", "combination"],
    ["description", "structural_note", "evaluation_note", "not_expressible_in_dna"], errs);

  const ids = new Set();

  // hard_exclusion: exclusion only, never a penalty
  if (!Array.isArray(section.hard_exclusion)) {
    errs.push("dna_guardrails.hard_exclusion must be an array");
  } else {
    for (const [i, rule] of section.hard_exclusion.entries()) {
      const at = `dna_guardrails.hard_exclusion[${i}]`;
      if (!isPlainObject(rule)) { errs.push(`${at} must be an object`); continue; }
      if (has(rule, "penalty")) errs.push(`${at} must not carry a penalty (hard exclusions are exclusion-only)`);
      // Same grammar as combination conditions and row gates: EXACTLY ONE of
      // at_or_above / at_or_below. Some profiles exclude on a value being too
      // high, others on it being too low; both are structural exclusions.
      strictKeys(rule, at, ["id", "dimension"], ["at_or_above", "at_or_below", "note"], errs);
      checkRuleId(rule.id, at, ids, errs);
      checkDimensionRef(rule.dimension, at, registryIds, referenced, errs);
      const above = has(rule, "at_or_above");
      const below = has(rule, "at_or_below");
      if (above && below) errs.push(`${at} must carry exactly one of at_or_above / at_or_below, not both`);
      else if (!above && !below) errs.push(`${at} must carry exactly one of at_or_above / at_or_below`);
      if (above) checkThreshold(rule.at_or_above, `${at}.at_or_above`, errs);
      if (below) checkThreshold(rule.at_or_below, `${at}.at_or_below`, errs);
    }
  }

  // combination: penalty only, never an exclusion
  if (!Array.isArray(section.combination)) {
    errs.push("dna_guardrails.combination must be an array");
  } else {
    for (const [i, rule] of section.combination.entries()) {
      const at = `dna_guardrails.combination[${i}]`;
      if (!isPlainObject(rule)) { errs.push(`${at} must be an object`); continue; }
      for (const forbidden of ["exclude", "excludes", "hard", "hard_exclude"]) {
        if (has(rule, forbidden)) errs.push(`${at} must not carry '${forbidden}' (combination rules are penalty-only)`);
      }
      strictKeys(rule, at, ["id", "penalty", "all_of", "any_of"], ["note"], errs);
      checkRuleId(rule.id, at, ids, errs);

      if (!Number.isInteger(rule.penalty) || rule.penalty < -100 || rule.penalty > -1) {
        errs.push(`${at}.penalty must be an integer -100..-1`);
      }

      if (!Array.isArray(rule.all_of) || rule.all_of.length === 0) {
        errs.push(`${at}.all_of must be a non-empty array`);
      } else {
        rule.all_of.forEach((c, j) => checkCondition(c, `${at}.all_of[${j}]`, registryIds, referenced, errs));
      }

      if (!Array.isArray(rule.any_of)) {
        errs.push(`${at}.any_of must be an array (may be empty)`);
      } else {
        rule.any_of.forEach((c, j) => checkCondition(c, `${at}.any_of[${j}]`, registryIds, referenced, errs));
      }
    }
  }

  // not_expressible_in_dna is documentation-only and carries no runtime semantics
  if (has(section, "not_expressible_in_dna")) {
    const doc = section.not_expressible_in_dna;
    const at = "dna_guardrails.not_expressible_in_dna";
    if (!isPlainObject(doc)) {
      errs.push(`${at} must be an object`);
    } else {
      strictKeys(doc, at, ["documentation_only", "consumer_rule", "entries"], [], errs);
      if (doc.documentation_only !== true) errs.push(`${at}.documentation_only must be true`);
      if (!isNonEmptyString(doc.consumer_rule)) errs.push(`${at}.consumer_rule must be a non-empty string`);
      if (!Array.isArray(doc.entries)) {
        errs.push(`${at}.entries must be an array`);
      } else {
        for (const [i, entry] of doc.entries.entries()) {
          const eAt = `${at}.entries[${i}]`;
          if (!isPlainObject(entry)) { errs.push(`${eAt} must be an object`); continue; }
          strictKeys(entry, eAt, ["signal", "reason"], [], errs);
          if (!isNonEmptyString(entry.signal)) errs.push(`${eAt}.signal must be a non-empty string`);
          if (!isNonEmptyString(entry.reason)) errs.push(`${eAt}.reason must be a non-empty string`);
        }
      }
    }
  }

  return referenced;
}

function checkRuleId(id, at, ids, errs) {
  if (typeof id !== "string" || !ID_RE.test(id)) { errs.push(`${at}.id must match ${ID_RE}`); return; }
  if (ids.has(id)) errs.push(`${at}.id duplicate guardrail id '${id}'`);
  ids.add(id);
}

function checkCondition(condition, at, registryIds, referenced, errs) {
  if (!isPlainObject(condition)) { errs.push(`${at} must be an object`); return; }
  strictKeys(condition, at, ["dimension"], ["at_or_above", "at_or_below"], errs);
  checkDimensionRef(condition.dimension, at, registryIds, referenced, errs);

  const above = has(condition, "at_or_above");
  const below = has(condition, "at_or_below");
  if (above && below) errs.push(`${at} must carry exactly one of at_or_above / at_or_below, not both`);
  else if (!above && !below) errs.push(`${at} must carry exactly one of at_or_above / at_or_below`);
  if (above) checkThreshold(condition.at_or_above, `${at}.at_or_above`, errs);
  if (below) checkThreshold(condition.at_or_below, `${at}.at_or_below`, errs);
}

function checkThreshold(value, at, errs) {
  if (!Number.isInteger(value) || value < 0 || value > 10) errs.push(`${at} must be an integer 0..10`);
}

function checkDimensionRef(id, at, registryIds, referenced, errs) {
  if (typeof id !== "string") { errs.push(`${at}.dimension must be a string`); return; }
  if (!registryIds.has(id)) { errs.push(`${at}.dimension references unknown dimension '${id}'`); return; }
  if (referenced) referenced.add(id);
}

// ---------------------------------------------------------------------------
// dna_baseline
// ---------------------------------------------------------------------------
function validateBaseline(section, registryIds, guardrailDims, errs) {
  if (!isPlainObject(section)) {
    errs.push("dna_baseline must be an object");
    return;
  }

  strictKeys(section, "dna_baseline", ["weights", "unweighted", "completeness_defaults", "archetypes"],
    ["description", "scale_note", "unweighted_note", "archetype_note"], errs);

  // weights
  const weighted = new Set();
  if (!isPlainObject(section.weights)) {
    errs.push("dna_baseline.weights must be an object");
  } else {
    for (const [id, weight] of Object.entries(section.weights)) {
      if (!registryIds.has(id)) { errs.push(`dna_baseline.weights references unknown dimension '${id}'`); continue; }
      weighted.add(id);
      if (!Number.isInteger(weight) || weight < -40 || weight > 40) {
        errs.push(`dna_baseline.weights.${id} must be an integer -40..40`);
      }
    }
  }

  // unweighted
  const unweighted = new Set();
  if (!Array.isArray(section.unweighted)) {
    errs.push("dna_baseline.unweighted must be an array");
  } else {
    for (const id of section.unweighted) {
      if (typeof id !== "string" || !registryIds.has(id)) { errs.push(`dna_baseline.unweighted references unknown dimension '${id}'`); continue; }
      if (unweighted.has(id)) errs.push(`dna_baseline.unweighted has duplicate '${id}'`);
      unweighted.add(id);
    }
  }

  // coverage: disjoint, and together exactly the registry
  for (const id of weighted) {
    if (unweighted.has(id)) errs.push(`dimension '${id}' appears in both dna_baseline.weights and dna_baseline.unweighted`);
  }
  const covered = new Set([...weighted, ...unweighted]);
  for (const id of registryIds) {
    if (!covered.has(id)) errs.push(`dimension '${id}' is in neither dna_baseline.weights nor dna_baseline.unweighted`);
  }

  const required = validateCompleteness(section.completeness_defaults, registryIds, guardrailDims, errs);

  // ARCHETYPE COMPLETENESS.
  //
  // requiredFor() in dna-score.mjs adds the baseline weights and the profile's
  // required_known_dimensions - it does NOT add archetype emphasis/penalise
  // dimensions. But bestArchetype() reads them through valueOf(), which THROWS
  // on an unknown value. An archetype that emphasises a dimension outside
  // weights u required_known therefore crashes the site build on the first item
  // that has not measured it, instead of degrading.
  //
  // So every dimension an archetype touches must be one the scorer is already
  // guaranteed to have. This cannot be checked inside validateArchetypes alone
  // because it needs the weights and the completeness set together.
  const measurable = new Set([...weighted, ...required]);
  validateArchetypes(section.archetypes, registryIds, measurable, errs);
}

function validateCompleteness(section, registryIds, guardrailDims, errs) {
  const at = "dna_baseline.completeness_defaults";
  if (!isPlainObject(section)) {
    errs.push(`${at} must be an object`);
    return new Set();
  }

  strictKeys(section, at, ["min_known_dimensions", "min_confidence", "required_known_dimensions"], ["note"], errs);

  if (!Number.isInteger(section.min_known_dimensions) || section.min_known_dimensions < 0 || section.min_known_dimensions > CANONICAL_DIMENSIONS.length) {
    errs.push(`${at}.min_known_dimensions must be an integer 0..${CANONICAL_DIMENSIONS.length}`);
  }
  if (!isFiniteNumber(section.min_confidence) || section.min_confidence < 0 || section.min_confidence > 1) {
    errs.push(`${at}.min_confidence must be a number 0.0..1.0`);
  }

  const required = new Set();
  if (!Array.isArray(section.required_known_dimensions)) {
    errs.push(`${at}.required_known_dimensions must be an array`);
    return required;
  }
  for (const id of section.required_known_dimensions) {
    if (typeof id !== "string" || !registryIds.has(id)) { errs.push(`${at}.required_known_dimensions references unknown dimension '${id}'`); continue; }
    if (required.has(id)) errs.push(`${at}.required_known_dimensions has duplicate '${id}'`);
    required.add(id);
  }

  // Unknown must never mean "safe". Every dimension referenced ANYWHERE in
  // dna_guardrails - hard_exclusion, combination all_of and combination any_of
  // alike - must be known before an item is DNA-score-eligible, so that no item
  // can pass a structural guardrail or dodge a combination penalty simply
  // because the relevant dimension was never measured.
  for (const id of guardrailDims) {
    if (!required.has(id)) {
      errs.push(`${at}.required_known_dimensions is missing '${id}', which dna_guardrails references`);
    }
  }

  if (required.size > 0 && Number.isInteger(section.min_known_dimensions) && section.min_known_dimensions < required.size) {
    errs.push(`${at}.min_known_dimensions (${section.min_known_dimensions}) is below required_known_dimensions.length (${required.size})`);
  }

  return required;
}

function validateArchetypes(list, registryIds, measurable, errs) {
  if (!Array.isArray(list) || list.length === 0) {
    errs.push("dna_baseline.archetypes must be a non-empty array");
    return;
  }

  const ids = new Set();
  for (const [i, arch] of list.entries()) {
    const at = `dna_baseline.archetypes[${i}]`;
    if (!isPlainObject(arch)) { errs.push(`${at} must be an object`); continue; }

    strictKeys(arch, at, ["id", "label", "weight", "requires_mode", "requires", "emphasis"], ["penalise"], errs);

    if (typeof arch.id !== "string" || !ID_RE.test(arch.id)) errs.push(`${at}.id must match ${ID_RE}`);
    else if (ids.has(arch.id)) errs.push(`${at}.id duplicate archetype id '${arch.id}'`);
    else ids.add(arch.id);

    if (!isNonEmptyString(arch.label)) errs.push(`${at}.label must be a non-empty string`);

    if (!isFiniteNumber(arch.weight) || arch.weight < 0.1 || arch.weight > 2.0) {
      errs.push(`${at}.weight must be a number 0.1..2.0`);
    }

    // requires_mode is mandatory and has no default: a typo or omission must
    // never silently change an archetype's matching semantics.
    if (arch.requires_mode !== "all" && arch.requires_mode !== "any") {
      errs.push(`${at}.requires_mode is required and must be 'all' or 'any'`);
    }

    if (!Array.isArray(arch.requires) || arch.requires.length === 0) {
      errs.push(`${at}.requires must be a non-empty array`);
    } else {
      let positive = 0;
      for (const [j, cond] of arch.requires.entries()) {
        const cAt = `${at}.requires[${j}]`;
        if (!isPlainObject(cond)) { errs.push(`${cAt} must be an object`); continue; }
        strictKeys(cond, cAt, ["dimension", "at_or_above"], [], errs);
        checkDimensionRef(cond.dimension, cAt, registryIds, null, errs);
        checkThreshold(cond.at_or_above, `${cAt}.at_or_above`, errs);
        if (Number.isInteger(cond.at_or_above) && cond.at_or_above >= 1) positive++;
      }
      if (positive === 0) errs.push(`${at}.requires must contain at least one positive requirement (at_or_above >= 1)`);
    }

    checkDimensionScoreMap(arch.emphasis, `${at}.emphasis`, registryIds, true, errs);
    if (has(arch, "penalise")) checkDimensionScoreMap(arch.penalise, `${at}.penalise`, registryIds, true, errs);

    for (const [key, map] of [["emphasis", arch.emphasis], ["penalise", arch.penalise]]) {
      if (!isPlainObject(map)) continue;
      for (const id of Object.keys(map)) {
        if (registryIds.has(id) && !measurable.has(id)) {
          errs.push(`${at}.${key} references '${id}', which is neither weighted nor in ` +
            `dna_baseline.completeness_defaults.required_known_dimensions; bestArchetype() would ` +
            `throw on any item that has not measured it`);
        }
      }
    }
  }
}

function checkDimensionScoreMap(map, at, registryIds, requireNonEmpty, errs) {
  if (!isPlainObject(map)) { errs.push(`${at} must be an object`); return; }
  const entries = Object.entries(map);
  if (requireNonEmpty && entries.length === 0) { errs.push(`${at} must not be empty`); return; }
  for (const [id, value] of entries) {
    if (!registryIds.has(id)) { errs.push(`${at} references unknown dimension '${id}'`); continue; }
    if (!Number.isInteger(value) || value < 1 || value > 10) errs.push(`${at}.${id} must be an integer 1..10`);
  }
}

// ---------------------------------------------------------------------------
// execution_preferences
// ---------------------------------------------------------------------------
function validateExecutionPreferences(section, errs) {
  const at = "execution_preferences";
  if (!isPlainObject(section)) {
    errs.push(`${at} must be an object`);
    return;
  }

  strictKeys(section, at, ["content_vs_execution", "evidence_ladder", "rules"], ["description"], errs);

  const split = section.content_vs_execution;
  if (!isPlainObject(split)) {
    errs.push(`${at}.content_vs_execution must be an object`);
  } else {
    strictKeys(split, `${at}.content_vs_execution`, ["content_fit", "execution_fit"], [], errs);
    let ok = true;
    for (const key of ["content_fit", "execution_fit"]) {
      if (!isFiniteNumber(split[key]) || split[key] < 0 || split[key] > 1) {
        errs.push(`${at}.content_vs_execution.${key} must be a number 0..1`);
        ok = false;
      }
    }
    if (ok && Math.abs(split.content_fit + split.execution_fit - 1) > 1e-9) {
      errs.push(`${at}.content_vs_execution must sum to 1.0`);
    }
  }

  const ladder = section.evidence_ladder;
  if (!isPlainObject(ladder)) {
    errs.push(`${at}.evidence_ladder must be an object`);
  } else {
    strictKeys(ladder, `${at}.evidence_ladder`, ["weak", "emerging", "meaningful"], [], errs);
    let ok = true;
    for (const key of ["weak", "emerging", "meaningful"]) {
      if (!Number.isInteger(ladder[key]) || ladder[key] < 1 || ladder[key] > 10) {
        errs.push(`${at}.evidence_ladder.${key} must be an integer 1..10`);
        ok = false;
      }
    }
    if (ok && !(ladder.weak < ladder.emerging && ladder.emerging < ladder.meaningful)) {
      errs.push(`${at}.evidence_ladder must be strictly increasing (weak < emerging < meaningful)`);
    }
  }

  if (!Array.isArray(section.rules) || section.rules.length === 0) {
    errs.push(`${at}.rules must be a non-empty array`);
  } else if (!section.rules.every(isNonEmptyString)) {
    errs.push(`${at}.rules entries must be non-empty strings`);
  }
}

// ---------------------------------------------------------------------------
// baseline_evidence
//
// The audit trail for how a profile's weights were derived: which titles the
// user actually watched and how they reacted, versus which they have only seen
// a trailer for. It is OPTIONAL and it is NOT read at runtime by dna-score.mjs
// - the authored weights, archetypes and guardrails ARE the encoding of this
// evidence. It exists so the derivation is auditable and testable.
//
// Two rules carry real product meaning and are enforced rather than trusted:
//
//   AN UNWATCHED TITLE IS NEVER A FAVOURITE. A trailer reaction may not claim
//   the strength of something actually watched. evidence_type decides which
//   classes and reactions are even spellable.
//
//   RECOMMENDABILITY FOLLOWS WATCHED-NESS, NOT MEMBERSHIP. A watched title must
//   never be recommended again. An UNWATCHED one stays fully eligible - it just
//   has to earn its place through ordinary research and scoring like any other
//   candidate. Being cited as evidence is neither a ban nor a shortcut.
//
//   WATCHED REQUIRES EXPLICIT CONFIRMATION, AND IS NEVER INFERRED. Citing a
//   title as a structural taste anchor does NOT mean it was watched. Neither do
//   trailers, clips, snippets, partial exposure, franchise familiarity, or a
//   confident-sounding "probably liked". Marking a title watched permanently
//   removes it from recommendation, so an inferred watch silently deletes
//   something the user may actively want to see.
//
//   That is a research judgement no validator can verify - it cannot know what
//   the user confirmed. What it CAN do is refuse to accept the claim silently:
//   every watched entry must carry a non-empty watched_confirmation recording
//   HOW watching was established. If that sentence cannot be written honestly,
//   the entry is not watched. Uncertainty resolves to UNWATCHED.
// ---------------------------------------------------------------------------
export const EVIDENCE_CLASSES = {
  watched_favorite: { direction: "positive", evidence_type: "watched" },
  watched_love:     { direction: "positive", evidence_type: "watched" },
  watched_like:     { direction: "positive", evidence_type: "watched" },
  watched_mixed:    { direction: "mixed",    evidence_type: "watched" },
  watched_dislike:  { direction: "negative", evidence_type: "watched" },
  trailer_interest: { direction: "positive", evidence_type: "unwatched" },
  trailer_aversion: { direction: "negative", evidence_type: "unwatched" }
};
const WATCHED_REACTIONS = ["love", "like", "mixed", "dislike"];
const UNWATCHED_REACTIONS = ["interested", "uncertain", "unappealing"];
const IMDB_ID_RE = /^tt\d+$/;

export function validateBaselineEvidence(section, errs) {
  const at = "baseline_evidence";
  if (section === undefined) return;               // optional
  if (!isPlainObject(section)) { errs.push(`${at} must be an object`); return; }

  strictKeys(section, at, ["schema_version", "evidence_weights", "items"], ["description", "note"], errs);
  if (section.schema_version !== 1) errs.push(`${at}.schema_version must be 1`);

  // ---- weights: explicit direction, unsigned magnitude ----
  const magnitude = new Map();
  const weights = section.evidence_weights;
  if (!isPlainObject(weights)) {
    errs.push(`${at}.evidence_weights must be an object`);
  } else {
    strictKeys(weights, `${at}.evidence_weights`, Object.keys(EVIDENCE_CLASSES), [], errs);
    for (const [id, spec] of Object.entries(weights)) {
      const wAt = `${at}.evidence_weights.${id}`;
      const canonical = EVIDENCE_CLASSES[id];
      if (!canonical) continue;
      if (!isPlainObject(spec)) { errs.push(`${wAt} must be an object`); continue; }
      strictKeys(spec, wAt, ["direction", "magnitude"], [], errs);
      if (spec.direction !== canonical.direction) {
        errs.push(`${wAt}.direction must be '${canonical.direction}'`);
      }
      if (!isFiniteNumber(spec.magnitude) || spec.magnitude < 0 || spec.magnitude > 1) {
        errs.push(`${wAt}.magnitude must be an unsigned number 0.0..1.0 (direction carries the sign)`);
        continue;
      }
      magnitude.set(id, spec.magnitude);
    }

    // mixed evidence moves nothing on its own
    if (magnitude.has("watched_mixed") && magnitude.get("watched_mixed") !== 0) {
      errs.push(`${at}.evidence_weights.watched_mixed.magnitude must be exactly 0 (mixed evidence moves nothing on its own)`);
    }

    // A trailer must never weigh as much as having actually watched something.
    const watched = [...magnitude].filter(([id]) => EVIDENCE_CLASSES[id].evidence_type === "watched" && magnitude.get(id) > 0);
    const trailer = [...magnitude].filter(([id]) => EVIDENCE_CLASSES[id].evidence_type === "unwatched");
    for (const [tId, tMag] of trailer) {
      for (const [wId, wMag] of watched) {
        if (tMag >= wMag) {
          errs.push(`${at}.evidence_weights.${tId} (${tMag}) must be strictly weaker than ${wId} (${wMag}); ` +
            `trailer interest is a weak prior and may never rival watched evidence`);
        }
      }
    }
  }

  // ---- items ----
  if (!Array.isArray(section.items)) { errs.push(`${at}.items must be an array`); return; }

  for (const [i, item] of section.items.entries()) {
    const iAt = `${at}.items[${i}] ${item && item.title ? item.title : "?"}`;
    if (!isPlainObject(item)) { errs.push(`${iAt} must be an object`); continue; }
    strictKeys(item, iAt,
      ["title", "type", "scope", "evidence_type", "evidence_class", "reaction", "recommendable", "notes"],
      ["year", "imdb_id", "franchise_members", "watched_confirmation"], errs);

    if (!isNonEmptyString(item.title)) errs.push(`${iAt}.title must be a non-empty string`);
    if (item.type !== "movie" && item.type !== "series") errs.push(`${iAt}.type must be 'movie' or 'series'`);
    if (!Array.isArray(item.notes) || !item.notes.every(isNonEmptyString)) {
      errs.push(`${iAt}.notes must be an array of non-empty strings`);
    }
    if (has(item, "imdb_id") && !IMDB_ID_RE.test(item.imdb_id)) errs.push(`${iAt}.imdb_id must be a tt id`);

    const klass = EVIDENCE_CLASSES[item.evidence_class];
    if (!klass) {
      errs.push(`${iAt}.evidence_class must be one of: ${Object.keys(EVIDENCE_CLASSES).join(", ")}`);
    } else if (item.evidence_type !== klass.evidence_type) {
      errs.push(`${iAt}.evidence_class '${item.evidence_class}' requires evidence_type '${klass.evidence_type}', got '${item.evidence_type}'`);
    }

    if (item.evidence_type !== "watched" && item.evidence_type !== "unwatched") {
      errs.push(`${iAt}.evidence_type must be 'watched' or 'unwatched'`);
    } else {
      const allowed = item.evidence_type === "watched" ? WATCHED_REACTIONS : UNWATCHED_REACTIONS;
      if (!allowed.includes(item.reaction)) {
        errs.push(`${iAt}.reaction must be one of: ${allowed.join(", ")} (for evidence_type '${item.evidence_type}')`);
      }

      // WATCHED IS A CLAIM AND MUST BE ACCOUNTED FOR.
      //
      // Marking a title watched bans it from recommendation forever, so the
      // author has to say how that was established. An inferred watch - from a
      // taste anchor, a franchise, a trailer or a vague memory - cannot produce
      // an honest sentence here, which is the point.
      if (item.evidence_type === "watched") {
        if (!isNonEmptyString(item.watched_confirmation)) {
          errs.push(`${iAt}.watched_confirmation is required on a watched entry: state how watching was ` +
            `EXPLICITLY confirmed. Citing a title as a taste anchor, knowing the franchise, or seeing ` +
            `trailers, clips or snippets is NOT watching. If you cannot write this honestly, the entry ` +
            `is evidence_type 'unwatched' - uncertainty resolves to unwatched, because a wrong watch ` +
            `permanently hides something the user may want to see.`);
        }
      } else if (has(item, "watched_confirmation")) {
        errs.push(`${iAt}.watched_confirmation is only valid on a watched entry`);
      }

      // RECOMMENDABILITY IS DERIVED, NEVER AUTHORED FREELY.
      const shouldRecommend = item.evidence_type === "unwatched";
      if (item.recommendable !== shouldRecommend) {
        errs.push(`${iAt}.recommendable must be ${shouldRecommend} for evidence_type '${item.evidence_type}' ` +
          (shouldRecommend
            ? "(an unwatched title stays fully eligible and must earn its place by normal research and scoring)"
            : "(a watched title must never be recommended again)"));
      }
    }

    // Identity is needed to enforce the watched-exclusion mechanically.
    if (item.scope === "title") {
      if (!Number.isInteger(item.year)) {
        errs.push(`${iAt}.year is required on a scope 'title' entry so its public identity can be computed`);
      }
      if (has(item, "franchise_members")) errs.push(`${iAt}.franchise_members is only valid on scope 'franchise'`);
    } else if (item.scope === "franchise") {
      if (has(item, "year")) errs.push(`${iAt}.year is not meaningful on a franchise; put years on franchise_members`);
      if (!Array.isArray(item.franchise_members) || item.franchise_members.length === 0) {
        errs.push(`${iAt}.franchise_members must be a non-empty array; a franchise cannot be identity-keyed as a ` +
          `unit, so without members the watched-exclusion is aspirational rather than mechanical`);
      } else {
        for (const [j, member] of item.franchise_members.entries()) {
          const mAt = `${iAt}.franchise_members[${j}]`;
          if (!isPlainObject(member)) { errs.push(`${mAt} must be an object`); continue; }
          strictKeys(member, mAt, ["title", "year"], ["imdb_id"], errs);
          // Franchise membership NEVER propagates watched status. Every member
          // listed here is an individual claim that THAT installment was
          // watched, and each one is individually banned from recommendation.
          if (!isNonEmptyString(member.title)) errs.push(`${mAt}.title must be a non-empty string`);
          if (!Number.isInteger(member.year)) errs.push(`${mAt}.year must be an integer`);
          if (has(member, "imdb_id") && !IMDB_ID_RE.test(member.imdb_id)) errs.push(`${mAt}.imdb_id must be a tt id`);
        }
      }
    } else {
      errs.push(`${iAt}.scope must be 'title' or 'franchise'`);
    }
  }
}

/**
 * Every public identity a WATCHED evidence entry stands for, as {type,title,year,imdb_id}
 * shapes ready for identityKey(). Franchise entries expand to their members.
 * Unwatched entries contribute NOTHING here - they stay recommendable.
 */
export function watchedEvidenceIdentities(profile) {
  const out = [];
  for (const item of profile?.baseline_evidence?.items || []) {
    if (item.evidence_type !== "watched") continue;
    if (item.scope === "franchise") {
      for (const member of item.franchise_members || []) {
        out.push({ type: item.type, title: member.title, year: member.year, imdb_id: member.imdb_id });
      }
    } else {
      out.push({ type: item.type, title: item.title, year: item.year, imdb_id: item.imdb_id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Item-level Content DNA (populated by F2-7; entirely optional until then).
//
// A missing dna block is LEGAL - enrichment is incremental by design. When a
// block is present it is validated against the registry the profile declares:
// dimension ids and dna_tags are both closed vocabularies, so a typo such as
// "research_staton" fails instead of silently becoming new metadata.
// ---------------------------------------------------------------------------
export function validateItemDna(item, dimensionIds, tagIds) {
  const errs = [];
  if (!isPlainObject(item)) return errs;
  if (!has(item, "dna") && !has(item, "dna_confidence") && !has(item, "dna_tags")) return errs;

  if (dimensionIds.size === 0) {
    errs.push("carries DNA fields but taste-profile.json declares no dna_dimensions registry");
    return errs;
  }

  if (has(item, "dna")) {
    const dna = item.dna;
    if (!isPlainObject(dna)) {
      errs.push("dna must be an object");
    } else {
      for (const [id, value] of Object.entries(dna)) {
        if (!dimensionIds.has(id)) { errs.push(`dna has unknown dimension '${id}'`); continue; }
        if (value === null) continue;
        if (!Number.isInteger(value) || value < 0 || value > 10) errs.push(`dna.${id} must be an integer 0..10 or null`);
      }
    }
  }

  if (has(item, "dna_confidence")) {
    const c = item.dna_confidence;
    if (!isFiniteNumber(c) || c < 0 || c > 1) errs.push("dna_confidence must be a number 0.0..1.0");
  }

  if (has(item, "dna_tags")) {
    const list = item.dna_tags;
    if (!Array.isArray(list)) {
      errs.push("dna_tags must be an array");
    } else {
      const seen = new Set();
      for (const tag of list) {
        if (typeof tag !== "string") { errs.push("dna_tags entries must be strings"); continue; }
        if (!tagIds.has(tag)) { errs.push(`dna_tags has unknown tag '${tag}'`); continue; }
        if (seen.has(tag)) errs.push(`dna_tags has duplicate tag '${tag}'`);
        seen.add(tag);
      }
    }
  }

  return errs;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function strictKeys(obj, at, required, optional, errs) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errs.push(`${at} has unknown key '${key}'`);
  }
  for (const key of required) {
    if (!has(obj, key)) errs.push(`${at} is missing required key '${key}'`);
  }
}

function reportSetDifference(actual, expected, at, noun, errs) {
  for (const id of actual) if (!expected.has(id)) errs.push(`${at} has unknown ${noun} '${id}'`);
  for (const id of expected) if (!actual.has(id)) errs.push(`${at} is missing ${noun} '${id}'`);
}

function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function isNonEmptyString(v) { return typeof v === "string" && v.length > 0; }
function isFiniteNumber(v) { return typeof v === "number" && Number.isFinite(v); }
