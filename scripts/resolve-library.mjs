import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTitle, resolveItem } from "./cinemeta.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const file = path.join(root, "data", "library.json");
const data = JSON.parse(fs.readFileSync(file, "utf8"));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const resolved = [];
let changed = false;
let failures = 0;

for (let i = 0; i < data.items.length; i++) {
  const item = data.items[i];
  if (item.imdb_id && /^tt\d+$/.test(item.imdb_id)) {
    resolved.push(item);
    continue;
  }

  try {
    const next = await resolveItem(item);
    resolved.push(next);
    changed = true;
    console.log(`[${i + 1}/${data.items.length}] OK ${item.type}: ${item.title} (${item.year}) -> ${next.imdb_id}`);
  } catch (error) {
    failures++;
    resolved.push(item);
    console.warn(`[${i + 1}/${data.items.length}] UNRESOLVED ${error.message}`);
  }
  await sleep(120);
}

function fallbackKey(item) {
  return `${item.type}:${normalizeTitle(item.title)}:${item.year}`;
}

const byKey = new Map();
for (const item of resolved) {
  const key = item.imdb_id ? `${item.type}:${item.imdb_id}` : fallbackKey(item);
  if (!byKey.has(key)) {
    byKey.set(key, item);
    continue;
  }

  const old = byKey.get(key);
  const merged = {
    ...old,
    ...item,
    status: old.status === "seen" || item.status === "seen" ? "seen" : "watch",
    preference: old.preference || item.preference || null,
    tags: [...new Set([...(old.tags || []), ...(item.tags || [])])],
    aliases: [...new Set([...(old.aliases || []), ...(item.aliases || [])])],
    reason: [old.reason, item.reason].filter(Boolean).filter((v, idx, arr) => arr.indexOf(v) === idx).join(" | "),
    match_score: Math.max(old.match_score || 0, item.match_score || 0) || null,
    added_at: old.added_at < item.added_at ? old.added_at : item.added_at
  };
  byKey.set(key, merged);
  changed = true;
  console.log(`DEDUPED ${key}`);
}

data.items = [...byKey.values()].sort((a, b) => {
  if (a.status !== b.status) return a.status === "watch" ? -1 : 1;
  if (a.type !== b.type) return a.type.localeCompare(b.type);
  return (a.rank ?? 999999) - (b.rank ?? 999999) || a.title.localeCompare(b.title);
});
data.updated_at = new Date().toISOString();

if (changed) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

console.log(`Resolution complete: ${data.items.length - failures}/${data.items.length} resolved or already known; ${failures} unresolved.`);
