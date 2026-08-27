// Reader for the optional data/personalized-scores.json (F2-8).
//
// The file is a SANITISED DERIVED SNAPSHOT: two integers per IMDb id and
// nothing else. Its schema is CLOSED, so a field that should never have been
// written - a rating, an aspect, a feedback id, free text - is rejected before
// its value is ever read, and therefore can never reach a catalog description
// or any other generated output.
//
// Failure is deliberately two-tier:
//   file-level violation  -> ignore the WHOLE file, every title falls back to
//                            its stable baseline DNA score
//   item-level violation  -> ignore THAT item only, keep the rest of the file
//
// In every case the site still builds. A missing file is the normal state
// until F2-9 generates the real one, and is not a warning.

export const PERSONALIZED_SCHEMA_VERSION = 1;
export const FRESHNESS_MAX_AGE_MS = 72 * 60 * 60 * 1000;   // tolerate two missed daily runs
export const FRESHNESS_FUTURE_SKEW_MS = 60 * 60 * 1000;    // allow an hour of clock skew

const TOP_LEVEL_KEYS = ["schema_version", "generated_at", "items"];
const ITEM_KEYS = ["dna_match", "execution_fit"];
const IMDB_RE = /^tt\d+$/;
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const sameKeys = (obj, allowed) => {
  const keys = Object.keys(obj);
  return keys.length === allowed.length && allowed.every(k => Object.prototype.hasOwnProperty.call(obj, k));
};
const isScore = v => Number.isInteger(v) && v >= 0 && v <= 100;

/**
 * @returns {{ items: Map<string,{dna_match:number,execution_fit:number}>,
 *             status: string, rejectedItems: number }}
 * status is one of: applied | absent | unreadable | invalid_json |
 *                   bad_shape | unsupported_schema | bad_timestamp | stale | future
 */
export function readPersonalizedScores(fs, file, now = Date.now()) {
  const empty = status => ({ items: new Map(), status, rejectedItems: 0 });

  if (!fs.existsSync(file)) return empty("absent");

  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return empty("unreadable"); }

  let payload;
  try { payload = JSON.parse(text); }
  catch { return empty("invalid_json"); }

  if (!isPlainObject(payload) || !sameKeys(payload, TOP_LEVEL_KEYS)) return empty("bad_shape");
  if (payload.schema_version !== PERSONALIZED_SCHEMA_VERSION) return empty("unsupported_schema");

  if (typeof payload.generated_at !== "string" || !UTC_ISO_RE.test(payload.generated_at)) return empty("bad_timestamp");
  const generated = Date.parse(payload.generated_at);
  if (!Number.isFinite(generated)) return empty("bad_timestamp");
  const age = now - generated;
  if (age < -FRESHNESS_FUTURE_SKEW_MS) return empty("future");
  if (age > FRESHNESS_MAX_AGE_MS) return empty("stale");

  if (!isPlainObject(payload.items)) return empty("bad_shape");

  const items = new Map();
  let rejectedItems = 0;
  for (const [id, entry] of Object.entries(payload.items)) {
    if (!IMDB_RE.test(id)) { rejectedItems++; continue; }
    if (!isPlainObject(entry) || !sameKeys(entry, ITEM_KEYS)) { rejectedItems++; continue; }
    if (!isScore(entry.dna_match) || !isScore(entry.execution_fit)) { rejectedItems++; continue; }
    items.set(id, { dna_match: entry.dna_match, execution_fit: entry.execution_fit });
  }

  return { items, status: "applied", rejectedItems };
}
