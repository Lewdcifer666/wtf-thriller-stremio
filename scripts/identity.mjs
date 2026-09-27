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

// Only a real media type and usable identity may enter an eligibility gate.
// In particular, identityKey({}) is a string, not proof of a valid identity.
export function validatedIdentityKey(item, normalizeTitle) {
  if (!item || typeof item !== "object" || Array.isArray(item)
      || !["movie", "series"].includes(item.type)) return null;
  if (item.imdb_id !== undefined && item.imdb_id !== null && item.imdb_id !== "") {
    return typeof item.imdb_id === "string" && /^tt\d+$/.test(item.imdb_id)
      ? `${item.type}:${item.imdb_id}` : null;
  }
  if (typeof item.title !== "string" || !normalizeTitle(item.title)
      || !Number.isInteger(item.year)) return null;
  return identityKey(item, normalizeTitle);
}

// Exclusions carry both forms so the same title cannot bypass a rejection
// merely by omitting its IMDb id. The canonical public key remains unchanged.
export function identityForms(item, normalizeTitle) {
  if (!item || typeof item !== "object" || Array.isArray(item)
      || !["movie", "series"].includes(item.type)) return [];
  const forms = [];
  if (typeof item.imdb_id === "string" && /^tt\d+$/.test(item.imdb_id)) {
    forms.push(`${item.type}:${item.imdb_id}`);
  }
  if (typeof item.title === "string" && normalizeTitle(item.title)
      && Number.isInteger(item.year)) {
    forms.push(`${item.type}:${normalizeTitle(item.title)}:${item.year}`);
  }
  return forms;
}
