import assert from "node:assert/strict";
import { resolveItem } from "../scripts/cinemeta.mjs";

const source = { title: "Audit Target", year: 2024, type: "movie" };
const meta = (id, name = source.title, releaseInfo = "2024", extra = {}) => ({ id, name, releaseInfo, ...extra });
const originalFetch = globalThis.fetch;
let passed = 0;

async function resolves(name, item, replies, expected) {
  const queue = [...replies];
  globalThis.fetch = async () => {
    assert.ok(queue.length, "unexpected network request");
    return { ok: true, json: async () => ({ metas: queue.shift() }) };
  };
  try {
    if (expected === null) {
      await assert.rejects(resolveItem(item), /could not be resolved/);
    } else {
      const result = await resolveItem(item);
      assert.equal(result.imdb_id, expected);
      assert.equal(result.resolved_year, item.year);
      assert.equal(result.resolved_via, "cinemeta");
    }
    assert.equal(queue.length, 0, "all explicit aliases must be checked for conflicting identities");
    passed++;
    console.log(`  ok   ${name}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await resolves("unrelated title with matching year remains unresolved", source,
  [[meta("tt9000001", "Unrelated title")]], null);
await resolves("same title with conflicting year remains unresolved", source,
  [[meta("tt9000002", source.title, "1999")]], null);
await resolves("one-year disagreement requires identity review", source,
  [[meta("tt9000003", source.title, "2023")]], null);
await resolves("same title without a year remains unresolved", source,
  [[{ id: "tt9000004", name: source.title }]], null);
await resolves("wrong media type remains unresolved", source,
  [[meta("tt9000005", source.title, "2024", { type: "series" })]], null);
await resolves("two exact identities remain unresolved", source,
  [[meta("tt9000006"), meta("tt9000007")]], null);
await resolves("invalid IMDb ids cannot resolve", source,
  [[meta("kitsu:9000008"), meta("not-imdb")]], null);
await resolves("exact title and year resolve despite unrelated search results", source,
  [[meta("tt9000009", "Unrelated title"), meta("tt9000010")]], "tt9000010");
await resolves("normalization preserves explicit title identity", { ...source, title: "Audít & Target" },
  [[meta("tt9000011", "Audit and Target")]], "tt9000011");
await resolves("an explicit alias and exact year resolve", { ...source, aliases: ["Alternate Name"] },
  [[], [meta("tt9000012", "Alternate Name")]], "tt9000012");
await resolves("duplicate responses for the same IMDb identity are unambiguous", { ...source, aliases: ["Alternate Name"] },
  [[meta("tt9000013")], [meta("tt9000013", "Alternate Name")]], "tt9000013");
await resolves("conflicting exact alias result cannot overwrite or bypass ambiguity", { ...source, aliases: ["Alternate Name"] },
  [[meta("tt9000014")], [meta("tt9000015", "Alternate Name")]], null);

const alreadyResolved = { ...source, imdb_id: "tt9000016" };
globalThis.fetch = async () => { throw new Error("verified identity must not be searched"); };
try {
  assert.equal(await resolveItem(alreadyResolved), alreadyResolved);
  passed++;
} finally {
  globalThis.fetch = originalFetch;
}
console.log(`Cinemeta resolution: ${passed} offline cases passed.`);
