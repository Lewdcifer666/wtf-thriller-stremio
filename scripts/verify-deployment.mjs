import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function deploymentReceipt(root, manifest, now, revision) {
  if (!revision) {
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { revision = null; } // Generated fixtures have no Git history.
  }
  const dir = path.join(root, 'data/run-logs');
  const runs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(name => {
    const bytes = fs.readFileSync(path.join(dir, name));
    const log = JSON.parse(bytes);
    return { run_id: log.run_id, daily_key: log.publication?.daily_key || null,
      log_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      accepted: log.accepted_items.map(i => typeof i === 'string' ? { imdb_id: i } : { imdb_id: i.imdb_id, type: i.type }) };
  }) : [];
  return { schema_version: 1, revision, built_at: new Date(now).toISOString(), manifest_id: manifest.id,
    catalogs: manifest.catalogs.map(({ id, type }) => ({ id, type })), runs };
}
export async function verifyDeployment(baseUrl, expected, { fetchJson = async url => {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Deployment HTTP ${response.status}: ${url}`);
  return response.json();
}, requireRevision = true } = {}) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  if (base.protocol !== 'https:' && base.hostname !== 'localhost') throw new Error('Deployment URL must use HTTPS');
  const load = relative => fetchJson(new URL(relative, base).href);
  const receipt = await load('publication-receipt.json');
  if (receipt.schema_version !== 1 || (requireRevision && receipt.revision !== expected.revision)) throw new Error('Deployed revision does not match');
  if (receipt.manifest_id !== expected.manifest_id || JSON.stringify(receipt.catalogs) !== JSON.stringify(expected.catalogs)) throw new Error('Deployment catalog identity changed');
  const manifest = await load('manifest.json');
  if (manifest.id !== expected.manifest_id || JSON.stringify(manifest.catalogs.map(({ id, type }) => ({ id, type }))) !== JSON.stringify(expected.catalogs)) throw new Error('Served manifest does not match receipt');
  for (const run of expected.runs) {
    const actual = receipt.runs?.find(r => r.run_id === run.run_id);
    if (JSON.stringify(actual) !== JSON.stringify(run)) throw new Error(`Finalized run missing or changed in deployment: ${run.run_id}`);
  }
  const publicIds = new Set();
  for (const catalog of expected.catalogs.filter(c => c.id === `full-watchlist-${c.type}`)) {
    const payload = await load(`catalog/${catalog.type}/${catalog.id}.json`);
    if (!Array.isArray(payload.metas)) throw new Error('Malformed served catalog');
    payload.metas.forEach(m => publicIds.add(`${catalog.type}:${m.id}`));
  }
  // Only new provenance runs are required here: historical IDs may be absent
  // after a separately reviewed watched/removal migration.
  for (const run of expected.runs.filter(r => r.daily_key)) for (const item of run.accepted) {
    if (!publicIds.has(`${item.type}:${item.imdb_id}`)) throw new Error(`Accepted IMDb identity not visible: ${item.type}:${item.imdb_id}`);
  }
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [baseUrl, expectedFile = 'site/publication-receipt.json'] = process.argv.slice(2);
  if (!baseUrl) throw new Error('usage: verify-deployment.mjs <Pages URL> [expected receipt]');
  await verifyDeployment(baseUrl, JSON.parse(fs.readFileSync(expectedFile, 'utf8')));
  console.log('Deployment revision, runs, manifest and accepted identities verified');
}
