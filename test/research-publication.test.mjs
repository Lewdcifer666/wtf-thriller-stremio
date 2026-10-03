import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reconciliationState, assertResearchDiff, assertBlob, assertBundle, publish, prepare, githubClient } from '../scripts/publish-research.mjs';
import { finalizeResearch, hash, serialize } from '../scripts/finalize-research.mjs';
import { fixture, options, clone, inFixture } from './fixtures/research/helpers.mjs';
assert.equal(reconciliationState({}), 'not_started');
assert.equal(reconciliationState({ packet: true }), 'research_staged');
assert.equal(reconciliationState({ packet: true, failed: true }), 'finalization_failed');
assert.equal(reconciliationState({ packet: true, attempt: true }), 'PR_open');
assert.equal(reconciliationState({ merged: true }), 'merged');
assert.equal(reconciliationState({ merged: true, deployed: true }), 'deployed');
assert.throws(() => reconciliationState({ deployed: true }));
const packetPath = 'research-inbox/2020-01-02.json';
assertResearchDiff([{ filename: packetPath, status: 'added' }], packetPath);
for (const malicious of ['scripts/publish-research.mjs', 'package.json', 'package-lock.json', '.github/workflows/research-intake.yml', '.github/actions/validate/action.yml']) {
  assert.throws(() => assertResearchDiff([{ filename: packetPath, status: 'added' }, { filename: malicious, status: 'modified' }], packetPath), /Unauthorized/);
}
assert.throws(() => assertResearchDiff([{ filename: packetPath, status: 'renamed' }], packetPath));
assert.throws(() => assertResearchDiff([{ filename: packetPath, status: 'added' }], packetPath, true));
assert.throws(() => assertBlob({ type: 'blob', mode: '120000', size: 20 }));
assert.throws(() => assertBlob({ type: 'blob', mode: '100644', size: 1048577 }));
assert.throws(() => githubClient('owner/repo', ''), /credential/);
const { packet, inputs } = fixture();
const finalized = finalizeResearch(packet, inputs, options);
const branch = `publication/2020-01-02-${packet.genre}-1`;
const files = Object.fromEntries([
  [`data/run-logs/${finalized.log.run_id}.json`, finalized.log],
  [`data/discoveries/${finalized.log.run_id}.json`, finalized.discovery],
  ['data/automation-state.json', { schema_version: 1 }],
].map(([name, value]) => { const content = serialize(value); return [name, { content, sha256: hash(content) }]; }));
const bundle = { schema_version: 1, base: options.evaluatedBase, plans: [{ branch, run_id: finalized.log.run_id,
  accepted: finalized.log.accepted, daily_key: finalized.log.publication.daily_key, research_branch: `research/2020-01-02-${packet.genre}`,
  research_commit: options.researchCommit, reuse_sha: null, close_pr: null, files }] };
assertBundle(bundle);
const bad = clone(bundle); bad.plans[0].files['scripts/evil.mjs'] = { content: 'code', sha256: hash('code') };
assert.throws(() => assertBundle(bad), /output path/);
const badHash = clone(bundle); Object.values(badHash.plans[0].files)[0].content += ' ';
assert.throws(() => assertBundle(badHash), /digest/);
function fakeApi({ main = options.evaluatedBase, research = options.researchCommit, existing = [], refSha = 'd'.repeat(40), failAt, protectedMain = true } = {}) {
  const writes = [];
  const pr = { number: 1, node_id: 'PR_node', html_url: 'https://github.com/example/repo/pull/1', head: { ref: branch, sha: refSha }, state: 'open' };
  return { writes,
    async get(route) {
      if (route === '/branches/main') return { protected: protectedMain };
      if (route === '') return { allow_auto_merge: true };
      if (route === '/git/ref/heads/main') return { object: { sha: main } };
      if (route.startsWith('/git/ref/heads/research/')) return { object: { sha: research } };
      if (route.startsWith('/git/ref/heads/publication/')) return { object: { sha: refSha } };
      if (route.startsWith('/pulls?')) return existing;
      if (route.startsWith('/git/commits/')) return { tree: { sha: 'tree_base' } };
      throw new Error(`unexpected read ${route}`);
    },
    async post(route, body) {
      writes.push({ route, body });
      if (route === failAt) throw new Error('simulated interruption');
      if (route === '/git/trees') return { sha: 'tree_new' };
      if (route === '/git/commits') return { sha: refSha };
      if (route === '/pulls') return pr;
      return {};
    },
    async patch(route, body) { writes.push({ route, body }); return {}; },
    async graphql(query, variables) { writes.push({ query, variables }); return {}; },
  };
}
const api = fakeApi();
assert.equal((await publish(bundle, api))[0].state, 'PR_open');
assert.equal(api.writes.filter(w => w.route === '/pulls').length, 1);
assert.ok(api.writes.find(w => w.route === '/git/refs').body.ref.startsWith('refs/heads/publication/'));
assert.equal(api.writes.some(w => w.body?.ref === 'refs/heads/main'), false);
const stale = fakeApi({ main: 'e'.repeat(40) });
await assert.rejects(publish(bundle, stale), /Main changed/); assert.equal(stale.writes.length, 0);
const unprotected = fakeApi({ protectedMain: false });
await assert.rejects(publish(bundle, unprotected), /protection/); assert.equal(unprotected.writes.length, 0);
const changedPacket = fakeApi({ research: 'f'.repeat(40) });
await assert.rejects(publish(bundle, changedPacket), /Research changed/); assert.equal(changedPacket.writes.length, 0);
const retryBundle = clone(bundle); retryBundle.plans[0].reuse_sha = 'd'.repeat(40);
const existing = [{ number: 1, node_id: 'node', html_url: 'url', head: { ref: branch, sha: 'd'.repeat(40) }, state: 'open' }];
const retry = fakeApi({ existing });
await publish(retryBundle, retry);
assert.equal(retry.writes.some(w => w.route === '/pulls' || w.route === '/git/refs'), false);
assert.equal(retry.writes.filter(w => w.query?.includes('enablePullRequestAutoMerge')).length, 1);
const interrupted = fakeApi({ failAt: '/pulls' });
await assert.rejects(publish(bundle, interrupted), /interruption/);
const recovered = fakeApi(); await publish(retryBundle, recovered);
assert.equal(recovered.writes.some(w => w.route === '/git/refs'), false);
assert.equal(recovered.writes.filter(w => w.route === '/pulls').length, 1);
const changedFrozen = fakeApi({ refSha: 'e'.repeat(40) });
await assert.rejects(publish(retryBundle, changedFrozen), /Frozen publication branch changed/);
const duplicate = fakeApi({ existing: [{ number: 9, state: 'open', head: { ref: `publication/2020-01-02-${packet.genre}-9` } }] });
await assert.rejects(publish(bundle, duplicate), /active PR/);
const finalizerWorkflow = fs.readFileSync('.github/workflows/research-finalize.yml', 'utf8');
assert.match(finalizerWorkflow, /workflow_run:/);
assert.match(finalizerWorkflow, /ref: main/);
assert.match(finalizerWorkflow, /ref: \$\{\{ needs.prepare.outputs.trusted_sha \}\}/);
assert.doesNotMatch(finalizerWorkflow, /ref:.*(?:head_sha|head_branch)|actions\/cache|pull_request_target/);
assert.ok(finalizerWorkflow.indexOf('verify-bundle') < finalizerWorkflow.indexOf('actions/create-github-app-token'));
assert.match(finalizerWorkflow, /cancel-in-progress: false/);
assert.match(finalizerWorkflow, /schedule:/);
const intake = fs.readFileSync('.github/workflows/research-intake.yml', 'utf8');
assert.doesNotMatch(intake, /uses:|contents: write|secrets\./);
const deployment = fs.readFileSync('.github/workflows/deploy-pages.yml', 'utf8');
assert.doesNotMatch(deployment, /git push|repair-push-duplicates|contents: write/);
// Exercise actual durable reconciliation with disposable Git worktrees and a
// fake GitHub data store. The injected validator records pre-PR ordering; full
// validators and builds are exercised by the other integration suites.
await inFixture(async root => {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('add', '.'); git('commit', '-m', 'Trusted fixture main');
  let base = git('rev-parse', 'HEAD');
  let researchSha = '1'.repeat(40);
  let raw = serialize(packet);
  let refs = [];
  let prs = [];
  let malicious = false;
  let noPacket = false;
  const snapshots = new Map();
  const blobs = new Map();
  let validated = 0;
  const mock = { async get(route) {
    if (route === '/git/ref/heads/main') return { object: { sha: base } };
    if (route === '/git/matching-refs/heads/research/') return noPacket ? [] : [{ ref: `refs/heads/research/2020-01-02-${packet.genre}`, object: { sha: researchSha } }];
    if (route === '/git/matching-refs/heads/publication/') return refs;
    if (route.startsWith('/pulls?')) return prs;
    if (route.startsWith('/compare/')) {
      const sha = route.split('...')[1];
      const names = sha === researchSha ? [packetPath, ...(malicious ? ['scripts/publish-research.mjs'] : [])] : Object.keys(snapshots.get(sha));
      return { total_commits: 1, files: names.map(filename => ({ filename, status: 'added' })) };
    }
    if (route.startsWith('/git/trees/')) {
      const sha = route.slice('/git/trees/'.length).split('?')[0];
      const files = sha === researchSha ? { [packetPath]: raw } : snapshots.get(sha);
      return { truncated: false, tree: Object.entries(files).map(([file, content]) => {
        const blob = hash(content); blobs.set(blob, content);
        return { path: file, mode: '100644', type: 'blob', size: Buffer.byteLength(content), sha: blob };
      }) };
    }
    if (route.startsWith('/git/blobs/')) { const content = blobs.get(route.slice('/git/blobs/'.length)); return { encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') }; }
    throw new Error(`unexpected reconciliation read ${route}`);
  } };
  const check = temp => { validated++; assert.ok(fs.existsSync(path.join(temp, 'data/run-logs', finalized.log.run_id + '.json')) || fs.readdirSync(path.join(temp, 'data/run-logs')).some(n => n.startsWith('2020-01-02-'))); };
  const directory = path.join(root, 'bundle');
  const first = await prepare(root, mock, directory, { validate: check });
  assert.deepEqual(first.errors, []); assert.equal(first.plans.length, 1); assert.equal(validated, 1);
  const frozen = first.plans[0];
  const attemptSha = '2'.repeat(40);
  refs = [{ ref: `refs/heads/${frozen.branch}`, object: { sha: attemptSha } }];
  snapshots.set(attemptSha, Object.fromEntries(Object.entries(frozen.files).map(([name, file]) => [name, file.content])));
  prs = [{ number: 10, state: 'open', head: { ref: frozen.branch, sha: attemptSha } }];
  const retry = await prepare(root, mock, directory, { validate: check });
  assert.deepEqual(retry.errors, []); assert.equal(retry.plans[0].reuse_sha, attemptSha);
  assert.deepEqual(retry.plans[0].files, frozen.files);
  const invalid = await prepare(root, mock, directory, { validate() { throw new Error('pre-PR check failed'); } });
  assert.equal(invalid.plans.length, 0); assert.ok(invalid.states.some(s => s.state === 'finalization_failed'));
  malicious = true;
  const untrusted = await prepare(root, mock, directory, { validate: check });
  assert.equal(untrusted.plans.length, 0); assert.match(untrusted.errors[0].error, /Unauthorized/);
  malicious = false;
  raw = serialize({ ...packet, research_rejections: [{ title: 'Insufficient', reason: 'Incomplete season' }] }); researchSha = '3'.repeat(40);
  const changedPacket = await prepare(root, mock, directory, { validate: check });
  assert.deepEqual(changedPacket.errors, []);
  assert.equal(changedPacket.plans[0].close_pr, 10);
  assert.equal(changedPacket.plans[0].run_id, `2020-01-02-${inputs.research.run_prefix}2`);
  assert.equal(snapshots.get(attemptSha)[`data/run-logs/${frozen.run_id}.json`], frozen.files[`data/run-logs/${frozen.run_id}.json`].content);
  // A base change must re-evaluate exclusions and allocate a fresh immutable attempt.
  fs.writeFileSync(path.join(root, 'data/rejections.json'), serialize({ items: [candidateFromPacket()] }));
  function candidateFromPacket() { const { imdb_id, type, title, year } = packet.candidates[0]; return { imdb_id, type, title, year }; }
  git('add', 'data/rejections.json'); git('commit', '-m', 'Changed trusted exclusion'); base = git('rev-parse', 'HEAD');
  const changedBase = await prepare(root, mock, directory, { validate: check });
  assert.deepEqual(changedBase.errors, []); assert.equal(changedBase.plans[0].accepted, 0);
  assert.equal(changedBase.plans[0].close_pr, 10);
  assert.ok(!Object.keys(changedBase.plans[0].files).some(name => name.startsWith('data/discoveries/')));
  for (const [name, value] of Object.entries(changedBase.plans[0].files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), value.content); }
  git('add', 'data'); git('commit', '-m', 'Merged finalized daily receipt'); base = git('rev-parse', 'HEAD');
  const merged = await prepare(root, mock, directory, { validate: check });
  assert.equal(merged.plans.length, 0); assert.ok(merged.states.some(s => s.state === 'merged'));
  noPacket = true;
  const absent = await prepare(root, mock, directory, { validate: check, clock: () => Date.parse('2021-01-02T12:00:00Z') });
  assert.equal(absent.plans.length, 0); assert.ok(absent.states.some(s => s.state === 'not_started'));
});
console.log('Publication: trust boundary, states, interrupted jobs, retries, current base and single-PR ownership passed');
