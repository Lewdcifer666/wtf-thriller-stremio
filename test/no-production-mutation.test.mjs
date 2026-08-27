// The test suite must never leave tracked production state modified.
//
// This exists because it already happened: several tests treated
// data/personalized-scores.json as a disposable fixture, and the first `npm
// test` after the live F2-9 run deleted a tracked production file. Tests that
// temporarily overwrite real files are legitimate; tests that fail to put them
// back are not.
//
// Runs the whole suite in a child process and compares a SHA-256 census of every
// tracked file under data/ and config/, plus the canonical prompt, before and
// after. Deliberately run LAST so the files it censuses have already been
// through every other test's fixtures.
//
// Run with: node test/no-production-mutation.test.mjs

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

let passed = 0, failed = 0;
const check = (id, description, condition, detail) => {
  if (condition) { passed++; console.log(`  ok   ${id}  ${description}`); }
  else { failed++; console.error(`  FAIL ${id}  ${description}${detail ? `\n         ${detail}` : ""}`); }
};

console.log("Production state preservation");
console.log("");

const WATCHED = ["data", "config", "DAILY_AUTOMATION_PROMPT.md"];

function census() {
  const out = new Map();
  const add = file => {
    if (!fs.existsSync(file)) { out.set(file, "ABSENT"); return; }
    out.set(file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  };
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else add(full);
    }
  };
  for (const target of WATCHED) {
    if (!fs.existsSync(target)) { out.set(target, "ABSENT"); continue; }
    if (fs.statSync(target).isDirectory()) walk(target);
    else add(target);
  }
  return out;
}

// Files the suite is EXPECTED to write to temporarily. Being on this list does
// not exempt them from having to be restored - it only names them for the
// report when they are not.
const TEMPORARILY_WRITTEN = ["data/personalized-scores.json"];

const before = census();
const dirtyBefore = (() => {
  try { return execFileSync("git", ["status", "--porcelain", "--", ...WATCHED], { encoding: "utf8" }).trim(); }
  catch { return null; }
})();
check("C1", `censused ${before.size} tracked files under ${WATCHED.join(", ")}`, before.size > 0);

// Run the suite that actually touches production paths. build-site is included
// because it is what the fixtures rebuild through.
// Discovered, not listed. A hardcoded suite list silently stops covering any
// test added later - which is exactly when a new fixture starts writing to a
// production path. Everything in test/ runs except this file (which would
// recurse) and the helpers, which are imported rather than executed.
const NOT_A_SUITE_MEMBER = new Set(["no-production-mutation.test.mjs", "safe-fixture.mjs", "run-all.mjs"]);
const SUITE = fs.readdirSync("test")
  .filter(name => name.endsWith(".mjs") && !NOT_A_SUITE_MEMBER.has(name))
  .sort()
  .map(name => path.join("test", name));

let suiteOk = true;
for (const t of SUITE) {
  try { execFileSync(process.execPath, [t], { stdio: "pipe" }); }
  catch { suiteOk = false; console.error(`         suite member failed: ${t}`); }
}
check("C2", `every suite member ran (${SUITE.length} discovered)`, suiteOk && SUITE.length > 0);

const after = census();

const changed = [];
for (const [file, hash] of before) {
  const now = after.get(file);
  if (now !== hash) changed.push(`${file}: ${hash === "ABSENT" ? "created" : now === "ABSENT" ? "DELETED" : "MODIFIED"}`);
}
for (const file of after.keys()) if (!before.has(file)) changed.push(`${file}: created`);

check("C3", "no tracked file under data/ or config/ changed across the suite",
  changed.length === 0, changed.join("\n         "));
check("C4", "the canonical prompt is unchanged across the suite",
  before.get("DAILY_AUTOMATION_PROMPT.md") === after.get("DAILY_AUTOMATION_PROMPT.md"));

for (const file of TEMPORARILY_WRITTEN) {
  check("C5", `${file} survives the suite in its original state`,
    before.get(file) === after.get(file),
    `${before.get(file)} -> ${after.get(file)}`);
}

// git must agree. The invariant is NOT "the working tree is clean" - a developer
// may legitimately have uncommitted work in progress, as was the case when this
// check was first written and it failed on an unrelated edit. The invariant is
// that the SUITE does not change what git considers dirty.
{
  const gitDirty = () => {
    try {
      return execFileSync("git", ["status", "--porcelain", "--", ...WATCHED], { encoding: "utf8" }).trim();
    } catch { return null; }
  };
  const dirtyAfter = gitDirty();
  if (dirtyAfter === null) {
    check("C6", "git is unavailable; the SHA census above is the authority", true);
  } else {
    check("C6", "the suite did not change git's view of data/, config/ or the prompt",
      dirtyAfter === dirtyBefore,
      `before: ${JSON.stringify(dirtyBefore)}
         after:  ${JSON.stringify(dirtyAfter)}`);
  }
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
