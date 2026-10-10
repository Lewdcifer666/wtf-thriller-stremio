import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reconciliationState, assertResearchDiff, assertBlob, assertBundle, publish, publishMaintenance, prepareMaintenance, prepare, verifyMerged, githubClient } from '../scripts/publish-research.mjs';
import { finalizeResearch, hash, serialize } from '../scripts/finalize-research.mjs';
import { createAutomationState } from '../scripts/automation-state.mjs';
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
// A valid minified packet remains below 1 MiB while its generated rejection
// log exceeds it. Include multibyte text so these are byte, not character, caps.
const largePacket = { ...clone(packet), research_rejections: Array.from({ length: 500 }, (_, i) => ({ title: `Unresolved ${i}`, reason: '' })) };
const reasonLength = Math.floor((1024 * 1024 - 4096 - Buffer.byteLength(JSON.stringify(largePacket))) / 1000);
largePacket.research_rejections.forEach(item => { item.reason = 'é'.repeat(reasonLength); });
const largeRaw = JSON.stringify(largePacket);
assert.ok(Buffer.byteLength(largeRaw) < 1024 * 1024);
assert.ok(Buffer.byteLength(serialize(finalizeResearch(largePacket, inputs, options).log)) > 1024 * 1024);
const finalized = finalizeResearch(packet, inputs, options);
const branch = `publication/2020-01-02-${packet.genre}-1`;
const repository = 'example/repo';
const ownedHead = (ref, sha = 'd'.repeat(40)) => ({ ref, sha, repo: { full_name: repository } });
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
function fakeApi({ main = options.evaluatedBase, research = options.researchCommit, existing = [], refSha = 'd'.repeat(40), failAt, protectedMain = true,
  mainFiles = {}, truncated = false, failRead, treeEntryOverride = {}, blobOverride = {}, createdPr, freshPr } = {}) {
  const writes = [];
  const reads = [];
  const mainBlobs = new Map(Object.values(mainFiles).map(content => [hash(content), content]));
  let pr = { number: 1, node_id: 'PR_node', html_url: 'https://github.com/example/repo/pull/1', head: ownedHead(branch, refSha), state: 'open' };
  return { writes, reads,
    async get(route) {
      reads.push(route);
      if (route === '/branches/main') return { protected: protectedMain };
      if (route === '/rules/branches/main?per_page=100&page=1') return [{ type: 'required_status_checks', parameters: {
        strict_required_status_checks_policy: true, required_status_checks: [{ context: 'validate', integration_id: 15368 }],
      } }];
      if (route === '') return { allow_auto_merge: true, full_name: repository };
      if (route === '/git/ref/heads/main') return { object: { sha: main } };
      if (route === `/git/trees/${main}?recursive=1`) {
        if (failRead === 'tree') throw new Error('simulated inaccessible main tree');
        return { truncated, tree: Object.entries(mainFiles).map(([name, content]) => ({ path: name, mode: '100644', type: 'blob', size: Buffer.byteLength(content), sha: hash(content), ...treeEntryOverride })) };
      }
      if (route.startsWith('/git/blobs/')) {
        if (failRead === 'blob') throw new Error('simulated inaccessible main blob');
        const content = mainBlobs.get(route.slice('/git/blobs/'.length));
        assert.notEqual(content, undefined, 'Only observed main-tree blobs may be read');
        return { encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64'), ...blobOverride };
      }
      if (route.startsWith('/git/ref/heads/research/')) return { object: { sha: research } };
      if (route.startsWith('/git/ref/heads/publication/')) return { object: { sha: refSha } };
      if (route.startsWith('/pulls?')) return existing;
      if (/^\/pulls\/\d+$/.test(route)) return freshPr || existing.find(p => p.number === Number(route.split('/').at(-1))) || pr;
      if (route.startsWith('/git/commits/')) return { tree: { sha: 'tree_base' } };
      throw new Error(`unexpected read ${route}`);
    },
    async post(route, body) {
      writes.push({ route, body });
      if (route === failAt) throw new Error('simulated interruption');
      if (route === '/git/trees') return { sha: 'tree_new' };
      if (route === '/git/commits') return { sha: refSha };
      if (route === '/pulls') { pr = createdPr || { ...pr, head: ownedHead(body.head, refSha) }; return pr; }
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
assert.equal(api.writes.find(w => w.query?.includes('enablePullRequestAutoMerge')).variables.head, 'd'.repeat(40));
assert.match(api.writes.find(w => w.query?.includes('enablePullRequestAutoMerge')).query, /expectedHeadOid:\$head/);
const stale = fakeApi({ main: 'e'.repeat(40) });
await assert.rejects(publish(bundle, stale), /Main changed/); assert.equal(stale.writes.length, 0);
// A duplicate workflow wake can finish preparation before the original PR's
// auto-merge, then reach publication after it. Exact immutable artifacts on
// fresh main prove completion without recreating a branch, PR or deployment.
const mergedMain = 'e'.repeat(40);
const mergedFiles = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.content]));
mergedFiles['data/automation-state.json'] = serialize({ changed_after_merge: true });
mergedFiles['scripts/publish-research.mjs'] = 'throw new Error("Must never execute or retrieve main code during completion detection")';
const mergedRetry = fakeApi({ main: mergedMain, mainFiles: mergedFiles });
assert.deepEqual(await publish(bundle, mergedRetry), [{ daily_key: bundle.plans[0].daily_key, state: 'merged', run_id: finalized.log.run_id, revision: mergedMain }]);
assert.equal(mergedRetry.writes.length, 0);
assert.deepEqual(mergedRetry.reads, ['/git/ref/heads/main', `/git/trees/${mergedMain}?recursive=1`,
  `/git/blobs/${hash(files[`data/run-logs/${finalized.log.run_id}.json`].content)}`,
  `/git/blobs/${hash(files[`data/discoveries/${finalized.log.run_id}.json`].content)}`]);
for (const kind of ['changed log', 'changed discovery', 'missing log', 'missing discovery']) {
  const altered = { ...mergedFiles };
  const name = `data/${kind.endsWith('log') ? 'run-logs' : 'discoveries'}/${finalized.log.run_id}.json`;
  if (kind.startsWith('missing')) delete altered[name];
  else altered[name] += '\n'; // Semantic equality is insufficient: history bytes are immutable.
  const rejectedRetry = fakeApi({ main: mergedMain, mainFiles: altered });
  await assert.rejects(publish(bundle, rejectedRetry), /Main changed/, kind);
  assert.equal(rejectedRetry.writes.length, 0, kind);
}
for (const fault of [{ truncated: true }, { failRead: 'tree' }, { failRead: 'blob' }]) {
  const rejectedRetry = fakeApi({ main: mergedMain, mainFiles: mergedFiles, ...fault });
  await assert.rejects(publish(bundle, rejectedRetry), /Main changed/);
  assert.equal(rejectedRetry.writes.length, 0);
}
const zeroFinalized = finalizeResearch({ ...packet, candidates: [], research_rejections: [] }, inputs, options);
const zeroBundle = clone(bundle);
zeroBundle.plans[0].accepted = 0;
delete zeroBundle.plans[0].files[`data/discoveries/${zeroFinalized.log.run_id}.json`];
const zeroLog = serialize(zeroFinalized.log);
zeroBundle.plans[0].files[`data/run-logs/${zeroFinalized.log.run_id}.json`] = { content: zeroLog, sha256: hash(zeroLog) };
const zeroFiles = { [`data/run-logs/${zeroFinalized.log.run_id}.json`]: zeroLog };
const zeroRetry = fakeApi({ main: mergedMain, mainFiles: zeroFiles });
assert.deepEqual(await publish(zeroBundle, zeroRetry), [{ daily_key: zeroBundle.plans[0].daily_key, state: 'merged', run_id: zeroFinalized.log.run_id, revision: mergedMain }]);
assert.equal(zeroRetry.writes.length, 0);
const forbiddenZeroDiscovery = fakeApi({ main: mergedMain, mainFiles: { ...zeroFiles, [`data/discoveries/${zeroFinalized.log.run_id}.json`]: serialize({ items: [] }) } });
await assert.rejects(publish(zeroBundle, forbiddenZeroDiscovery), /Main changed/);
assert.equal(forbiddenZeroDiscovery.writes.length, 0);
for (const candidates of [largePacket.candidates, []]) {
  const largeFinalized = finalizeResearch({ ...largePacket, candidates }, inputs, options);
  const largeLog = serialize(largeFinalized.log);
  assert.ok(Buffer.byteLength(largeLog) > 1024 * 1024);
  const largeBundle = clone(candidates.length ? bundle : zeroBundle);
  const logPath = `data/run-logs/${largeFinalized.log.run_id}.json`;
  largeBundle.plans[0].files[logPath] = { content: largeLog, sha256: hash(largeLog) };
  const largeFiles = Object.fromEntries(Object.entries(largeBundle.plans[0].files).map(([name, file]) => [name, file.content]));
  const largeRetry = fakeApi({ main: mergedMain, mainFiles: largeFiles });
  assert.equal((await publish(largeBundle, largeRetry))[0].state, 'merged');
  assert.equal(largeRetry.writes.length, 0);
  const alteredLarge = fakeApi({ main: mergedMain, mainFiles: { ...largeFiles, [logPath]: largeLog + '\n' } });
  await assert.rejects(publish(largeBundle, alteredLarge), /Main changed/);
  assert.equal(alteredLarge.writes.length, 0);
}
for (const fault of [
  { treeEntryOverride: { size: 100_000_001 } },
  { treeEntryOverride: { mode: '120000' } },
  { blobOverride: { encoding: 'utf-8' } },
  { blobOverride: { size: 100_000_001 } },
  { blobOverride: { content: Buffer.from('short').toString('base64') } },
]) {
  const rejectedArtifact = fakeApi({ main: mergedMain, mainFiles: mergedFiles, ...fault });
  await assert.rejects(publish(bundle, rejectedArtifact), /Main changed/);
  assert.equal(rejectedArtifact.writes.length, 0);
  if (fault.treeEntryOverride) assert.equal(rejectedArtifact.reads.some(route => route.startsWith('/git/blobs/')), false);
}
const unprotected = fakeApi({ protectedMain: false });
await assert.rejects(publish(bundle, unprotected), /protection/); assert.equal(unprotected.writes.length, 0);
const changedPacket = fakeApi({ research: 'f'.repeat(40) });
await assert.rejects(publish(bundle, changedPacket), /Research changed/); assert.equal(changedPacket.writes.length, 0);
const retryBundle = clone(bundle); retryBundle.plans[0].reuse_sha = 'd'.repeat(40);
const existing = [{ number: 1, node_id: 'node', html_url: 'url', head: ownedHead(branch), state: 'open' }];
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
const duplicate = fakeApi({ existing: [{ number: 9, state: 'open', head: ownedHead(`publication/2020-01-02-${packet.genre}-9`) }] });
await assert.rejects(publish(bundle, duplicate), /active PR/);
// A fork may copy every predictable branch name. It must never own or block
// our daily key, be closed as superseded, or receive auto-merge permission.
const forkPr = (ref = branch, state = 'open') => ({ number: 99, node_id: 'fork_node', state,
  html_url: 'https://github.com/example/repo/pull/99', head: { ref, sha: 'd'.repeat(40), repo: { full_name: 'outsider/repo' } } });
for (const impostor of [forkPr(), forkPr(branch, 'closed'), forkPr(`publication/2020-01-02-${packet.genre}-9`),
  { ...forkPr(), head: { ...forkPr().head, repo: null } }]) {
  const safe = fakeApi({ existing: [impostor] });
  await publish(bundle, safe);
  assert.equal(safe.writes.filter(w => w.route === '/pulls').length, 1);
  assert.deepEqual(safe.writes.filter(w => w.query).map(w => w.variables.id), ['PR_node']);
  assert.equal(safe.writes.some(w => w.route === '/pulls/99'), false);
}
const foreignSuperseded = clone(bundle); foreignSuperseded.plans[0].close_pr = 99;
const protectedFork = fakeApi({ existing: [forkPr(`publication/2020-01-02-${packet.genre}-9`)] });
await assert.rejects(publish(foreignSuperseded, protectedFork), /Superseded PR changed/);
assert.deepEqual(protectedFork.writes, []);
for (const badHead of [ownedHead(branch, 'e'.repeat(40)), ownedHead(branch + '-other'), forkPr().head,
  { ...ownedHead(branch), repo: null }]) {
  const changed = { ...existing[0], head: badHead };
  const staleHead = fakeApi({ existing, freshPr: changed });
  await assert.rejects(publish(retryBundle, staleHead), /PR head repository, branch or SHA mismatch/);
  assert.deepEqual(staleHead.writes, [], 'Fresh mismatched PR must not receive auto-merge');
  const badCreated = fakeApi({ createdPr: changed });
  await assert.rejects(publish(bundle, badCreated), /PR head repository, branch or SHA mismatch/);
  assert.equal(badCreated.writes.some(w => w.query), false, 'Creation response must also identify the verified local branch');
}
const wrongListedHead = fakeApi({ existing: [{ ...existing[0], head: ownedHead(branch, 'e'.repeat(40)) }] });
await assert.rejects(publish(retryBundle, wrongListedHead), /PR head repository, branch or SHA mismatch/);
assert.deepEqual(wrongListedHead.writes, []);
const staleSuperseded = clone(bundle); staleSuperseded.plans[0].close_pr = 9;
const priorBranch = `publication/2020-01-02-${packet.genre}-9`;
const priorPr = { number: 9, node_id: 'prior_node', state: 'open', auto_merge: {}, head: ownedHead(priorBranch) };
const hijackedPrevious = fakeApi({ existing: [priorPr], freshPr: { ...priorPr, head: { ...priorPr.head, repo: { full_name: 'outsider/repo' } } } });
await assert.rejects(publish(staleSuperseded, hijackedPrevious), /PR head repository, branch or SHA mismatch/);
assert.deepEqual(hijackedPrevious.writes, [], 'A changed superseded PR must not be closed or have auto-merge changed');
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
  fs.writeFileSync(path.join(root, 'data/automation-state.json'), serialize(await createAutomationState(root)));
  git('add', '.'); git('commit', '-m', 'Trusted fixture main');
  let base = git('rev-parse', 'HEAD');
  let researchSha = '1'.repeat(40);
  let raw = largeRaw;
  let refs = [];
  let prs = [];
  let malicious = false;
  let noPacket = false;
  let comparisonOverride = null;
  const reads = [];
  const snapshots = new Map();
  const blobs = new Map();
  const baseBlob = name => {
    try { return execFileSync('git', ['show', `${base}:${name}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return null; }
  };
  let validated = 0;
  const mock = { async get(route) {
    reads.push(route);
    if (route === '') return { full_name: repository };
    if (route === '/git/ref/heads/main') return { object: { sha: base } };
    if (route === '/git/matching-refs/heads/research/') return noPacket ? [] : [{ ref: `refs/heads/research/2020-01-02-${packet.genre}`, object: { sha: researchSha } }];
    if (route === '/git/matching-refs/heads/publication/') return refs;
    if (route.startsWith('/pulls?')) return prs;
    if (route.startsWith('/compare/')) {
      const sha = route.split('...')[1];
      if (sha === researchSha) return { total_commits: 1, files: [packetPath, ...(malicious ? ['scripts/publish-research.mjs'] : [])].map(filename => ({ filename, status: 'added' })) };
      // Match GitHub's real diff: a generated file whose bytes equal the base
      // still exists in the tree, but must not appear among changed paths.
      const changes = Object.entries(snapshots.get(sha)).flatMap(([filename, content]) => {
        const before = baseBlob(filename);
        return before?.equals(Buffer.from(content)) ? [] : [{ filename, status: before === null ? 'added' : 'modified' }];
      });
      return { total_commits: 1, files: comparisonOverride || changes };
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
  // A real zero-result first attempt adds only its immutable log. It still
  // carries the regenerated state in its bundle, and retries must verify that
  // inherited state even though the commit diff does not list it.
  raw = serialize({ ...packet, candidates: [], research_rejections: [{ title: 'Unresolved fixture', reason: 'Whole-runtime evidence unavailable' }] });
  const zeroFirst = await prepare(root, mock, directory, { validate: check });
  assert.deepEqual(zeroFirst.errors, []);
  const zeroFrozen = zeroFirst.plans[0], zeroSha = '7'.repeat(40);
  const statePath = 'data/automation-state.json', zeroLogPath = `data/run-logs/${zeroFrozen.run_id}.json`;
  assert.equal(zeroFrozen.accepted, 0);
  assert.deepEqual(Object.keys(zeroFrozen.files).sort(), [zeroLogPath, statePath].sort());
  assert.equal(zeroFrozen.files[statePath].content, fs.readFileSync(path.join(root, statePath), 'utf8'));
  refs = [{ ref: `refs/heads/${zeroFrozen.branch}`, object: { sha: zeroSha } }];
  snapshots.set(zeroSha, Object.fromEntries(Object.entries(zeroFrozen.files).map(([name, file]) => [name, file.content])));
  prs = [{ number: 9, state: 'open', head: ownedHead(zeroFrozen.branch, zeroSha) }];
  const zeroDiff = (await mock.get(`/compare/${base}...${zeroSha}`)).files;
  assert.deepEqual(zeroDiff, [{ filename: zeroLogPath, status: 'added' }]);
  reads.length = 0;
  const zeroResume = await prepare(root, mock, directory, { validate: check });
  assert.deepEqual(zeroResume.errors, []);
  assert.equal(zeroResume.plans[0].reuse_sha, zeroSha);
  assert.deepEqual(zeroResume.plans[0].files, zeroFrozen.files);
  assert.ok(reads.includes(`/git/blobs/${hash(zeroFrozen.files[statePath].content)}`), 'Unchanged frozen state must still be fetched');
  for (const changes of [[], [...zeroDiff, { filename: 'scripts/unauthorized.mjs', status: 'added' }],
    [...zeroDiff, { filename: statePath, status: 'modified' }],
    [{ filename: zeroLogPath, status: 'removed' }], [{ filename: zeroLogPath, status: 'renamed' }]]) {
    comparisonOverride = changes;
    const invalidDiff = await prepare(root, mock, directory, { validate: check });
    assert.equal(invalidDiff.plans.length, 0);
    assert.match(invalidDiff.errors[0].error, /Frozen attempt contains unauthorized changes/);
  }
  // Omitting state is permitted only when base and frozen bytes agree, even
  // if the difference is JSON whitespace rather than a semantic change.
  snapshots.get(zeroSha)[statePath] += '\n';
  comparisonOverride = zeroDiff;
  const hiddenStateChange = await prepare(root, mock, directory, { validate: check });
  assert.equal(hiddenStateChange.plans.length, 0);
  assert.match(hiddenStateChange.errors[0].error, /Frozen attempt contains unauthorized changes/);
  snapshots.get(zeroSha)[statePath] = zeroFrozen.files[statePath].content;
  comparisonOverride = null; refs = []; prs = []; raw = largeRaw;
  const validatedBefore = validated;
  const first = await prepare(root, mock, directory, { validate: check });
  assert.deepEqual(first.errors, []); assert.equal(first.plans.length, 1); assert.equal(validated, validatedBefore + 1);
  const frozen = first.plans[0];
  assert.ok(Buffer.byteLength(frozen.files[`data/run-logs/${frozen.run_id}.json`].content) > 1024 * 1024);
  const attemptSha = '2'.repeat(40);
  refs = [{ ref: `refs/heads/${frozen.branch}`, object: { sha: attemptSha } }];
  snapshots.set(attemptSha, Object.fromEntries(Object.entries(frozen.files).map(([name, file]) => [name, file.content])));
  prs = [{ number: 10, state: 'open', head: ownedHead(frozen.branch, attemptSha) }];
  const retry = await prepare(root, mock, directory, { validate: check });
  assert.deepEqual(retry.errors, []); assert.equal(retry.plans[0].reuse_sha, attemptSha);
  assert.deepEqual(retry.plans[0].files, frozen.files);
  const ownedPr = clone(prs[0]);
  for (const state of ['open', 'closed']) {
    prs = [forkPr(frozen.branch, state), ownedPr];
    const unrelatedFork = await prepare(root, mock, directory, { validate: check });
    assert.deepEqual(unrelatedFork.errors, []);
    assert.equal(unrelatedFork.plans[0].reuse_sha, attemptSha);
    assert.equal(unrelatedFork.plans[0].close_pr, null);
  }
  prs = [{ ...ownedPr, head: ownedHead(frozen.branch, 'e'.repeat(40)) }];
  const mismatchedOwnedPr = await prepare(root, mock, directory, { validate: check });
  assert.deepEqual(mismatchedOwnedPr.plans, []);
  assert.match(mismatchedOwnedPr.errors[0].error, /PR head repository, branch or SHA mismatch/);
  prs = [ownedPr];
  const acceptedDiff = (await mock.get(`/compare/${base}...${attemptSha}`)).files;
  assert.deepEqual(acceptedDiff.map(f => f.filename).sort(), Object.keys(frozen.files).sort());
  for (const omitted of Object.keys(frozen.files)) {
    comparisonOverride = acceptedDiff.filter(file => file.filename !== omitted);
    const incomplete = await prepare(root, mock, directory, { validate: check });
    assert.equal(incomplete.plans.length, 0);
    assert.match(incomplete.errors[0].error, /Frozen attempt contains unauthorized changes/);
  }
  comparisonOverride = null;
  raw = largeRaw + ' '.repeat(1024 * 1024 - Buffer.byteLength(largeRaw) + 1);
  const oversizedPacket = await prepare(root, mock, directory, { validate: check });
  assert.equal(oversizedPacket.plans.length, 0);
  assert.match(oversizedPacket.errors[0].error, /Packet must be a regular file/);
  raw = largeRaw;
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
  let deploymentsVerified = 0;
  await verifyMerged(root, merged, { verify: async (url, expected) => {
    deploymentsVerified++;
    assert.equal(expected.revision, base);
    assert.ok(expected.runs.some(run => run.run_id === changedBase.plans[0].run_id));
  } });
  assert.equal(deploymentsVerified, 1);
  assert.ok(merged.states.some(s => s.state === 'deployed'));
  noPacket = true;
  const absent = await prepare(root, mock, directory, { validate: check, clock: () => Date.parse('2021-01-02T12:00:00Z') });
  assert.equal(absent.plans.length, 0); assert.ok(absent.states.some(s => s.state === 'not_started'));
  // Metadata recovery also reads generated JSON, not a research packet. Legal
  // JSON whitespace makes this fixture large without changing library content.
  const libraryContent = fs.readFileSync(path.join(root, 'data/library.json'), 'utf8') + ' '.repeat(1024 * 1024);
  const stateContent = fs.readFileSync(path.join(root, 'data/automation-state.json'), 'utf8');
  const maintenanceContents = { 'data/library.json': libraryContent, 'data/automation-state.json': stateContent };
  const maintenanceBundle = { schema_version: 1, ready: true, base, files: Object.fromEntries(Object.entries(maintenanceContents).map(([name, content]) => [name, { content, sha256: hash(content) }])) };
  const maintenanceBranch = `maintenance/metadata-${base.slice(0, 12)}`;
  const maintenanceSha = '9'.repeat(40);
  const maintenancePr = { number: 11, state: 'open', node_id: 'maintenance_pr', html_url: 'https://github.com/example/repo/pull/11', head: ownedHead(maintenanceBranch, maintenanceSha) };
  for (const changed of [false, true]) {
    const metadataApi = maintenanceApi({ existing: [maintenancePr], contents: { ...maintenanceContents, 'data/library.json': libraryContent + (changed ? '\n' : '') } });
    if (changed) {
      await assert.rejects(publishMaintenance(root, metadataApi, maintenanceBundle), /Frozen metadata branch differs/);
      assert.equal(metadataApi.writes.length, 0);
    } else {
      assert.equal(await publishMaintenance(root, metadataApi, maintenanceBundle), maintenancePr.html_url);
      assert.equal(metadataApi.writes.length, 1);
      assert.ok(metadataApi.writes[0].query.includes('enablePullRequestAutoMerge'));
    }
  }
  function maintenanceApi({ existing = [], freshPr, createdPr, createBranch = false, contents = maintenanceContents, diff } = {}) {
    const api = fakeApi({ main: base, existing, freshPr, createdPr, refSha: maintenanceSha });
    const baseContents = Object.fromEntries(Object.keys(maintenanceContents).map(name => [name, baseBlob(name)?.toString('utf8')]).filter(([, value]) => value !== undefined));
    const blobContents = new Map([...Object.values(baseContents), ...Object.values(contents)].map(content => [hash(content), content]));
    const tree = files => ({ truncated: false, tree: Object.entries(files).map(([name, content]) => ({ path: name, mode: '100644', type: 'blob', size: Buffer.byteLength(content), sha: hash(content) })) });
    const get = api.get;
    api.get = route => {
      if (route === `/git/ref/heads/${maintenanceBranch}`) {
        if (createBranch) { const error = new Error('Not found'); error.status = 404; throw error; }
        return { object: { sha: maintenanceSha } };
      }
      if (route === `/git/trees/${maintenanceSha}?recursive=1`) return tree(contents);
      if (route === `/git/trees/${base}?recursive=1`) return tree(baseContents);
      if (route.startsWith('/git/blobs/')) { const content = blobContents.get(route.split('/').at(-1)); return { encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') }; }
      if (route === `/compare/${base}...${maintenanceSha}`) return { total_commits: 1, files: diff || Object.entries(contents).filter(([name, content]) => baseContents[name] !== content).map(([filename]) => ({ filename, status: filename in baseContents ? 'modified' : 'added' })) };
      return get(route);
    };
    return api;
  }
  for (const createBranch of [false, true]) for (const foreign of [forkPr(maintenanceBranch), forkPr(maintenanceBranch, 'closed'), forkPr('maintenance/metadata-older')]) {
    const safe = maintenanceApi({ existing: [foreign], createBranch });
    const url = await publishMaintenance(root, safe, maintenanceBundle);
    assert.equal(url, 'https://github.com/example/repo/pull/1');
    assert.equal(safe.writes.filter(w => w.route === '/pulls').length, 1);
    assert.deepEqual(safe.writes.filter(w => w.query).map(w => w.variables.id), ['PR_node']);
    assert.equal(safe.writes.some(w => w.route === '/pulls/99'), false);
  }
  const localOlder = maintenanceApi({ existing: [{ ...maintenancePr, head: ownedHead('maintenance/metadata-older', maintenanceSha) }] });
  await assert.rejects(publishMaintenance(root, localOlder, maintenanceBundle), /older metadata PR/);
  assert.deepEqual(localOlder.writes, []);
  for (const head of [ownedHead(maintenanceBranch, 'e'.repeat(40)), ownedHead('maintenance/metadata-other', maintenanceSha),
    { ...ownedHead(maintenanceBranch, maintenanceSha), repo: { full_name: 'outsider/repo' } },
    { ...ownedHead(maintenanceBranch, maintenanceSha), repo: null }]) {
    const changed = { ...maintenancePr, head };
    const changedAfterList = maintenanceApi({ existing: [maintenancePr], freshPr: changed });
    await assert.rejects(publishMaintenance(root, changedAfterList, maintenanceBundle), /PR head repository, branch or SHA mismatch/);
    assert.deepEqual(changedAfterList.writes, []);
    for (const createBranch of [false, true]) {
      const wrongCreated = maintenanceApi({ createdPr: changed, createBranch });
      await assert.rejects(publishMaintenance(root, wrongCreated, maintenanceBundle), /PR head repository, branch or SHA mismatch/);
      assert.equal(wrongCreated.writes.some(w => w.query), false);
    }
  }
  const listedMismatch = maintenanceApi({ existing: [{ ...maintenancePr, head: ownedHead(maintenanceBranch, 'e'.repeat(40)) }] });
  await assert.rejects(publishMaintenance(root, listedMismatch, maintenanceBundle), /PR head repository, branch or SHA mismatch/);
  assert.deepEqual(listedMismatch.writes, []);
  for (const contents of [{ 'data/library.json': libraryContent }, { ...maintenanceContents, 'data/automation-state.json': stateContent + '\n' }]) {
    const incompleteFrozen = maintenanceApi({ contents });
    await assert.rejects(publishMaintenance(root, incompleteFrozen, maintenanceBundle), /regular file|Frozen metadata branch differs/);
    assert.deepEqual(incompleteFrozen.writes, [], 'Incomplete old attempts stay immutable and require review');
  }
  const injected = maintenanceApi({ diff: [{ filename: 'scripts/publish-research.mjs', status: 'modified' }] });
  await assert.rejects(publishMaintenance(root, injected, maintenanceBundle), /Unauthorized metadata branch changes/);
  assert.deepEqual(injected.writes, []);
  const oldBundle = { ready: true, base, content: libraryContent, sha256: hash(libraryContent) };
  await assert.rejects(publishMaintenance(root, maintenanceApi(), oldBundle), /Invalid maintenance output paths/);
});
// Metadata resolution updates the exact exclusion state supplied to research;
// retries with identical inputs do not create another maintenance result.
await inFixture(async root => {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const libraryPath = path.join(root, 'data/library.json');
  const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
  const item = { ...library.items[0], imdb_id: null, status: 'watched', title: 'Unresolved metadata fixture', year: 2020 };
  library.items = [item]; fs.writeFileSync(libraryPath, serialize(library));
  fs.writeFileSync(path.join(root, 'data/automation-state.json'), serialize(await createAutomationState(root)));
  const oldState = JSON.parse(fs.readFileSync(path.join(root, 'data/automation-state.json'), 'utf8'));
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-m', 'Metadata fixture');
  let checks = 0;
  const result = await prepareMaintenance(root, path.join(root, 'metadata-bundle'), {
    resolve: () => { library.items[0].imdb_id = 'tt999999998'; fs.writeFileSync(libraryPath, serialize(library)); },
    validate: async current => {
      checks++;
      const actual = JSON.parse(fs.readFileSync(path.join(current, 'data/automation-state.json'), 'utf8'));
      assert.deepEqual(actual, await createAutomationState(current));
      assert.notEqual(actual.state_token, oldState.state_token);
      assert(actual.public_identities.some(id => id.includes('tt999999998')));
      assert(!actual.public_identities.some(id => id.includes('unresolved metadata fixture')));
    },
  });
  assert.equal(checks, 1); assert.equal(result.ready, true);
  assert.deepEqual(Object.keys(result.files).sort(), ['data/automation-state.json', 'data/library.json']);
  for (const [name, file] of Object.entries(result.files)) assert.equal(file.content, fs.readFileSync(path.join(root, name), 'utf8'));
  const retry = await prepareMaintenance(root, path.join(root, 'metadata-retry'), { resolve: () => {}, validate: () => { throw Error('Unchanged metadata must not create work'); } });
  assert.equal(retry.ready, false);
});
// A competing workflow can auto-merge while prepare is running its pre-PR
// validation. Exercise the actual temporary Git checkout and advance the API's
// main revision from that validation callback, not before preparation starts.
await inFixture(async root => {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('add', '.'); git('commit', '-m', 'Pinned prepare-race fixture');
  const base = git('rev-parse', 'HEAD'), advanced = '8'.repeat(40);
  const unchanged = git('status', '--porcelain');
  const directory = path.join(root, 'race-bundle');
  // Use a day distinct from both fixture packets and real production history.
  // The shared default clock can already have a genuine merged daily receipt.
  const clock = () => Date.parse('2020-01-04T10:00:00Z');
  async function race({ zero = false, count = 1, alter, failure, invalidPacket = false } = {}) {
    let remoteMain = base;
    const packets = new Map(Array.from({ length: count }, (_, i) => {
      const value = clone(packet);
      value.research_date = `2020-01-0${i + 2}`;
      if (zero) value.candidates = [];
      else value.candidates[0].imdb_id = `tt99999999${i + 1}`;
      return [String(i + 1).repeat(40), value];
    }));
    if (invalidPacket) packets.set('9'.repeat(40), { ...clone(packet), research_date: '2020-01-09', forbidden: true });
    const mainFiles = {}, blobs = new Map(), reads = [], validated = [];
    let writes = 0, beforeMutation;
    const api = {
      async get(route) {
        reads.push(route);
        if (route === '') return { full_name: repository };
        if (route === '/git/ref/heads/main') {
          if (remoteMain !== base && failure === 'main') throw new Error('Injected main lookup failure');
          return { object: { sha: remoteMain } };
        }
        if (route === '/git/matching-refs/heads/research/') return [...packets].map(([sha, value]) => ({ ref: `refs/heads/research/${value.research_date}-${packet.genre}`, object: { sha } }));
        if (route === '/git/matching-refs/heads/publication/' || route.startsWith('/pulls?')) return [];
        if (route.startsWith('/compare/')) {
          assert.ok(route.startsWith(`/compare/${base}...`), 'Research comparison must retain the original trusted base');
          const value = packets.get(route.split('...')[1]);
          return { total_commits: 1, files: [{ filename: `research-inbox/${value.research_date}.json`, status: 'added' }] };
        }
        if (route.startsWith('/git/trees/')) {
          const sha = route.slice('/git/trees/'.length).split('?')[0];
          if (sha === advanced && failure === 'tree') throw new Error('Injected merged tree failure');
          const value = packets.get(sha);
          const contents = value ? { [`research-inbox/${value.research_date}.json`]: serialize(value) } : mainFiles;
          assert.ok(value || sha === advanced, 'Only the packet and the pinned observed-main tree may be read');
          return { truncated: sha === advanced && failure === 'truncated', tree: Object.entries(contents).map(([name, content]) => {
            const sha = hash(content); blobs.set(sha, content);
            return { path: name, mode: '100644', type: 'blob', size: Buffer.byteLength(content), sha };
          }) };
        }
        if (route.startsWith('/git/blobs/')) {
          if (remoteMain !== base && failure === 'blob') throw new Error('Injected merged blob failure');
          const content = blobs.get(route.slice('/git/blobs/'.length));
          return { encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
        }
        throw new Error(`Unexpected prepare-race read ${route}`);
      },
      async post() { writes++; throw new Error('Prepare must never write remotely'); },
      async patch() { writes++; throw new Error('Prepare must never write remotely'); },
      async graphql() { writes++; throw new Error('Prepare must never write remotely'); },
    };
    const validate = (temp, evaluatedBase) => {
      assert.equal(evaluatedBase, base);
      assert.notEqual(temp, root);
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: temp, encoding: 'utf8' }).trim(), base);
      assert.equal(fs.readFileSync(path.join(temp, 'scripts/publish-research.mjs'), 'utf8'), fs.readFileSync(path.join(root, 'scripts/publish-research.mjs'), 'utf8'));
      for (const name of fs.readdirSync(path.join(temp, 'data/run-logs')).filter(name => /^2020-01-0[23]-/.test(name))) {
        const logPath = `data/run-logs/${name}`;
        const content = fs.readFileSync(path.join(temp, logPath), 'utf8');
        const log = JSON.parse(content);
        assert.equal(log.publication.evaluated_base, base);
        validated.push(log.run_id);
        mainFiles[logPath] = content;
        if (log.accepted) mainFiles[`data/discoveries/${name}`] = fs.readFileSync(path.join(temp, 'data/discoveries', name), 'utf8');
      }
      // Mutable state and code at the newly observed main are deliberately
      // unrelated. Completion detection may only retrieve immutable outputs.
      mainFiles['data/automation-state.json'] = serialize({ changed_after_merge: true });
      mainFiles['scripts/publish-research.mjs'] = 'throw new Error("Untrusted revision code must not execute")';
      if (validated.length === count) {
        beforeMutation = { ...mainFiles };
        alter?.(mainFiles, validated);
        remoteMain = advanced;
      }
    };
    let result, caught;
    try { result = await prepare(root, api, directory, { validate, clock }); }
    catch (error) { caught = error; }
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'bundle.json'), 'utf8'));
    assert.equal(saved.base, base, 'The bundle must retain the code and policy revision that evaluated it');
    assert.equal(saved.observed_main, failure === 'main' ? undefined : advanced);
    assert.equal(validated.length, count);
    assert.equal(writes, 0);
    assert.equal(git('rev-parse', 'HEAD'), base, 'Detecting completion must never checkout the newer main');
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), unchanged);
    for (const name of ['data/automation-state.json', 'scripts/publish-research.mjs']) {
      assert.ok(!reads.includes(`/git/blobs/${hash(mainFiles[name])}`), `Do not retrieve ${name} from newer main`);
    }
    return { result, caught, saved, validated, beforeMutation };
  }
  for (const zero of [false, true]) {
    const { result, caught, saved, validated } = await race({ zero });
    assert.equal(caught, undefined);
    assert.deepEqual(saved, result);
    assert.deepEqual(saved.plans, []);
    assert.deepEqual(saved.errors, []);
    assert.equal(saved.stale_base, undefined);
    assert.deepEqual(saved.states.find(state => state.run_id === validated[0]), {
      daily_key: `${packet.genre}:2020-01-02`, state: 'merged', run_id: validated[0], revision: advanced,
    });
    assert.ok(saved.states.some(state => state.state === 'not_started'), 'Missing current research must remain not_started');
    let verified = 0;
    await verifyMerged(root, saved, { verify: async () => { verified++; } });
    assert.equal(verified, 0, 'An old checkout cannot verify the newly merged revision');
    assert.ok(saved.states.some(state => state.state === 'merged'));
    const revisionOnly = clone(saved); delete revisionOnly.observed_main;
    await verifyMerged(root, revisionOnly, { verify: async () => { verified++; } });
    assert.equal(verified, 0, 'Per-state revisions also prevent an old receipt from claiming deployment');
  }
  const bothMerged = await race({ count: 2 });
  assert.equal(bothMerged.caught, undefined);
  assert.equal(bothMerged.saved.states.filter(state => state.state === 'merged').length, 2);
  assert.equal(bothMerged.saved.plans.length, 0);
  const brokenCases = [
    ...['run-logs', 'discoveries'].flatMap(folder => ['missing', 'mismatch'].map(kind => ({
      alter(files, runs) {
        const name = `data/${folder}/${runs[0]}.json`;
        if (kind === 'missing') delete files[name]; else files[name] += '\n';
      },
    }))),
    { zero: true, alter(files, runs) { files[`data/discoveries/${runs[0]}.json`] = serialize({ items: [] }); } },
    { count: 2, invalidPacket: true, alter(files, runs) { delete files[`data/run-logs/${runs[1]}.json`]; } },
    ...['main', 'tree', 'blob', 'truncated'].map(failure => ({ failure })),
  ];
  for (const scenario of brokenCases) {
    const { caught, saved, beforeMutation } = await race(scenario);
    assert.ok(caught, 'Incomplete or unreadable completion evidence must fail preparation');
    assert.match(caught.message, scenario.failure === 'main' ? /main lookup failure/ : /Main changed/);
    assert.equal(saved.stale_base, true);
    assert.equal(saved.plans.length, scenario.count || 1, 'A partial batch must retain every original plan');
    for (const plan of saved.plans) {
      for (const [name, file] of Object.entries(plan.files)) if (name !== 'data/automation-state.json') {
        assert.equal(file.content, beforeMutation[name], 'Failure must preserve the original validated artifact bytes');
      }
      assert.equal(saved.states.find(state => state.run_id === plan.run_id).state, 'research_staged');
    }
    assert.ok(saved.errors.some(error => error.stage === 'prepare'));
    if (scenario.invalidPacket) {
      assert.ok(saved.errors.some(error => error.daily_key === `${packet.genre}:2020-01-09`), 'Earlier packet diagnostics must survive a stale-base failure');
      assert.ok(saved.states.some(state => state.daily_key === `${packet.genre}:2020-01-09` && state.state === 'finalization_failed'));
    }
    assert.throws(() => assertBundle(saved), /Stale preparation bundle/);
    let verified = 0;
    await verifyMerged(root, saved, { verify: async () => { verified++; } });
    assert.equal(verified, 0);
  }
});
console.log('Publication: trust boundary, states, interrupted jobs, retries, current base and single-PR ownership passed');
