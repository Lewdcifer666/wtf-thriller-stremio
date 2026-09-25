const CINEMETA = "https://v3-cinemeta.strem.io";

const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 5;


// The seed-id map and the User-Agent are the only per-addon values in this
// file, so they live in the generated ./known-ids.mjs and this module stays
// vendored verbatim. A new addon starts with an empty map: seeds exist only so
// a Cinemeta outage cannot block an already-known catalog from building, and a
// fresh repo has nothing to protect yet.
import { KNOWN_IMDB_IDS, USER_AGENT } from "./known-ids.mjs";


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


export function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[²]/g, "2")
    .replace(/&/g, "and")
    .replace(/[^a-zA-Z0-9+]+/g, " ")
    .trim()
    .toLowerCase();
}


export function yearFromMeta(meta) {
  const text = String(
    meta?.releaseInfo ||
    meta?.released ||
    ""
  );

  const match = text.match(
    /(19|20)\d{2}/
  );

  return match
    ? Number(match[0])
    : null;
}


function itemKey(item) {
  const type =
    item.type === "series"
      ? "series"
      : "movie";

  return (
    `${type}:` +
    `${normalizeTitle(item.title)}:` +
    `${item.year}`
  );
}


function titleMatches(name, item) {
  const wanted = [
    item.title,
    ...(Array.isArray(item.aliases) ? item.aliases : [])
  ].filter(value => typeof value === "string").map(normalizeTitle).filter(Boolean);

  return wanted.includes(
    normalizeTitle(name)
  );
}


function chooseBest(metas, item) {
  // A wrong IMDb id changes the public identity permanently. Search rank,
  // a shared release year, or a title with a conflicting year cannot verify it.
  // Collect distinct exact identities across the title and explicit aliases;
  // ambiguity stays unresolved instead of picking whichever result came first.
  if (!Number.isInteger(item.year)) return null;
  const exact = new Map();
  for (const meta of metas) {
    if (!meta || typeof meta.id !== "string" || !/^tt\d+$/.test(meta.id)) continue;
    if (meta.type && meta.type !== item.type) continue;
    if (!titleMatches(meta.name, item) || yearFromMeta(meta) !== item.year) continue;
    if (!exact.has(meta.id)) exact.set(meta.id, meta);
  }
  return exact.size === 1 ? exact.values().next().value : null;
}


function shouldRetryStatus(status) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}


function retryDelay(attempt) {
  /*
   * 1 -> 1000 ms
   * 2 -> 2000 ms
   * 3 -> 4000 ms
   * 4 -> 8000 ms
   * 5 -> 8000 ms max
   */
  return Math.min(
    1000 * (2 ** (attempt - 1)),
    8000
  );
}


async function fetchJsonOnce(
  url,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal,

          headers: {
            "User-Agent":
              USER_AGENT,

            "Accept":
              "application/json"
          }
        }
      );


    if (!response.ok) {
      const error =
        new Error(
          `HTTP ${response.status}`
        );

      error.status =
        response.status;

      throw error;
    }


    return await response.json();

  } finally {
    clearTimeout(timer);
  }
}


async function fetchJson(
  url,
  timeoutMs = REQUEST_TIMEOUT_MS
) {
  let lastError = null;


  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      return await fetchJsonOnce(
        url,
        timeoutMs
      );

    } catch (error) {
      lastError = error;

      const aborted =
        error?.name ===
        "AbortError";

      const retryableHttp =
        typeof error?.status ===
          "number" &&
        shouldRetryStatus(
          error.status
        );

      const networkFailure =
        error instanceof TypeError;


      const retryable =
        aborted ||
        retryableHttp ||
        networkFailure;


      if (
        !retryable ||
        attempt ===
          MAX_ATTEMPTS
      ) {
        break;
      }


      const delay =
        retryDelay(attempt);


      console.warn(
        `Cinemeta request failed ` +
        `(attempt ${attempt}/${MAX_ATTEMPTS}): ` +
        `${error.message}. ` +
        `Retrying in ${delay} ms...`
      );


      await sleep(delay);
    }
  }


  throw lastError ||
    new Error(
      "Unknown Cinemeta request failure"
    );
}


function resolveFromKnownIds(item) {
  const id =
    KNOWN_IMDB_IDS.get(
      itemKey(item)
    );


  if (!id) {
    return null;
  }


  return {
    ...item,

    imdb_id:
      id,

    canonical_title:
      item.title,

    resolved_year:
      item.year,

    resolved_at:
      new Date().toISOString(),

    resolved_via:
      "known-id-fallback"
  };
}


export async function resolveItem(item) {
  /*
   * Already resolved.
   */
  if (
    item.imdb_id &&
    /^tt\d+$/.test(
      item.imdb_id
    )
  ) {
    return item;
  }


  /*
   * First use our verified fallback table.
   *
   * This prevents temporary Cinemeta failures from
   * blocking known seed/reference titles.
   */
  const known =
    resolveFromKnownIds(item);


  if (known) {
    return known;
  }


  const type =
    item.type === "series"
      ? "series"
      : "movie";


  const queries = [...new Set([
    item.title,
    ...(Array.isArray(item.aliases) ? item.aliases : [])
  ].filter(value => typeof value === "string" && normalizeTitle(value)))];


  let lastError = null;
  const candidates = [];


  for (const query of queries) {
    try {
      const url =
        `${CINEMETA}` +
        `/catalog/${type}` +
        `/top/search=` +
        `${encodeURIComponent(query)}` +
        `.json`;


      const json =
        await fetchJson(url);


      candidates.push(...(Array.isArray(json?.metas) ? json.metas : []));

    } catch (error) {
      lastError = error;


      console.warn(
        `Cinemeta query failed for ` +
        `"${query}": ` +
        `${error.message}`
      );
    }
  }


  const chosen = chooseBest(candidates, item);
  if (chosen) {
    return {
      ...item,
      imdb_id: chosen.id,
      canonical_title: chosen.name,
      resolved_year: yearFromMeta(chosen),
      resolved_at: new Date().toISOString(),
      resolved_via: "cinemeta"
    };
  }


  throw new Error(
    `${item.type}:` +
    `${item.title} ` +
    `(${item.year}) ` +
    `could not be resolved` +
    (
      lastError
        ? ` — ${lastError.message}`
        : ""
    )
  );
}
