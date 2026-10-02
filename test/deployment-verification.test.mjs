import assert from 'node:assert/strict';
import { verifyDeployment } from '../scripts/verify-deployment.mjs';
const expected = { schema_version: 1, revision: 'a'.repeat(40), manifest_id: 'com.test',
  catalogs: [{ id: 'full-watchlist-movie', type: 'movie' }],
  runs: [{ run_id: '2020-01-02-t1', daily_key: 'thriller:2020-01-02', log_sha256: 'b'.repeat(64), accepted: [{ imdb_id: 'tt123', type: 'movie' }] }] };
const manifest = { id: expected.manifest_id, catalogs: expected.catalogs };
const data = { 'publication-receipt.json': expected, 'manifest.json': manifest, 'catalog/movie/full-watchlist-movie.json': { metas: [{ id: 'tt123' }] } };
const fetchJson = async url => structuredClone(data[new URL(url).pathname.slice(1)]);
await verifyDeployment('https://example.org', expected, { fetchJson });
data['publication-receipt.json'] = { ...expected, revision: 'c'.repeat(40) };
await assert.rejects(verifyDeployment('https://example.org', expected, { fetchJson }), /revision/);
data['publication-receipt.json'] = expected;
data['manifest.json'] = { ...manifest, id: 'changed' };
await assert.rejects(verifyDeployment('https://example.org', expected, { fetchJson }), /manifest/);
data['manifest.json'] = manifest;
data['catalog/movie/full-watchlist-movie.json'] = { metas: [] };
await assert.rejects(verifyDeployment('https://example.org', expected, { fetchJson }), /not visible/);
data['catalog/movie/full-watchlist-movie.json'] = { metas: [{ id: 'tt123' }] };
data['publication-receipt.json'] = { ...expected, runs: [] };
await assert.rejects(verifyDeployment('https://example.org', expected, { fetchJson }), /run missing/);
await assert.rejects(verifyDeployment('https://example.org', expected, { fetchJson: async () => { throw new Error('Hosting unavailable'); } }), /Hosting unavailable/);
const zero = { ...expected, runs: [{ ...expected.runs[0], accepted: [] }] };
data['publication-receipt.json'] = zero;
await verifyDeployment('https://example.org', zero, { fetchJson });
console.log('Deployment verification: revision, receipt, manifest, IMDb visibility, zero findings and hosting failure passed');
