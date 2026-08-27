// Catalog row ordering.
//
// Extracted from build-site.mjs so it can be tested directly: build-site.mjs
// does its work at module scope, so importing it would run a build.
//
// The ordering contract, in priority order:
//
//   1. the row's own score      (dna_score rows) or match_score
//   2. match_score              (dna_score rows, as a secondary)
//   3. tie_break_rank           <- soft METADATA preference, see below
//   4. recency, then title, then imdb id, so the order is fully deterministic

/**
 * A soft METADATA preference, deliberately outside Content DNA.
 *
 * It exists so a profile can express something like "all else equal, prefer a
 * title with this lead actor" WITHOUT that preference ever touching a DNA
 * value, an eligibility decision or a score.
 *
 * It is reached only once every score comparison above it has already returned
 * equal. So it can reorder two equally-fitting titles and nothing else: it can
 * never lift a title over min_score, never cancel a guardrail, never rescue a
 * hard-excluded title, and never outrank a title that simply scored higher.
 *
 * The mechanism is generic. WHICH items carry a rank, and why, is a per-profile
 * policy decision that lives in that addon's profile and prompt - never here.
 */
export function tieBreak(a, b) {
  return (b.tie_break_rank || 0) - (a.tie_break_rank || 0);
}

export function sortItems(def, items, dnaScoreFor) {
  return [...items].sort((a, b) => {
    if (def.sort === "dna_score") {
      return (dnaScoreFor(def, b) || 0) - (dnaScoreFor(def, a) || 0)
        || (b.match_score || 0) - (a.match_score || 0)
        || tieBreak(a, b)
        || Date.parse(b.added_at || 0) - Date.parse(a.added_at || 0)
        || a.title.localeCompare(b.title)
        || String(a.imdb_id || "").localeCompare(String(b.imdb_id || ""));
    }

    // "newest" is a recency feed and is deliberately left alone: a metadata
    // preference has no business reordering what is presented as chronological.
    if (def.sort === "newest") {
      return Date.parse(b.added_at || 0) - Date.parse(a.added_at || 0)
        || (b.match_score || 0) - (a.match_score || 0);
    }

    return (b.match_score || 0) - (a.match_score || 0)
      || tieBreak(a, b)
      || Date.parse(b.added_at || 0) - Date.parse(a.added_at || 0)
      || a.title.localeCompare(b.title);
  });
}
