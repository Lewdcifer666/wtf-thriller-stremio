import fs from "node:fs";
import path from "node:path";
import { validateProfile, validateItemDna, watchedEvidenceIdentities } from "./validate-profile.mjs";
import { normalizeTitle } from "./cinemeta.mjs";
import { identityKey } from "./identity.mjs";
import { makePolicy, evalCondition, exclusionCondition } from "./dna-score.mjs";

const library = JSON.parse(fs.readFileSync("data/library.json", "utf8"));
const profile = JSON.parse(fs.readFileSync("data/taste-profile.json", "utf8"));

const profileErrors = validateProfile(profile);
for (const message of profileErrors) console.error(`taste-profile.json: ${message}`);

// SOURCE PROVENANCE.
//
// `reason` is the human-readable explanation shown on the catalog card.
// `source` is something different and is easy to confuse with it: it must
// identify the MATERIAL the research actually rested on, so that a DNA
// fingerprint can be audited months later by someone who was not there.
//
// A prose evidence summary is NOT provenance. "Sustained combat across short
// episodes" restates a conclusion; it does not say where the conclusion came
// from, and it cannot be checked. This validator therefore requires at least
// one real HTTP(S) URL and rejects prose that merely sounds like justification.
//
// It deliberately does NOT try to judge whether a URL supports the DNA values.
// That is a research-quality responsibility and no validator can carry it. What
// it can do is make an unsupported claim impossible to ship silently.
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

// A REPEATED CITATION IS NOT A SECOND SOURCE.
//
// Counting URLs rather than distinct documents lets a source field look
// well-researched while resting on one page. That is not hypothetical: it
// happened, produced by a lookup that silently redirected to an article
// already cited, and it survived review because the count was right.
//
// Normalisation is deliberately shallow. The fragment is dropped, because
// #one and #two address the same document. Everything else - host, path,
// query - is compared as-is. Two different pages on the same host stay two
// sources, which is the common and legitimate case (an article and its
// episode list). This is not a URL-equivalence engine and must not become
// one: it exists to catch the obvious duplicate, and whether two genuinely
// different pages say anything genuinely different remains a research
// responsibility no validator can discharge.
export function normalizeSourceUrl(href) {
  const url = new URL(href);
  url.hash = "";
  return url.href;
}

export function distinctSourceUrls(value) {
  return [...new Set(sourceUrls(value).map(normalizeSourceUrl))];
}

export function sourceUrls(value) {
  if (typeof value !== "string") return [];
  // Split on separators only. Prose words simply fail to parse as URLs and are
  // dropped, so "some prose https://example.com/x" still yields one real URL.
  return value.split(/[;,\s]+/).flatMap(token => {
    let url;
    try { url = new URL(token.trim()); } catch { return []; }
    if (!HTTP_PROTOCOLS.has(url.protocol)) return [];
    // A bare "https://localhost" or "https://x" is not an auditable citation.
    if (!url.hostname.includes(".") || url.hostname.startsWith(".") || url.hostname.endsWith(".")) return [];
    return [url.href];
  });
}

// SECONDARY EXTERNAL IDS - OPTIONAL AND DELIBERATELY INERT.
//
// Some catalogues (anime especially) are indexed elsewhere under ids this
// system does not use. Recording one is useful for later work; letting it near
// the identity model is not.
//
// IMDb remains the ONE canonical public identity. Nothing here reaches
// identityKey(), duplicate detection, the Stremio id, poster routing, Cinemeta
// resolution, Content-DNA scoring, match_score, catalog membership or sorting -
// and that inertness is asserted by tests rather than assumed.
//
// The vocabulary is CLOSED, so a typo or a speculative new namespace fails
// loudly instead of quietly becoming schema. Widening it is a deliberate
// decision, not a side effect of one item needing somewhere to put a value.
export const SUPPORTED_EXTERNAL_ID_NAMESPACES = ["kitsu"];

const validTypes = new Set(["movie", "series"]);
const validStatus = new Set(["watch", "seen"]);
const tags = new Set(profile.controlled_tags);
const all = [...(library.items || [])];
const origin = new Map(all.map((_, i) => [i, "data/library.json"]));

const discoveryDir = path.join("data", "discoveries");
if (fs.existsSync(discoveryDir)) {
  for (const name of fs.readdirSync(discoveryDir).filter(x => x.toLowerCase().endsWith(".json")).sort()) {
    const payload = JSON.parse(fs.readFileSync(path.join(discoveryDir, name), "utf8"));
    const items = Array.isArray(payload) ? payload : (payload.items || []);
    if (!Array.isArray(items)) {
      console.error(`${name}: expected an items array`);
      process.exit(1);
    }
    for (const item of items) {
      origin.set(all.length, path.join(discoveryDir, name));
      all.push(item);
    }
  }
}

// Item-level DNA is validated against the registry the profile actually
// declares. On a schema-2 profile there is no registry, so DNA keys on items
// are reported rather than silently accepted.
const dnaDimensionIds = new Set((profile.dna_dimensions?.dimensions || []).map(d => d.id));
const dnaTagIds = new Set(profile.dna_dimensions?.tag_registry || []);

// HARD EXCLUSIONS ARE AN INGESTION GATE, NOT ONLY A SCORING GATE.
//
// hardExcluded() removes an item from DNA-scored rows, but the plain "watch"
// rows do not consult DNA at all - so a hard-excluded title would still be
// published in the Full Watchlist while being absent from every row that
// actually ranks. That is incoherent: a structural exclusion means the title
// does not belong in this addon, full stop. It must never have been accepted.
const policy = profile.dna_dimensions ? makePolicy(profile) : null;

// A WATCHED baseline-evidence title must never be recommended again.
//
// UNWATCHED evidence is deliberately NOT collected here: those titles stay
// fully eligible and may legitimately appear once they have earned it through
// ordinary research and scoring. Both identity forms are indexed because an
// evidence entry and a library item need not agree about whether an IMDb id is
// known, and the exclusion must hold either way.
function identityForms(entry) {
  const forms = [];
  if (entry.imdb_id && /^tt\d+$/.test(entry.imdb_id)) forms.push(`${entry.type}:${entry.imdb_id}`);
  if (Number.isInteger(entry.year)) forms.push(`${entry.type}:${normalizeTitle(entry.title)}:${entry.year}`);
  return forms;
}
const watchedEvidence = new Map();
for (const entry of watchedEvidenceIdentities(profile)) {
  for (const form of identityForms(entry)) {
    if (!watchedEvidence.has(form)) watchedEvidence.set(form, entry.title);
  }
}

let errors = profileErrors.length;
const seenKeys = new Map();

for (const [i, item] of all.entries()) {
  const prefix = `items[${i}] ${item.title || "?"}`;
  if (!validTypes.has(item.type)) { console.error(`${prefix}: invalid type`); errors++; }
  if (!validStatus.has(item.status)) { console.error(`${prefix}: invalid status`); errors++; }
  if (!item.title || !Number.isInteger(item.year)) { console.error(`${prefix}: missing title/year`); errors++; }
  if (item.imdb_id && !/^tt\d+$/.test(item.imdb_id)) { console.error(`${prefix}: invalid imdb_id`); errors++; }
  for (const tag of item.tags || []) if (!tags.has(tag)) { console.error(`${prefix}: unknown tag '${tag}'`); errors++; }

  for (const message of validateItemDna(item, dnaDimensionIds, dnaTagIds)) {
    console.error(`${prefix}: ${message}`);
    errors++;
  }

  if (Object.prototype.hasOwnProperty.call(item, "external_ids")) {
    const ext = item.external_ids;
    if (ext === null || typeof ext !== "object" || Array.isArray(ext)) {
      console.error(`${prefix}: external_ids must be an object`);
      errors++;
    } else {
      for (const [ns, value] of Object.entries(ext)) {
        if (!SUPPORTED_EXTERNAL_ID_NAMESPACES.includes(ns)) {
          console.error(`${prefix}: external_ids has unsupported namespace '${ns}' ` +
            `(supported: ${SUPPORTED_EXTERNAL_ID_NAMESPACES.join(", ")}). The vocabulary is closed ` +
            `so a typo cannot quietly become schema; widening it is a deliberate decision.`);
          errors++;
        } else if (typeof value !== "string" || value.trim() === "") {
          console.error(`${prefix}: external_ids.${ns} must be a non-empty string`);
          errors++;
        }
      }
      // A secondary id is a note, never an identity. If IMDb is missing, the
      // item has no canonical public identity and does not belong in public
      // data - a Kitsu id must never be used to paper over that.
      if (!item.imdb_id && Object.keys(ext).length > 0) {
        console.error(`${prefix}: carries external_ids but no imdb_id - a secondary id is inert metadata ` +
          `and can never stand in for the canonical public identity. Log the title as unresolved and skip it.`);
        errors++;
      }
    }
  }

  if (!Object.prototype.hasOwnProperty.call(item, "source")) {
    console.error(`${prefix}: missing 'source' - every public source item must cite the material its research rested on`);
    errors++;
  } else if (typeof item.source !== "string" || item.source.trim() === "") {
    console.error(`${prefix}: 'source' must be a non-empty string`);
    errors++;
  } else if (sourceUrls(item.source).length === 0) {
    console.error(`${prefix}: 'source' contains no usable http(s) URL - a prose evidence summary is not ` +
      `provenance. Put the explanation in 'reason' and cite the actual material in 'source', ` +
      `for example "https://example.org/a ; https://example.org/b".`);
    errors++;
  } else {
    const parsed = sourceUrls(item.source).map(normalizeSourceUrl);
    const seen = new Set();
    const repeated = [...new Set(parsed.filter(u => seen.has(u) ? true : (seen.add(u), false)))];
    if (repeated.length) {
      console.error(`${prefix}: 'source' cites the same document more than once (${repeated.join(", ")}). ` +
        `A repeated citation is NOT a second source - it makes a field look researched while resting ` +
        `on one page. Cite genuinely different material, or cite it once.`);
      errors++;
    }
  }

  // A soft metadata preference, never a score. Non-negative so it can only ever
  // order two already-equal titles, never express a magnitude.
  if (Object.prototype.hasOwnProperty.call(item, "tie_break_rank")
      && (!Number.isInteger(item.tie_break_rank) || item.tie_break_rank < 0)) {
    console.error(`${prefix}: tie_break_rank must be a non-negative integer`);
    errors++;
  }

  if (policy && item.dna) {
    for (const rule of policy.hardExclusions) {
      if (!evalCondition(exclusionCondition(rule), item.dna)) continue;
      const bound = Object.prototype.hasOwnProperty.call(rule, "at_or_above")
        ? `>= ${rule.at_or_above}`
        : `<= ${rule.at_or_below}`;
      console.error(`${prefix}: violates hard exclusion '${rule.id}' (${rule.dimension} ` +
        `${item.dna[rule.dimension]} is ${bound}) - a hard-excluded title must never be ingested, ` +
        `because the plain watch rows do not consult DNA and would publish it anyway`);
      errors++;
    }
  }

  for (const form of identityForms(item)) {
    if (!watchedEvidence.has(form)) continue;
    console.error(`${prefix}: '${watchedEvidence.get(form)}' is WATCHED baseline evidence ` +
      `(${form}) and must never be recommended again. Baseline anchors are taste evidence, ` +
      `not watchlist content. Unwatched evidence titles are unaffected and stay eligible.`);
    errors++;
    break;
  }

  // A public identity may exist exactly once across library.json and every
  // discovery file. This is the canonical automation contract - an already
  // known title must never be re-added as a new discovery - so it is an ERROR,
  // not a warning, even when the two copies happen to agree.
  const key = identityKey(item, normalizeTitle);
  if (seenKeys.has(key)) {
    const first = seenKeys.get(key);
    console.error(`${prefix}: duplicate public identity ${key}` +
      ` - already present as items[${first.index}] in ${first.file}; this occurrence is in ${origin.get(i)}`);
    errors++;
  } else {
    seenKeys.set(key, { index: i, file: origin.get(i) });
  }
}

if (errors) process.exit(1);
console.log(`Validation OK: ${all.length} source items.`);
