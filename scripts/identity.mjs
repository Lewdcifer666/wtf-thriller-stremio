// The one definition of a public source identity.
//
// A title may appear exactly once across data/library.json and every
// data/discoveries/*.json. That is the canonical automation contract: an
// already-known title must never be re-added as a new discovery.
//
// Identity is the IMDb id when there is a usable one, otherwise the normalized
// title plus year plus type. Both the validator and the site builder key off
// this function so they can never disagree about what counts as the same title.

export function identityKey(item, normalizeTitle) {
  return item.imdb_id && /^tt\d+$/.test(item.imdb_id)
    ? `${item.type}:${item.imdb_id}`
    : `${item.type}:${normalizeTitle(item.title)}:${item.year}`;
}
