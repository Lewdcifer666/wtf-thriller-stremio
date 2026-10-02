import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFinalizerInputs } from '../../../scripts/finalize-research.mjs';
export const clone = value => structuredClone(value);
export const options = { now: Date.parse('2026-10-02T10:00:00Z'), researchCommit: 'b'.repeat(40), evaluatedBase: 'c'.repeat(40) };
export function fixture() {
  const inputs = loadFinalizerInputs(process.cwd());
  inputs.logs = [];
  inputs.reservedRunIds = [];
  inputs.publicItems = [];
  inputs.rejections = [];
  const dna = Object.fromEntries(inputs.profile.dna_dimensions.dimensions.map(d => [d.id, inputs.profile.dna_baseline.weights[d.id] < 0 ? 0 : 9]));
  for (const rule of inputs.profile.dna_guardrails.hard_exclusion) dna[rule.dimension] = rule.at_or_above !== undefined ? rule.at_or_above - 1 : rule.at_or_below + 1;
  const candidate = { imdb_id: 'tt999999991', type: 'movie', title: 'Research Fixture', year: 2020,
    reason: 'Whole-runtime evidence supports this test fixture.', sources: [
      { url: 'https://example.org/identity', purpose: 'identity' },
      { url: 'https://example.org/structure', purpose: 'whole_runtime' },
      { url: 'https://example.org/review', purpose: 'review' }], dna, dna_confidence: 1, dna_tags: [], tags: [] };
  const packet = { schema_version: 1, genre: inputs.research.genre, research_date: '2020-01-02', candidates: [candidate], research_rejections: [] };
  return { inputs, packet, candidate };
}
export async function inFixture(callback) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtf-research-test-'));
  try {
    fs.cpSync(process.cwd(), temp, { recursive: true, filter: source => !['node_modules', '.git', 'site', '.publication-bundle'].includes(path.basename(source)) });
    if (fs.existsSync('node_modules')) fs.cpSync(path.resolve('node_modules'), path.join(temp, 'node_modules'), { recursive: true });
    return await callback(temp);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
