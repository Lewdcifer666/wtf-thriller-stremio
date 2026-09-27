import fs from "node:fs";
import path from "node:path";
import { createAutomationState, stateFromBuildReceipt } from "./automation-state.mjs";

const args = process.argv.slice(2);
const outFile = args[0] && !args[0].startsWith("--") ? args.shift() : path.join("data", "automation-state.json");
let state;
if (args.length === 0) {
  state = await createAutomationState(process.cwd());
} else if (args.length === 2 && args[0] === "--from-build") {
  const text = args[1] === "env" ? process.env.BUILT_AUTOMATION_STATE : fs.readFileSync(args[1], "utf8");
  if (!text) throw new Error("The validated build-state receipt is missing");
  state = stateFromBuildReceipt(process.cwd(), JSON.parse(text));
} else {
  throw new Error("Usage: export-automation-state.mjs [output.json] [--from-build <receipt.json|env>]");
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(state, null, 2) + "\n", "utf8");
console.log(`Automation state: ${state.public_identities.length} public identities, ${state.watched_identity_forms.length} watched forms, ${state.rejection_identity_forms.length} rejection forms -> ${outFile}`);
