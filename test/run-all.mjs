// Run every suite in a temporary copy. Legacy fixture tests can never write
// data in the developer's original source checkout, even temporarily.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function census(dir, prefix = '') {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['node_modules', '.git', 'site', '.publication-bundle'].includes(entry.name)) continue;
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, census(path.join(dir, entry.name), relative + '/'));
    else result[relative] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name))).digest('hex');
  }
  return result;
}
if (!process.argv.includes('--isolated')) {
  const before = JSON.stringify(census(root));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtf-suite-'));
  let status = 0;
  try {
    fs.cpSync(root, temp, { recursive: true, filter: source => !['node_modules', '.git', 'site', '.publication-bundle'].includes(path.basename(source)) });
    if (fs.existsSync(path.join(root, 'node_modules'))) fs.cpSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), { recursive: true });
    execFileSync(process.execPath, ['test/run-all.mjs', '--isolated'], { cwd: temp, stdio: 'inherit', env: { ...process.env, PUBLICATION_BASE: '', WTF_ISOLATED_TEST_ROOT: temp } });
  } catch { status = 1; }
  finally {
    fs.rmSync(temp, { recursive: true, force: true });
    if (JSON.stringify(census(root)) !== before) { console.error('Tests changed the original source checkout'); status = 1; }
  }
  process.exit(status);
}
if (process.env.WTF_ISOLATED_TEST_ROOT !== root || !root.startsWith(os.tmpdir() + path.sep)) throw new Error('Isolated tests require an owned temporary checkout');
const last = 'no-production-mutation.test.mjs';
const discovered = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort();
const suite = [...discovered.filter(n => n !== last), ...discovered.filter(n => n === last)];
if (!suite.length) throw new Error('No tests discovered');
const failures = [];
for (const name of suite) {
  try { execFileSync(process.execPath, [`test/${name}`], { cwd: root, stdio: 'inherit' }); }
  catch { failures.push(name); }
}
console.log(`${suite.length - failures.length}/${suite.length} suites passed in an isolated checkout`);
if (failures.length) { console.error(failures.join(', ')); process.exitCode = 1; }
