// All entry points run from a pinned trusted-main checkout. GitHub research
// commits are read through the API as data; they are never checked out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finalizeResearch, loadFinalizerInputs, writeFinalized, hash, serialize, dailyKey } from './finalize-research.mjs';
import { readJson, berlinDate } from './validate-research-packet.mjs';
import { deploymentReceipt, verifyDeployment } from './verify-deployment.mjs';

export function reconciliationState({ packet, failed, attempt, merged, deployed }) {
  if (deployed && !merged) throw new Error('Deployment without a merged run');
  if (deployed) return 'deployed';
  if (merged) return 'merged';
  if (attempt) return 'PR_open';
  if (failed) return 'finalization_failed';
  return packet ? 'research_staged' : 'not_started';
}
export function assertResearchDiff(files, expectedPath, truncated = false) {
  if (truncated || files.length !== 1 || files[0].filename !== expectedPath
    || !['added', 'modified'].includes(files[0].status)) throw new Error('Unauthorized research-branch changes; only its dated packet is permitted');
}
export function assertBlob(entry) {
  if (!entry || entry.type !== 'blob' || entry.mode !== '100644' || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > 1024 * 1024) throw new Error('Packet must be a regular file of at most 1 MiB');
}
export function publicationPaths(runId, accepted) {
  if (!/^20\d\d-\d\d-\d\d-[a-z]+[1-9]\d*$/.test(runId)) throw new Error('Invalid generated run ID');
  return [`data/run-logs/${runId}.json`, ...(accepted ? [`data/discoveries/${runId}.json`] : []), 'data/automation-state.json'].sort();
}
export function assertBundle(bundle) {
  if (bundle.schema_version !== 1 || !/^[a-f0-9]{40}$/.test(bundle.base || '') || !Array.isArray(bundle.plans)) throw new Error('Invalid publication bundle');
  for (const plan of bundle.plans) {
    if (!/^publication\/20\d\d-\d\d-\d\d-[a-z]+-[1-9]\d*$/.test(plan.branch || '')) throw new Error('Invalid publication branch');
    if (JSON.stringify(Object.keys(plan.files).sort()) !== JSON.stringify(publicationPaths(plan.run_id, plan.accepted))) throw new Error('Unauthorized publication output path');
    for (const file of Object.values(plan.files)) if (typeof file.content !== 'string' || hash(file.content) !== file.sha256) throw new Error('Publication output digest mismatch');
    const log = JSON.parse(plan.files[`data/run-logs/${plan.run_id}.json`].content);
    if (log.run_id !== plan.run_id || log.accepted !== plan.accepted || log.publication?.evaluated_base !== bundle.base
      || log.publication?.daily_key !== plan.daily_key) throw new Error('Publication bundle/log disagreement');
  }
  return bundle;
}

export function githubClient(repository, token, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !token) throw new Error('Repository and GitHub credential are required');
  const request = async (method, endpoint, data) => {
    const response = await fetchImpl(`https://api.github.com${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok) { const error = new Error(`GitHub ${method} ${endpoint}: HTTP ${response.status} ${result.message || ''}`); error.status = response.status; throw error; }
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors.map(e => e.message).join('; ')}`);
    return result;
  };
  return {
    get: suffix => request('GET', `/repos/${repository}${suffix}`),
    post: (suffix, data) => request('POST', `/repos/${repository}${suffix}`, data),
    patch: (suffix, data) => request('PATCH', `/repos/${repository}${suffix}`, data),
    graphql: (query, variables) => request('POST', '/graphql', { query, variables }),
  };
}
async function getBlob(api, entry) {
  assertBlob(entry);
  const blob = await api.get(`/git/blobs/${entry.sha}`);
  if (blob.encoding !== 'base64' || blob.size > 1024 * 1024) throw new Error('Unsupported packet encoding or size');
  return Buffer.from(blob.content, 'base64').toString('utf8');
}
async function getFile(api, commit, relative) {
  const tree = await api.get(`/git/trees/${commit}?recursive=1`);
  if (tree.truncated) throw new Error('Git tree truncated; refusing incomplete input');
  return getBlob(api, tree.tree.find(e => e.path === relative));
}
async function matchesMergedPlan(api, commit, plan) {
  // A prior auto-merge can finish between preparation and publication. Read
  // immutable artifacts from one pinned main revision, never code or mutable
  // automation state, to distinguish that completed retry from a stale plan.
  const tree = await api.get(`/git/trees/${commit}?recursive=1`);
  if (tree.truncated) throw new Error('Git tree truncated; refusing incomplete input');
  const logPath = `data/run-logs/${plan.run_id}.json`;
  const discoveryPath = `data/discoveries/${plan.run_id}.json`;
  if (plan.accepted === 0 && tree.tree.some(entry => entry.path === discoveryPath)) return false;
  for (const name of [logPath, ...(plan.accepted ? [discoveryPath] : [])]) {
    const entry = tree.tree.find(e => e.path === name);
    if (!entry || await getBlob(api, entry) !== plan.files[name].content) return false;
  }
  return true;
}
async function allPulls(api) {
  const result = [];
  for (let page = 1; ; page++) {
    const entries = await api.get(`/pulls?state=all&base=main&per_page=100&page=${page}`);
    result.push(...entries);
    if (entries.length < 100) break;
  }
  return result;
}
const run = (command, args, cwd, env = {}) => execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
export function fullValidation(root, base) {
  const env = { PUBLICATION_BASE: base || '' };
  for (const [script, ...args] of [['automation-preflight.mjs', 'self-test'], ['validate.mjs'], ['validate-run-logs.mjs'], ['validate-publication.mjs']]) {
    run(process.execPath, [`scripts/${script}`, ...args], root, env);
  }
  run(process.execPath, ['test/run-all.mjs'], root, env);
  run(process.execPath, ['scripts/build-site.mjs'], root, env);
}
async function inTemporaryCheckout(root, base, operation) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wtf-finalize-'));
  const temp = path.join(parent, 'checkout');
  try {
    run('git', ['worktree', 'add', '--detach', temp, base], root);
    // Dependencies were installed from the trusted main lock with ignore-scripts.
    fs.cpSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), { recursive: true });
    return await operation(temp);
  } finally {
    try { run('git', ['worktree', 'remove', '--force', temp], root); } catch { /* removed below, confined to our temporary directory */ }
    fs.rmSync(parent, { recursive: true, force: true });
  }
}
const headSha = root => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
async function assertFreshMain(api, base) {
  if ((await api.get('/git/ref/heads/main')).object.sha !== base) throw new Error('Main changed; hourly reconciliation will re-evaluate against fresh trusted main');
}
async function assertPublicationEnabled(api) {
  if (!(await api.get('/branches/main')).protected || !(await api.get('')).allow_auto_merge) {
    throw new Error('Publication requires verified main protection and enabled repository auto-merge');
  }
}
export async function prepare(root, api, outDir, { validate = fullValidation, withCheckout = inTemporaryCheckout, clock = Date.now } = {}) {
  const base = headSha(root);
  await assertFreshMain(api, base);
  const inputs = loadFinalizerInputs(root);
  const researchRefs = await api.get('/git/matching-refs/heads/research/');
  const attemptRefs = await api.get('/git/matching-refs/heads/publication/');
  const pulls = await allPulls(api);
  const bundle = { schema_version: 1, base, plans: [], states: [], errors: [] };
  const pattern = new RegExp(`^refs/heads/research/(20\\d\\d-\\d\\d-\\d\\d)-${inputs.research.genre}$`);
  for (const ref of researchRefs.sort((a, b) => a.ref.localeCompare(b.ref))) {
    const match = pattern.exec(ref.ref);
    if (!match) continue;
    const date = match[1];
    const key = `${inputs.research.genre}:${date}`;
    try {
      const merged = inputs.logs.find(log => log.publication?.daily_key === key || new RegExp(`^${date}-${inputs.research.run_prefix}[0-9]+$`).test(log.run_id));
      if (merged) {
        bundle.states.push({ daily_key: key, state: 'merged', run_id: merged.run_id });
        continue;
      }
      const packetPath = `research-inbox/${date}.json`;
      const comparison = await api.get(`/compare/${base}...${ref.object.sha}`);
      assertResearchDiff(comparison.files || [], packetPath, comparison.total_commits >= 250 || comparison.files?.length >= 300);
      const raw = await getFile(api, ref.object.sha, packetPath);
      const packet = JSON.parse(raw);
      if (packet.research_date !== date || dailyKey(packet) !== key) throw new Error('Research branch/date/genre disagree');
      const attemptPattern = new RegExp(`^refs/heads/publication/${date}-${inputs.research.genre}-([1-9][0-9]*)$`);
      const attempts = attemptRefs.flatMap(a => { const m = attemptPattern.exec(a.ref); return m ? [{ ...a, number: Number(m[1]) }] : []; }).sort((a, b) => a.number - b.number);
      const active = pulls.filter(pr => pr.state === 'open' && attempts.some(a => a.ref.slice(11) === pr.head.ref));
      if (active.length > 1) throw new Error('Multiple active publication PRs; refusing ambiguous recovery');
      const last = attempts.at(-1);
      let finalized, branch, reuseSha, closePr;
      if (last) {
        const existingRunId = `${date}-${inputs.research.run_prefix}${last.number}`;
        const existingRaw = await getFile(api, last.object.sha, `data/run-logs/${existingRunId}.json`);
        const log = JSON.parse(existingRaw);
        const unchanged = log.publication?.packet_hash === hash(raw) && log.publication?.research_commit === ref.object.sha
          && log.publication?.evaluated_base === base && log.publication?.policy_fingerprint === inputs.policyFingerprint;
        if (unchanged) {
          finalized = finalizeResearch(packet, inputs, { now: Date.parse(log.timestamp), researchCommit: ref.object.sha,
            evaluatedBase: base, packetHash: hash(raw), reservedRunIds: attempts.filter(a => a !== last).map(a => `${date}-${inputs.research.run_prefix}${a.number}`) });
          if (finalized.log.run_id !== existingRunId || serialize(finalized.log) !== existingRaw) throw new Error('Frozen attempt does not match deterministic re-evaluation');
          branch = last.ref.slice(11);
          reuseSha = last.object.sha;
          const previousPr = pulls.find(pr => pr.head.ref === branch);
          if (previousPr?.state === 'closed') throw new Error('Unmerged publication was closed; explicit review is required before reopening');
        } else {
          closePr = active[0]?.number;
        }
      }
      if (!finalized) {
        finalized = finalizeResearch(packet, inputs, { now: clock(), researchCommit: ref.object.sha, evaluatedBase: base,
          packetHash: hash(raw), reservedRunIds: attempts.map(a => `${date}-${inputs.research.run_prefix}${a.number}`) });
        const number = finalized.log.run_id.slice(`${date}-${inputs.research.run_prefix}`.length);
        branch = `publication/${date}-${inputs.research.genre}-${number}`;
      }
      const render = () => withCheckout(root, base, async temp => {
        const names = await writeFinalized(temp, finalized);
        if (reuseSha) {
          const comparison = await api.get(`/compare/${base}...${reuseSha}`);
          if (comparison.total_commits >= 250 || JSON.stringify(comparison.files?.map(f => f.filename).sort()) !== JSON.stringify(names.sort())) throw new Error('Frozen attempt contains unauthorized changes');
          for (const name of names) {
            const prior = await getFile(api, reuseSha, name);
            // Automation state is a derived snapshot. Retain its exact frozen
            // bytes on a retry; the build always derives its effective live state.
            if (name === 'data/automation-state.json') {
              if (JSON.stringify(JSON.parse(prior)) !== JSON.stringify(readJson(path.join(temp, name)))) {
                const error = new Error('Effective state changed; attempt requires re-evaluation'); error.code = 'STALE_STATE'; throw error;
              }
            } else if (prior !== fs.readFileSync(path.join(temp, name), 'utf8')) throw new Error('Frozen artifact differs from deterministic output');
          }
        }
        validate(temp, base);
        return Object.fromEntries(names.map(name => { const content = fs.readFileSync(path.join(temp, name), 'utf8'); return [name, { content, sha256: hash(content) }]; }));
      });
      let files;
      try { files = await render(); }
      catch (error) {
        if (error.code !== 'STALE_STATE' || !reuseSha) throw error;
        closePr = active[0]?.number;
        reuseSha = null;
        finalized = finalizeResearch(packet, inputs, { now: clock(), researchCommit: ref.object.sha, evaluatedBase: base,
          packetHash: hash(raw), reservedRunIds: attempts.map(a => `${date}-${inputs.research.run_prefix}${a.number}`) });
        branch = `publication/${date}-${inputs.research.genre}-${finalized.log.run_id.slice(`${date}-${inputs.research.run_prefix}`.length)}`;
        files = await render();
      }
      bundle.plans.push({ branch, run_id: finalized.log.run_id, accepted: finalized.log.accepted, daily_key: key,
        research_branch: ref.ref.slice(11), research_commit: ref.object.sha, reuse_sha: reuseSha || null, close_pr: closePr || null, files });
      bundle.states.push({ daily_key: key, state: reuseSha ? 'PR_open' : 'research_staged', run_id: finalized.log.run_id });
    } catch (error) {
      bundle.errors.push({ daily_key: key, error: error.message });
      bundle.states.push({ daily_key: key, state: 'finalization_failed' });
    }
  }
  const today = `${inputs.research.genre}:${berlinDate(clock())}`;
  if (!bundle.states.some(s => s.daily_key === today)) {
    const prior = inputs.logs.find(log => log.publication?.daily_key === today || new RegExp(`^${berlinDate(clock())}-${inputs.research.run_prefix}[0-9]+$`).test(log.run_id));
    bundle.states.push({ daily_key: today, state: prior ? 'merged' : 'not_started', ...(prior ? { run_id: prior.run_id } : {}) });
  }
  await assertFreshMain(api, base);
  assertBundle(bundle);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bundle.json'), serialize(bundle));
  return bundle;
}

export async function publish(bundle, api) {
  assertBundle(bundle);
  const results = [];
  // Only one plan may be published per fresh base. Remaining packets stay in
  // their research branches and are picked up after merge by reconciliation.
  // This avoids creating mutually out-of-date PRs under strict protection.
  const plan = bundle.plans[0];
  const currentMain = (await api.get('/git/ref/heads/main')).object.sha;
  if (currentMain !== bundle.base) {
    const stale = new Error('Main changed; hourly reconciliation will re-evaluate against fresh trusted main');
    try {
      if (plan && await matchesMergedPlan(api, currentMain, plan)) {
        return [{ daily_key: plan.daily_key, state: 'merged', run_id: plan.run_id, revision: currentMain }];
      }
    } catch (error) { stale.cause = error; }
    throw stale;
  }
  if (!plan) return results;
  await assertPublicationEnabled(api);
  if ((await api.get(`/git/ref/heads/${plan.research_branch}`)).object.sha !== plan.research_commit) throw new Error('Research changed after validation; retry from the persisted packet');
  let pulls = await allPulls(api);
  const ownPr = pulls.find(p => p.head.ref === plan.branch && p.state === 'open');
  if (plan.close_pr) {
    const previous = pulls.find(p => p.number === plan.close_pr);
    if (!previous || previous.state !== 'open' || !previous.head.ref.startsWith(`publication/${plan.daily_key.split(':')[1]}-${plan.daily_key.split(':')[0]}-`)) throw new Error('Superseded PR changed; reconcile again');
    if (previous.auto_merge) await api.graphql('mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}', { id: previous.node_id });
    await api.patch(`/pulls/${previous.number}`, { state: 'closed' });
    await assertFreshMain(api, bundle.base);
  }
  const active = pulls.filter(p => p.state === 'open' && p.number !== plan.close_pr && p.head.ref.startsWith(`publication/${plan.daily_key.split(':')[1]}-${plan.daily_key.split(':')[0]}-`));
  if (active.some(p => p.head.ref !== plan.branch)) throw new Error('An active PR already owns this daily key');
  let commitSha = plan.reuse_sha;
  if (commitSha) {
    if ((await api.get(`/git/ref/heads/${plan.branch}`)).object.sha !== commitSha) throw new Error('Frozen publication branch changed after validation');
  } else {
    const parent = await api.get(`/git/commits/${bundle.base}`);
    const tree = await api.post('/git/trees', { base_tree: parent.tree.sha,
      tree: Object.entries(plan.files).map(([file, value]) => ({ path: file, mode: '100644', type: 'blob', content: value.content })) });
    const commit = await api.post('/git/commits', { message: `Finalize ${plan.daily_key} (${plan.run_id})`, tree: tree.sha, parents: [bundle.base] });
    await assertFreshMain(api, bundle.base);
    await api.post('/git/refs', { ref: `refs/heads/${plan.branch}`, sha: commit.sha });
    commitSha = commit.sha;
  }
  const pr = ownPr || await api.post('/pulls', { base: 'main', head: plan.branch, title: `Publish ${plan.run_id}`,
    body: `Deterministically finalized ${plan.daily_key}. Full source, run-log, publication, test and build checks passed before this PR.\n\nResearch commit: ${plan.research_commit}\nEvaluated main: ${bundle.base}\nImmutable attempt: ${plan.run_id}\n\nAuto-merge remains subject to required validate checks and branch protection.` });
  if (pr.head.sha !== commitSha) throw new Error('Publication PR head mismatch');
  await api.graphql('mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{id}}}', { id: pr.node_id });
  results.push({ daily_key: plan.daily_key, state: 'PR_open', pull_request: pr.html_url });
  return results;
}

async function verifyMerged(root, bundle) {
  const config = readJson(path.join(root, 'config/catalogs.json'));
  const manifest = { id: config.manifest.id, catalogs: ['movie', 'series'].flatMap(type => config.catalogs.map(c => ({ id: `${c.id}-${type}`, type }))) };
  const expected = deploymentReceipt(root, manifest, Date.now(), bundle.base);
  const research = readJson(path.join(root, 'config/research.json'));
  if (!bundle.states.some(s => s.state === 'merged')) return;
  try {
    await verifyDeployment(research.pages_url, expected);
    bundle.states.filter(s => s.state === 'merged').forEach(s => { s.state = 'deployed'; });
  } catch (error) {
    bundle.errors.push({ deployment: error.message, recovery: 'Existing hourly Pages workflow retries hosting without regenerating discoveries.' });
  }
}
export function prepareMaintenance(root, outDir) {
  const base = headSha(root);
  const file = 'data/library.json';
  const before = fs.readFileSync(path.join(root, file), 'utf8');
  run(process.execPath, ['scripts/resolve-library.mjs'], root);
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  const ready = content !== before;
  if (ready) {
    const oldItems = JSON.parse(before).items;
    const newItems = JSON.parse(content).items;
    if (oldItems.length !== newItems.length || oldItems.some((item, i) => {
      const { imdb_id, ...original } = item;
      const { imdb_id: resolved, ...next } = newItems[i] || {};
      return JSON.stringify(original) !== JSON.stringify(next) || (imdb_id && imdb_id !== resolved);
    })) throw new Error('Metadata maintenance may only fill missing IMDb IDs; content changes require review');
    fullValidation(root, base);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'maintenance.json'), serialize({ base, ready, content, sha256: hash(content) }));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
}
export async function publishMaintenance(root, api, bundle) {
  if (!bundle.ready || bundle.base !== headSha(root) || hash(bundle.content) !== bundle.sha256) throw new Error('Invalid maintenance bundle');
  await assertFreshMain(api, bundle.base);
  await assertPublicationEnabled(api);
  const branch = `maintenance/metadata-${bundle.base.slice(0, 12)}`;
  const pulls = await allPulls(api);
  if (pulls.some(p => p.state === 'open' && p.head.ref.startsWith('maintenance/metadata-') && p.head.ref !== branch)) throw new Error('An older metadata PR requires review before another is created');
  const existing = pulls.find(p => p.head.ref === branch);
  if (existing?.state === 'closed') throw new Error('Metadata PR was closed; explicit review is required');
  let ref;
  try { ref = await api.get(`/git/ref/heads/${branch}`); } catch (error) { if (error.status !== 404) throw error; }
  if (ref) {
    if (await getFile(api, ref.object.sha, 'data/library.json') !== bundle.content) throw new Error('Frozen metadata branch differs from validated output');
    const comparison = await api.get(`/compare/${bundle.base}...${ref.object.sha}`);
    if (comparison.files?.length !== 1 || comparison.files[0].filename !== 'data/library.json') throw new Error('Unauthorized metadata branch changes');
  } else {
    const parent = await api.get(`/git/commits/${bundle.base}`);
    const tree = await api.post('/git/trees', { base_tree: parent.tree.sha, tree: [{ path: 'data/library.json', mode: '100644', type: 'blob', content: bundle.content }] });
    const commit = await api.post('/git/commits', { message: 'Resolve missing library IMDb metadata', tree: tree.sha, parents: [bundle.base] });
    await assertFreshMain(api, bundle.base);
    await api.post('/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  const pr = existing || await api.post('/pulls', { base: 'main', head: branch, title: 'Resolve missing library IMDb metadata',
    body: 'Fill missing IMDb IDs without changing existing content or identities. The full validation, test and build sequence passed before this PR.' });
  await api.graphql('mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{id}}}', { id: pr.node_id });
  return pr.html_url;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, bundleDir = '.publication-bundle'] = process.argv.slice(2);
  const root = process.cwd();
  if (command === 'validate') {
    fullValidation(root, process.env.PUBLICATION_BASE || undefined);
  } else if (command === 'prepare-maintenance') {
    prepareMaintenance(root, bundleDir);
  } else if (command === 'verify-bundle') {
    const bundle = assertBundle(readJson(path.join(bundleDir, 'bundle.json')));
    if (headSha(root) !== bundle.base) throw new Error('Bundle must be consumed by the exact trusted-main revision that validated it');
    console.log('Trusted publication bundle verified');
  } else {
    const api = githubClient(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
    if (command === 'prepare') {
      const bundle = await prepare(root, api, bundleDir);
      await verifyMerged(root, bundle);
      fs.writeFileSync(path.join(bundleDir, 'bundle.json'), serialize(bundle));
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `trusted_sha=${bundle.base}\nready=${bundle.plans.length > 0}\nfailures=${bundle.errors.length}\n`);
      console.log(JSON.stringify({ states: bundle.states, errors: bundle.errors }));
    } else if (command === 'publish') console.log(JSON.stringify(await publish(readJson(path.join(bundleDir, 'bundle.json')), api)));
    else if (command === 'publish-maintenance') console.log(await publishMaintenance(root, api, readJson(path.join(bundleDir, 'maintenance.json'))));
    else throw new Error('usage: publish-research.mjs <prepare|verify-bundle|publish> [bundle-directory]');
  }
}
