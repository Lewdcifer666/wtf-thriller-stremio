import assert from 'node:assert/strict';
import { validateResearchPacket, berlinDate } from '../scripts/validate-research-packet.mjs';
import { fixture, clone, options } from './fixtures/research/helpers.mjs';
const { inputs, packet } = fixture();
const check = (value, context = inputs) => validateResearchPacket(value, { ...context, now: options.now });
assert.deepEqual(check(packet), []);
for (const field of ['match_score', 'timestamp', 'added_at', 'run_id', 'searched', 'accepted', 'policy_fingerprint', 'pull_request']) {
  const top = clone(packet); top[field] = 1;
  assert.ok(check(top).length, field);
  const item = clone(packet); item.candidates[0][field] = 1;
  assert.ok(check(item).length, field);
}
for (const value of [-1, 11, 1.5, '9', true]) {
  const bad = clone(packet); bad.candidates[0].dna[Object.keys(bad.candidates[0].dna)[0]] = value;
  assert.ok(check(bad).length);
}
const nullable = clone(packet);
nullable.candidates[0].dna[Object.keys(nullable.candidates[0].dna)[0]] = null;
assert.deepEqual(check(nullable, { ...inputs, research: { ...inputs.research, require_all_known: false } }), []);
assert.ok(check(nullable, { ...inputs, research: { ...inputs.research, require_all_known: true } }).length);
const invalid = mutator => { const p = clone(packet); mutator(p); assert.ok(check(p).length); };
invalid(p => { p.candidates[0].dna.invented = 5; });
invalid(p => { p.candidates[0].dna_tags = ['invented']; });
invalid(p => { p.candidates[0].tags = ['invented']; });
invalid(p => { p.candidates[0].imdb_id = 'kitsu:55'; });
invalid(p => { p.candidates[0].sources[1].url = p.candidates[0].sources[0].url + '#different-fragment'; });
invalid(p => { p.candidates[0].sources[0].url = 'file:///tmp/payload'; });
invalid(p => { p.candidates[0].sources[0].command = 'shell'; });
invalid(p => { p.genre = 'wrong'; });
invalid(p => { p.research_date = '2026-02-30'; });
invalid(p => { p.research_date = '2099-01-01'; });
const three = { ...inputs, research: { ...inputs.research, minimum_sources: 3 } };
const few = clone(packet); few.candidates[0].sources = few.candidates[0].sources.slice(0, 2);
assert.ok(check(few, three).length);
const byHost = { ...inputs, research: { ...inputs.research, blocked_source_hosts: ['youtube.com'], required_source_hosts_by_type: { series: ['tvmaze.com'] } } };
const series = clone(packet); series.candidates[0].type = 'series';
series.candidates[0].sources = series.candidates[0].sources.filter(source => !new URL(source.url).hostname.endsWith('tvmaze.com'));
assert.ok(check(series, byHost).some(error => error.includes('requires a source from tvmaze.com')));
series.candidates[0].sources.push({ url: 'https://www.tvmaze.com/shows/123/episodes', purpose: 'whole_runtime' });
assert.deepEqual(check(series, byHost), []);
for (const spoof of ['https://tvmaze.com.example.org/episodes', 'https://example.org/tvmaze.com', 'https://not-tvmaze.com/episodes']) {
  const badHost = clone(series); badHost.candidates[0].sources.at(-1).url = spoof;
  assert.ok(check(badHost, byHost).some(error => error.includes('requires a source from tvmaze.com')));
}
const trailer = clone(packet); trailer.candidates[0].sources[0].url = 'https://www.youtube.com/watch?v=fixture';
assert.ok(check(trailer, byHost).some(error => error.includes('not permitted')));
trailer.candidates[0].sources[0].url = 'https://example.org/review?reference=youtube.com';
assert.deepEqual(check(trailer, byHost), []);
assert.ok(check(packet, { ...inputs, research: { ...inputs.research, blocked_source_hosts: ['https://youtube.com'] } }).length);
const unresolved = clone(packet); unresolved.candidates = []; unresolved.research_rejections = [{ title: 'Unknown', imdb_id: null, reason: 'Identity cannot be established' }];
assert.deepEqual(check(unresolved), []);
assert.equal(berlinDate(Date.parse('2026-10-01T22:30:00Z')), '2026-10-02');
assert.equal(berlinDate(Date.parse('2026-12-01T23:30:00Z')), '2026-12-02');
console.log('Research packet: closed fields, sources, identity, nullability and Berlin dates passed');
