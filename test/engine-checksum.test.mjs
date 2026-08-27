// Engine drift detection.
//
// Every file listed in test/engine-checksums.json is VENDORED: it was copied
// verbatim from the canonical template and this repo does not own it. The
// checksums were recorded at generation time.
//
// A mismatch means someone edited a shared engine file in place. That is the
// one thing the vendoring strategy exists to prevent: five repos each holding
// their own quietly-diverging copy of the scorer is strictly worse than one
// shared package. Intentional engine changes go into the template first and are
// then regenerated into every affected repo.
//
// This test cannot catch a change made in the template AND regenerated here -
// that is the sanctioned path. It catches the local edit.
//
// Run with: node test/engine-checksum.test.mjs

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let passed = 0, failed = 0;
const check = (id, description, condition, detail) => {
  if (condition) { passed++; console.log(`  ok   ${id}  ${description}`); }
  else { failed++; console.error(`  FAIL ${id}  ${description}${detail ? `\n         ${detail}` : ""}`); }
};

console.log("Vendored engine integrity");
console.log("");

const manifestFile = path.join(here, "engine-checksums.json");
check("EC0", "test/engine-checksums.json exists", fs.existsSync(manifestFile),
  "without it there is no drift protection at all");

if (!fs.existsSync(manifestFile)) {
  console.error("\n1 failed");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

check("EC1", "manifest declares a template revision",
  typeof manifest.template_revision === "string" && manifest.template_revision.length > 0);
check("EC2", "manifest lists at least one vendored file",
  manifest.files && Object.keys(manifest.files).length > 0);

const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

for (const [relative, expected] of Object.entries(manifest.files || {})) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    check("EC3", `${relative} is present`, false, "vendored engine file is missing");
    continue;
  }
  const actual = sha256(file);
  check("EC3", `${relative} matches the template`, actual === expected,
    actual === expected ? "" :
      `expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…\n` +
      `         This file is vendored and must not be edited here. Change the ` +
      `canonical template and regenerate.`);
}

// A vendored file must not carry CRLF: the checksum is over raw bytes, so a
// line-ending conversion by an editor or by git would read as engine drift.
for (const relative of Object.keys(manifest.files || {})) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  check("EC4", `${relative} is LF-only`, !text.includes("\r\n"),
    "CRLF in a checksummed file would be indistinguishable from a real edit");
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
