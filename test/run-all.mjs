// Test runner.
//
// Discovers every test/*.test.mjs rather than listing them, so a repo can add
// its own genre-specific suites without editing a generated file. package.json
// is written by the generator and is NOT genre-owned: a hardcoded list there
// would be silently dropped the next time the repo was regenerated, taking the
// genre's own acceptance tests with it.
//
// no-production-mutation runs LAST, deliberately: it censuses the files every
// other suite has already had its fixtures through.
//
// Run with: node test/run-all.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const LAST = "no-production-mutation.test.mjs";

const discovered = fs.readdirSync(here)
  .filter(name => name.endsWith(".test.mjs"))
  .sort();

const suite = [...discovered.filter(n => n !== LAST), ...discovered.filter(n => n === LAST)];

if (suite.length === 0) {
  console.error("run-all: no test/*.test.mjs found - a repo with no tests is not a passing repo");
  process.exit(1);
}

const failures = [];
for (const name of suite) {
  try {
    execFileSync(process.execPath, [path.join("test", name)], { cwd: root, stdio: "inherit" });
  } catch {
    failures.push(name);
  }
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} of ${suite.length} suites FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`All ${suite.length} suites passed.`);
