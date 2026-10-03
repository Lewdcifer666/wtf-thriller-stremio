import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadFinalizerInputs, jsonFiles, forms, policyFingerprint } from './finalize-research.mjs';
import { makePolicy, scoreItem } from './dna-score.mjs';

export function validatePublication(root, { now = Date.now(), base } = {}) {
  const errors = [];
  const inputs = loadFinalizerInputs(root);
  const policy = makePolicy(inputs.profile);
  const row = inputs.catalogs.catalogs.find(c => c.id === 'dna-match');
  const fingerprint = policyFingerprint(root);
  const keys = new Set();
  const added = new Set();
  if (base) {
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('PUBLICATION_BASE must be a commit SHA');
    const changes = execFileSync('git', ['diff', '--name-status', '--no-renames', base, '--', 'data/discoveries', 'data/run-logs', 'data/discovery-log.json'], { cwd: root, encoding: 'utf8' });
    for (const line of changes.trim().split('\n').filter(Boolean)) {
      const [status, file] = line.split('\t');
      if (status !== 'A') errors.push(`Immutable history changed: ${file}`);
      else if (file.startsWith('data/run-logs/') && file.endsWith('.json')) added.add(path.basename(file, '.json'));
    }
  }
  for (const name of jsonFiles(path.join(root, 'data/run-logs'))) {
    const log = JSON.parse(fs.readFileSync(path.join(root, 'data/run-logs', name), 'utf8'));
    const fail = message => errors.push(`${name}: ${message}`);
    const p = log.publication;
    if (!p) { if (added.has(log.run_id)) fail('new run requires code-generated publication provenance'); continue; }
    if (p.schema_version !== 1 || Object.keys(p).sort().join(',') !== ['schema_version','daily_key','packet_hash','research_commit','evaluated_base','policy_fingerprint'].sort().join(',')) fail('unsupported provenance shape');
    for (const field of ['packet_hash', 'policy_fingerprint']) if (!/^[a-f0-9]{64}$/.test(p[field] || '')) fail(`invalid ${field}`);
    for (const field of ['research_commit', 'evaluated_base']) if (!/^[a-f0-9]{40}$/.test(p[field] || '')) fail(`invalid ${field}`);
    const date = log.run_id?.slice(0, 10);
    if (p.daily_key !== `${inputs.research.genre}:${date}` || !new RegExp(`^${date}-${inputs.research.run_prefix}[1-9][0-9]*$`).test(log.run_id)) fail('daily key/run ID disagree');
    if (keys.has(p.daily_key)) fail('duplicate merged daily key');
    keys.add(p.daily_key);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(log.timestamp || '') || !Number.isFinite(Date.parse(log.timestamp)) || Date.parse(log.timestamp) > now) fail('timestamp is invalid or future');
    if (log.searched !== log.accepted + log.rejected + log.duplicates) fail('searched count disagreement');
    if (!Array.isArray(log.rejection_summary) || log.rejection_summary.length !== log.rejected + log.duplicates
      || log.rejection_summary.filter(r => r.category === 'rejected').length !== log.rejected
      || log.rejection_summary.filter(r => r.category === 'duplicates').length !== log.duplicates) fail('rejection accounting disagreement');
    const file = path.join(root, 'data/discoveries', name);
    const discovery = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const items = discovery?.items || [];
    if ((log.accepted === 0) !== (discovery === null)) fail('zero-result discovery agreement');
    if (discovery && (discovery.run_id !== log.run_id || discovery.timestamp !== log.timestamp)) fail('discovery/log run or timestamp disagreement');
    if (items.length !== log.accepted || log.accepted_items?.length !== items.length) fail('accepted count disagreement');
    const ids = new Set();
    for (const item of items) {
      const id = `${item.type}:${item.imdb_id}`;
      if (ids.has(id)) fail('duplicate accepted identity');
      ids.add(id);
      if (!forms(item).length || !/^tt[0-9]+$/.test(item.imdb_id)) fail('invalid accepted identity');
      if (item.added_at !== log.timestamp || item.discovery_run_id !== log.run_id || item.added_by !== 'daily-automation') fail('item publication metadata disagree');
      const accepted = log.accepted_items.filter(i => i.type === item.type && i.imdb_id === item.imdb_id);
      if (accepted.length !== 1 || accepted[0].match_score !== item.match_score || accepted[0].title !== item.title) fail('accepted identity/title/score disagreement');
      // Frozen historical scores belong to their evaluated policy. Newly added
      // runs must use this checkout's policy; unchanged old history is retained.
      if (added.has(log.run_id) || p.policy_fingerprint === fingerprint) {
        if (p.policy_fingerprint !== fingerprint) fail('publication used a stale policy');
        const result = scoreItem(policy, row, item, new Map());
        if (result.score === null || result.score !== item.match_score || result.score < inputs.profile.automation_rules.minimum_match_score) fail('stored score does not re-derive or is below threshold');
      }
    }
    for (const type of ['movie', 'series']) if (items.filter(i => i.type === type).length > inputs.profile.automation_rules[`daily_${type}_max`]) fail(`daily ${type} limit exceeded`);
  }
  return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validatePublication(process.cwd(), { base: process.env.PUBLICATION_BASE || undefined });
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Publication validation OK');
}
