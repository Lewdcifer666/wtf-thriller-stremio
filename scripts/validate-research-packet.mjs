import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { CANONICAL_DIMENSIONS, CANONICAL_DNA_TAGS } from './registry.mjs';
import { validateProfile, validateItemDna } from './validate-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/research-packet.schema.json'), 'utf8'));
const shape = new Ajv({ allErrors: true, strict: true }).compile(schema);
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function berlinDate(now = Date.now(), timeZone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
export function sourceUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password
      || /[\s;,]/.test(value)) throw new Error('source must be an unambiguous public HTTP(S) URL');
  url.hash = '';
  return url.href;
}
export function validateResearchPacket(packet, { profile, research, now = Date.now() }) {
  const errors = [];
  if (!shape(packet)) return shape.errors.map(e => `${e.instancePath || '/'} ${e.message}`);
  errors.push(...validateProfile(profile).map(e => `profile: ${e}`));
  if (research?.schema_version !== 1 || !/^[a-z][a-z0-9-]*$/.test(research.genre)
      || !/^[a-z]+$/.test(research.run_prefix) || research.timezone !== 'Europe/Berlin'
      || !Number.isInteger(research.minimum_sources) || research.minimum_sources < 1
      || typeof research.require_all_known !== 'boolean') errors.push('invalid trusted research configuration');
  if (packet.genre !== research.genre) errors.push('genre does not match repository');
  const date = new Date(`${packet.research_date}T12:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== packet.research_date) errors.push('invalid research_date');
  if (packet.research_date > berlinDate(now)) errors.push('research_date is in the future in Europe/Berlin');
  const dimensions = new Set(CANONICAL_DIMENSIONS);
  const tags = new Set(CANONICAL_DNA_TAGS);
  for (const [i, item] of packet.candidates.entries()) {
    const prefix = `candidates[${i}]`;
    if (!item.title.trim() || !item.reason.trim()) errors.push(`${prefix}: empty title/reason`);
    errors.push(...validateItemDna(item, dimensions, tags).map(e => `${prefix}: ${e}`));
    // Completeness for ingestion is an explicit per-profile rule. The scorer
    // separately enforces that profile's required-known and row requirements.
    if (research.require_all_known && CANONICAL_DIMENSIONS.some(d => !Number.isInteger(item.dna[d]))) {
      errors.push(`${prefix}: this profile requires every DNA dimension to be known`);
    }
    for (const tag of item.tags || []) if (!profile.controlled_tags.includes(tag)) errors.push(`${prefix}: unknown tag ${tag}`);
    if (item.external_ids && !research.allow_external_ids) errors.push(`${prefix}: external_ids are not enabled for this profile`);
    const urls = [];
    for (const source of item.sources) {
      try { urls.push(sourceUrl(source.url)); } catch (e) { errors.push(`${prefix}: ${e.message}`); }
    }
    if (new Set(urls).size !== urls.length) errors.push(`${prefix}: repeated source document`);
    if (new Set(urls).size < research.minimum_sources) errors.push(`${prefix}: requires ${research.minimum_sources} distinct sources`);
    if (research.require_non_metadata_source && !item.sources.some(s => {
      try { return ['structure', 'review', 'whole_runtime'].includes(s.purpose) && !new URL(sourceUrl(s.url)).hostname.includes('cinemeta'); }
      catch { return false; }
    })) errors.push(`${prefix}: requires non-metadata evidence`);
  }
  for (const [i, entry] of packet.research_rejections.entries()) {
    if (!entry.title.trim() || !entry.reason.trim()) errors.push(`research_rejections[${i}]: empty title/reason`);
  }
  return errors;
}
export function assertResearchPacket(packet, context) {
  const errors = validateResearchPacket(packet, context);
  if (errors.length) throw new Error(`Invalid research packet:\n${errors.join('\n')}`);
  return packet;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: validate-research-packet.mjs <packet>');
  assertResearchPacket(readJson(file), { profile: readJson('data/taste-profile.json'), research: readJson('config/research.json') });
  console.log('Research packet is valid');
}
