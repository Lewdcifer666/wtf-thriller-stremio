import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { finalizeResearch, writeFinalized, loadFinalizerInputs } from '../scripts/finalize-research.mjs';
import { validatePublication } from '../scripts/validate-publication.mjs';
import { makePolicy, scoreItem } from '../scripts/dna-score.mjs';
import { fixture, clone, options, inFixture } from './fixtures/research/helpers.mjs';
const { inputs, packet, candidate } = fixture();
const finalize = (p = packet, i = inputs, o = options) => finalizeResearch(p, i, o);
const result = finalize();
assert.equal(result.log.accepted, 1);
const expectedScore = scoreItem(makePolicy(inputs.profile), inputs.catalogs.catalogs.find(c => c.id === 'dna-match'), candidate, new Map()).score;
assert.equal(result.discovery.items[0].match_score, expectedScore);
assert.equal(result.log.accepted_items[0].match_score, expectedScore);
assert.equal(result.discovery.timestamp, result.log.timestamp);
assert.equal(result.discovery.items[0].added_at, result.log.timestamp);
assert.deepEqual(finalize(), result);
const zero = finalize({ ...packet, candidates: [], research_rejections: [{ title: 'Unknown', reason: 'Insufficient evidence' }] });
assert.equal(zero.discovery, null); assert.equal(zero.log.searched, 1); assert.equal(zero.log.rejected, 1);
assert.equal(finalize({ ...packet, candidates: [candidate, candidate] }).log.duplicates, 1);
assert.equal(finalize(packet, { ...inputs, publicItems: [candidate] }).log.duplicates, 1);
const alias = { ...candidate, imdb_id: 'tt123123123' };
assert.equal(finalize(packet, { ...inputs, publicItems: [alias] }).log.duplicates, 1);
assert.equal(finalize(packet, { ...inputs, rejections: [alias] }).log.rejected, 1);
const poor = clone(packet); Object.keys(poor.candidates[0].dna).forEach(d => { poor.candidates[0].dna[d] = 0; });
assert.equal(finalize(poor).log.accepted, 0);
const lowConfidence = clone(packet); lowConfidence.candidates[0].dna_confidence = 0;
assert.equal(finalize(lowConfidence).log.accepted, 0);
const missing = clone(packet); missing.candidates[0].dna[Object.keys(inputs.profile.dna_baseline.weights)[0]] = null;
assert.equal(finalize(missing, { ...inputs, research: { ...inputs.research, require_all_known: false } }).log.accepted, 0);
const many = { ...packet, candidates: Array.from({ length: 12 }, (_, n) => ({ ...clone(candidate), title: `Test ${String(n).padStart(2, '0')}`, imdb_id: `tt999998${n}`, type: n < 7 ? 'movie' : 'series' })) };
const capped = finalize(many);
assert.equal(capped.log.accepted, Math.min(7, inputs.profile.automation_rules.daily_movie_max) + Math.min(5, inputs.profile.automation_rules.daily_series_max));
const reordered = finalize({ ...many, candidates: [...many.candidates].reverse() });
assert.deepEqual(reordered.discovery, capped.discovery);
assert.deepEqual(reordered.log.accepted_items, capped.log.accepted_items);
assert.deepEqual(reordered.log.rejection_summary, capped.log.rejection_summary);
assert.equal(capped.log.searched, capped.log.accepted + capped.log.rejected + capped.log.duplicates);
assert.equal(finalize(packet, inputs, { ...options, reservedRunIds: [result.log.run_id] }).log.run_id, `2020-01-02-${inputs.research.run_prefix}2`);
assert.throws(() => finalize(packet, { ...inputs, logs: [result.log] }), /already merged/);
const watchedProfile = clone(inputs.profile);
// Preserve the profile's evidence weights; add only a synthetic watched record.
if (watchedProfile.baseline_evidence?.items?.length) {
  watchedProfile.baseline_evidence.items.push({ title: candidate.title, type: candidate.type, year: candidate.year, imdb_id: candidate.imdb_id,
    scope: 'title', evidence_type: 'watched', evidence_class: 'watched_like', reaction: 'like', recommendable: false,
    notes: ['Synthetic fixture'], watched_confirmation: 'Explicit confirmation in this test fixture.' });
  assert.equal(finalize(packet, { ...inputs, profile: watchedProfile }).log.rejection_summary[0].reason, 'watched');
}
await inFixture(async root => {
  const actualInputs = loadFinalizerInputs(root);
  const finalized = finalize(packet, actualInputs);
  const personalFile = path.join(root, 'data/personalized-scores.json');
  const personal = fs.existsSync(personalFile) ? fs.readFileSync(personalFile) : null;
  await writeFinalized(root, finalized);
  assert.deepEqual(validatePublication(root, { now: Math.max(options.now, Date.now()) }), []);
  await assert.rejects(writeFinalized(root, finalized), /immutable overwrite/);
  const logFile = path.join(root, 'data/run-logs', finalized.log.run_id + '.json');
  const original = fs.readFileSync(logFile);
  const bad = clone(finalized.log); bad.accepted_items[0].match_score--;
  fs.writeFileSync(logFile, JSON.stringify(bad));
  assert.ok(validatePublication(root, { now: Math.max(options.now, Date.now()) }).some(e => /score disagreement/.test(e)));
  fs.writeFileSync(logFile, original);
  assert.ok(validatePublication(root, { now: Date.parse(finalized.log.timestamp) - 1 }).some(e => /future/.test(e)));
  if (personal) assert.deepEqual(fs.readFileSync(personalFile), personal);
  else assert.equal(fs.existsSync(personalFile), false);
});
await inFixture(async root => {
  // A dormant but still fresh snapshot must not spring to life when its first
  // applicable title is published. A learning cutover must authorize this.
  fs.writeFileSync(path.join(root, 'data/personalized-scores.json'), JSON.stringify({ schema_version: 1,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), items: { [candidate.imdb_id]: { dna_match: 80, execution_fit: 80 } } }));
  const snapshot = fs.readFileSync(path.join(root, 'data/personalized-scores.json'));
  const finalized = finalize(packet, loadFinalizerInputs(root));
  await assert.rejects(writeFinalized(root, finalized), /activate dormant personalization/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'data/personalized-scores.json')), snapshot);
});
console.log('Finalization: scoring, counts, exclusions, ordering, limits, immutability and snapshot preservation passed');
