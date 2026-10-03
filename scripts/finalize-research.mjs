import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertResearchPacket, readJson, sourceUrl } from './validate-research-packet.mjs';
import { readAutomationInputs, createAutomationState } from './automation-state.mjs';
import { watchedEvidenceIdentities } from './validate-profile.mjs';
import { identityForms } from './identity.mjs';
import { normalizeTitle } from './cinemeta.mjs';
import { makePolicy, scoreItem } from './dna-score.mjs';

export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const serialize = value => JSON.stringify(value, null, 2) + '\n';
export const dailyKey = packet => `${packet.genre}:${packet.research_date}`;
export const forms = item => identityForms(item, normalizeTitle);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const intersection = (item, set) => forms(item).some(id => set.has(id));
export const jsonFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort() : [];

export function policyFingerprint(root) {
  const files = ['data/taste-profile.json', 'data/rejections.json', 'config/catalogs.json', 'config/research.json',
    'schemas/research-packet.schema.json', 'package-lock.json',
    ...fs.readdirSync(path.join(root, 'scripts')).filter(n => n.endsWith('.mjs')).sort().map(n => `scripts/${n}`)];
  return hash(Buffer.concat(files.filter(n => fs.existsSync(path.join(root, n))).flatMap(n => [Buffer.from(n + '\0'), fs.readFileSync(path.join(root, n)), Buffer.from('\0')])));
}
export function loadFinalizerInputs(root) {
  const inputs = readAutomationInputs(root);
  const logs = jsonFiles(path.join(root, 'data/run-logs')).map(n => readJson(path.join(root, 'data/run-logs', n)));
  const legacy = fs.existsSync(path.join(root, 'data/discovery-log.json')) ? readJson(path.join(root, 'data/discovery-log.json')).runs || [] : [];
  return { ...inputs, research: readJson(path.join(root, 'config/research.json')), logs: [...legacy, ...logs],
    reservedRunIds: [...new Set([...legacy, ...logs].map(r => r.run_id).concat(inputs.discoveries.map(n => path.basename(n, '.json'))))],
    policyFingerprint: policyFingerprint(root) };
}

// This is the only object from which discoveries and logs are rendered. The
// caller supplies time in tests; production captures its clock exactly once.
export function finalizeResearch(packet, inputs, { now, researchCommit, evaluatedBase, packetHash = hash(serialize(packet)), reservedRunIds = [] }) {
  const timestamp = new Date(now).toISOString();
  assertResearchPacket(packet, { ...inputs, now });
  if (!/^[a-f0-9]{40}$/.test(researchCommit || '') || !/^[a-f0-9]{40}$/.test(evaluatedBase || '')
      || !/^[a-f0-9]{64}$/.test(inputs.policyFingerprint || '') || !/^[a-f0-9]{64}$/.test(packetHash)) throw new Error('Missing code-owned provenance');
  const key = dailyKey(packet);
  const prefix = `${packet.research_date}-${inputs.research.run_prefix}`;
  if (inputs.logs?.some(r => r.publication?.daily_key === key || r.run_id?.match(new RegExp(`^${prefix}[0-9]+$`)))) {
    throw new Error(`Daily run already merged: ${key}`);
  }
  const used = new Set([...(inputs.reservedRunIds || []), ...reservedRunIds]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  const runId = `${prefix}${n}`;
  const policy = makePolicy(inputs.profile);
  const row = inputs.catalogs.catalogs.find(c => c.id === 'dna-match');
  if (!row || row.dna?.mode !== 'baseline_profile') throw new Error('Missing baseline dna-match catalog');
  const known = new Set(inputs.publicItems.flatMap(forms));
  const watched = new Set(watchedEvidenceIdentities(inputs.profile).flatMap(forms));
  const rejected = new Set(inputs.rejections.flatMap(forms));
  const candidatesSeen = new Set();
  const results = [];
  const eligible = [];
  // Canonical order also decides which duplicate record is examined, so packet
  // ordering cannot change acceptance when identities repeat.
  for (const item of [...packet.candidates].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))) {
    let reason;
    let category = 'rejected';
    if (intersection(item, known) || intersection(item, candidatesSeen)) { reason = 'duplicate'; category = 'duplicates'; }
    else if (intersection(item, watched)) reason = 'watched';
    else if (intersection(item, rejected)) reason = 'explicit_rejection';
    forms(item).forEach(id => candidatesSeen.add(id));
    if (!reason) {
      const scored = scoreItem(policy, row, item, new Map());
      if (scored.score === null) reason = scored.reason;
      else if (scored.score < inputs.profile.automation_rules.minimum_match_score) reason = 'below_publication_threshold';
      else eligible.push({ item, score: scored.score });
    }
    if (reason) results.push({ imdb_id: item.imdb_id, type: item.type, title: item.title, category, reason });
  }
  eligible.sort((a, b) => b.score - a.score || compare(normalizeTitle(a.item.title), normalizeTitle(b.item.title))
    || compare(a.item.imdb_id, b.item.imdb_id) || compare(a.item.type, b.item.type));
  const counts = { movie: 0, series: 0 };
  const items = [];
  for (const { item, score } of eligible) {
    const maximum = inputs.profile.automation_rules[`daily_${item.type}_max`];
    if (!Number.isInteger(maximum) || maximum < 0) throw new Error(`Invalid daily limit for ${item.type}`);
    if (counts[item.type] >= maximum) {
      results.push({ imdb_id: item.imdb_id, type: item.type, title: item.title, category: 'rejected', reason: 'daily_limit' });
      continue;
    }
    counts[item.type]++;
    const { sources, ...content } = item;
    items.push({ ...content, status: 'watch', tags: item.tags || [], match_score: score,
      added_at: timestamp, added_by: 'daily-automation', discovery_run_id: runId,
      source: sources.map(s => sourceUrl(s.url)).join(' ; ') });
  }
  for (const entry of packet.research_rejections) results.push({ ...entry, category: 'rejected' });
  const publication = { schema_version: 1, daily_key: key, packet_hash: packetHash, research_commit: researchCommit,
    evaluated_base: evaluatedBase, policy_fingerprint: inputs.policyFingerprint };
  const log = { run_id: runId, timestamp, searched: packet.candidates.length + packet.research_rejections.length,
    accepted: items.length, rejected: results.filter(r => r.category === 'rejected').length,
    duplicates: results.filter(r => r.category === 'duplicates').length,
    accepted_items: items.map(({ imdb_id, type, title, match_score }) => ({ imdb_id, type, title, match_score })),
    rejection_summary: results, publication };
  if (log.searched !== log.accepted + log.rejected + log.duplicates) throw new Error('Internal count disagreement');
  return { log, discovery: items.length ? { schema_version: 1, run_id: runId, timestamp, items } : null };
}

export async function writeFinalized(root, finalized) {
  const beforeState = await createAutomationState(root);
  const outputs = [[`data/run-logs/${finalized.log.run_id}.json`, finalized.log]];
  if (finalized.discovery) outputs.push([`data/discoveries/${finalized.log.run_id}.json`, finalized.discovery]);
  // Check both before writing either. Git tree creation is atomic at publication.
  for (const relative of [`data/run-logs/${finalized.log.run_id}.json`, `data/discoveries/${finalized.log.run_id}.json`]) {
    if (fs.existsSync(path.join(root, relative))) throw new Error(`Refusing immutable overwrite: ${relative}`);
  }
  for (const [relative, value] of outputs) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), serialize(value), { flag: 'wx' });
  }
  const state = await createAutomationState(root);
  if (!beforeState.personalization_enabled && state.personalization_enabled) {
    throw new Error('Publication would activate dormant personalization; requires an explicit learning cutover');
  }
  fs.writeFileSync(path.join(root, 'data/automation-state.json'), serialize(state));
  return [...outputs.map(([name]) => name), 'data/automation-state.json'];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packetFile, researchCommit, evaluatedBase] = process.argv.slice(2);
  if (!evaluatedBase) throw new Error('usage: finalize-research.mjs <packet> <research-commit> <trusted-base> (temporary checkout only)');
  const raw = fs.readFileSync(packetFile);
  const finalized = finalizeResearch(JSON.parse(raw), loadFinalizerInputs(process.cwd()),
    { now: Date.now(), researchCommit, evaluatedBase, packetHash: hash(raw) });
  console.log(JSON.stringify(await writeFinalized(process.cwd(), finalized)));
}
