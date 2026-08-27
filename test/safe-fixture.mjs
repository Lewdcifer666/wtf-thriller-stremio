// Snapshot/restore for tests that temporarily write over a TRACKED production
// file.
//
// This exists because of a real incident. Several tests treated
// data/personalized-scores.json as a disposable fixture and deleted it in
// cleanup, which was harmless only while that file could never exist. The first
// live F2-9 run created it for real, and the next `npm test` deleted a tracked
// production file.
//
// The restore writes back the ORIGINAL BYTES. It never reserializes parsed
// JSON: a round-trip through JSON.parse/stringify would silently reformat the
// file, and a "restore" that changes bytes is not a restore.

import fs from "node:fs";
import crypto from "node:crypto";

/**
 * Run `body` with the file free to be written, then put it back exactly as it
 * was - restored byte-for-byte if it existed, removed if it did not. `after`
 * runs once the file is back, for anything that must observe the restored
 * state (a rebuild, typically).
 */
export function withProductionFile(file, body, after) {
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file) : null;   // Buffer, not string
  try {
    return body();
  } finally {
    if (existed) fs.writeFileSync(file, original);
    else fs.rmSync(file, { force: true });

    // Prove the restore actually restored, rather than trusting it.
    if (existed) {
      const now = fs.readFileSync(file);
      if (!now.equals(original)) {
        throw new Error(`safe-fixture: ${file} was not restored byte-for-byte`);
      }
    } else if (fs.existsSync(file)) {
      throw new Error(`safe-fixture: ${file} should not exist but does`);
    }
    if (after) after();
  }
}

export function sha256(file) {
  return fs.existsSync(file)
    ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    : null;
}
