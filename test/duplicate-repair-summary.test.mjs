import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairPushDuplicates } from "../scripts/repair-push-duplicates.mjs";

const originalCwd = process.cwd();
const originalEnv = { ADDED_FILES: process.env.ADDED_FILES, MODIFIED_FILES: process.env.MODIFIED_FILES };
const known = { type: "movie", title: "Known title", year: 2020, imdb_id: "tt9100001" };
const fresh = { type: "movie", title: "New title", year: 2021, imdb_id: "tt9100002" };
let passed = 0;

function verify(name, summary, { legacy = false, onlyDuplicate = false } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wtf-duplicate-repair-"));
  const write = (relative, value) => {
    const target = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value) + "\n");
  };
  const read = relative => JSON.parse(fs.readFileSync(path.join(fixture, relative), "utf8"));
  try {
    const items = onlyDuplicate ? [known] : [known, fresh];
    const run = { run_id: "audit", accepted: items.length, duplicates: 2, accepted_items: items,
      rejection_summary: summary, duplicate_repair_notes: ["Earlier diagnostic"] };
    write("data/library.json", { items: [known] });
    write("data/discoveries/audit.json", { run_id: "audit", items });
    write(legacy ? "data/discovery-log.json" : "data/run-logs/audit.json", legacy ? { runs: [run] } : run);
    process.chdir(fixture);
    process.env.ADDED_FILES = JSON.stringify(["data/discoveries/audit.json"]);
    process.env.MODIFIED_FILES = "[]";
    repairPushDuplicates();
    const result = legacy ? read("data/discovery-log.json").runs[0] : read("data/run-logs/audit.json");
    assert.equal(result.accepted, onlyDuplicate ? 0 : 1);
    assert.equal(result.duplicates, 3);
    assert.deepEqual(result.accepted_items, onlyDuplicate ? [] : [fresh]);
    if (typeof summary === "string") {
      assert.ok(result.rejection_summary.startsWith(summary));
      assert.match(result.rejection_summary, /Automatic duplicate repair removed Known title/);
    } else {
      assert.deepEqual(result.rejection_summary, summary, "structured rejection evidence must survive exactly");
      assert.equal(result.duplicate_repair_notes[0], "Earlier diagnostic");
      assert.match(result.duplicate_repair_notes[1], /Automatic duplicate repair removed Known title/);
    }
    if (onlyDuplicate) {
      assert.equal(fs.existsSync(path.join(fixture, "data/discoveries/audit.json")), false);
    } else {
      assert.deepEqual(read("data/discoveries/audit.json").items, [fresh]);
      const before = fs.readFileSync(path.join(fixture, legacy ? "data/discovery-log.json" : "data/run-logs/audit.json"), "utf8");
      repairPushDuplicates();
      assert.equal(fs.readFileSync(path.join(fixture, legacy ? "data/discovery-log.json" : "data/run-logs/audit.json"), "utf8"), before,
        "a retry with no duplicates must not rewrite evidence or increase counts");
    }
    passed++;
    console.log(`  ok   ${name}`);
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const resolved = fs.realpathSync(fixture);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("wtf-duplicate-repair-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

const array = [{ title: "Rejected title", reason: "Original research", sources: ["https://example.org/evidence"] }];
const object = { researched: { title: "Rejected title", reasons: ["Pacing", "Weak payoff"] }, total: 1 };
verify("immutable array evidence preserved", array);
verify("immutable object evidence preserved", object);
verify("legacy structured evidence preserved", object, { legacy: true });
verify("empty array remains an empty array when all discoveries are duplicates", [], { onlyDuplicate: true });
verify("string evidence retained with existing repair diagnostic format", "Original string evidence");
console.log(`Duplicate-repair summaries: ${passed} offline cases passed.`);
