// Thriller product acceptance.
//
// This profile exists to stop one specific conflation:
//
//   "there is an investigation"  !=  "the story is telling me anything"
//
// A procedural can contain enormous amounts of inquiry work and still deliver
// almost nothing - long stretches with no meaningful new information, no
// reframing, no forward motion. That is a concrete disappointment, not a
// hypothetical, and this file asserts that the model cannot reward it: not
// through the weights, not through a guardrail gap, and not through an
// archetype bonus.
//
// Run with: node test/thriller-profile.test.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateProfile, watchedEvidenceIdentities } from "../scripts/validate-profile.mjs";
import { makePolicy, scoreItem, hardExcluded, baselineContentPre } from "../scripts/dna-score.mjs";
import { normalizeTitle } from "../scripts/cinemeta.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let passed = 0, failed = 0;
const check = (id, description, condition, detail) => {
  if (condition) { passed++; console.log(`  ok   ${id}  ${description}`); }
  else { failed++; console.error(`  FAIL ${id}  ${description}${detail ? `\n         ${detail}` : ""}`); }
};

const profile = JSON.parse(fs.readFileSync(path.join(root, "data", "taste-profile.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root, "config", "catalogs.json"), "utf8"));
const policy = makePolicy(profile);
const registry = profile.dna_dimensions.dimensions.map(d => d.id);
const weights = profile.dna_baseline.weights;
const row = id => config.catalogs.find(c => c.id === id);

console.log("WTF Thriller Discovery - product acceptance");
console.log("");

// ---------------------------------------------------------------------------
// A-H structure
// ---------------------------------------------------------------------------
const EXPECTED = ["mystery","investigation","clue_puzzling","culprit_hunt","progressive_revelation",
  "revelation_frequency","plot_twists","psychological_strategy","cat_and_mouse","deception",
  "hidden_identity","unreliable_perspective","conspiracy","mole_inside","corruption","surveillance",
  "evidence_manipulation","technology_threat","suspense","action_density","action_intensity",
  "brutality","deadly_game","weirdness","military_focus","romance_focus","drama_focus",
  "visual_quality","retro_visual_style","pace_speed"];

check("A1", "registry declares exactly 30 dimensions", registry.length === 30, `got ${registry.length}`);
check("A2", "registry matches the approved Thriller set exactly",
  [...registry].sort().join(",") === [...EXPECTED].sort().join(","),
  `unexpected: ${registry.filter(d => !EXPECTED.includes(d)).join(", ") || "none"}; missing: ${EXPECTED.filter(d => !registry.includes(d)).join(", ") || "none"}`);
check("B1", "29 weighted dimensions", Object.keys(weights).length === 29, `got ${Object.keys(weights).length}`);
check("C1", "pace_speed is the ONLY unweighted dimension",
  profile.dna_baseline.unweighted.length === 1 && profile.dna_baseline.unweighted[0] === "pace_speed",
  "speed is not itself desirable here - a slow film that keeps revealing is wanted");

const APPROVED = { mystery:20, investigation:18, progressive_revelation:18, revelation_frequency:17,
  suspense:17, clue_puzzling:16, cat_and_mouse:15, psychological_strategy:15, culprit_hunt:14,
  plot_twists:14, deception:14, conspiracy:14, evidence_manipulation:13, mole_inside:12,
  unreliable_perspective:12, hidden_identity:11, deadly_game:11, surveillance:10, visual_quality:10,
  weirdness:9, action_density:9, corruption:8, technology_threat:8, brutality:7, action_intensity:6,
  drama_focus:-8, retro_visual_style:-10, romance_focus:-10, military_focus:-14 };
const diffs = Object.entries(APPROVED).filter(([k,v]) => weights[k] !== v).map(([k,v]) => `${k}: want ${v}, got ${weights[k]}`);
check("D1", "every baseline weight matches the approved MG-6 value", diffs.length === 0, diffs.join("\n         "));
check("D2", "investigation does not outweigh mystery, and barely outweighs the payoff dimensions",
  weights.investigation < weights.mystery
  && weights.investigation <= weights.progressive_revelation
  && weights.investigation - weights.revelation_frequency <= 2,
  "the profile buys the payoff, not the procedure");

const required = profile.dna_baseline.completeness_defaults.required_known_dimensions;
check("E1", "exactly 11 required-known dimensions", required.length === 11, `got ${required.length}`);
check("E2", "revelation_frequency and progressive_revelation are BOTH required-known",
  required.includes("revelation_frequency") && required.includes("progressive_revelation"),
  "an unmeasured cadence is how a slow procedural would dodge the rule");
check("F1", "min_known_dimensions is 22 of 30",
  profile.dna_baseline.completeness_defaults.min_known_dimensions === 22);

const ROWS = ["full-watchlist","past-24h","best-matches","dna-match","investigation-puzzles",
  "cat-and-mouse","conspiracy-moles","reality-evidence-manipulation","high-suspense",
  "action-thrillers","deadly-systems"];
check("H1", "11 logical rows", config.catalogs.length === 11, `got ${config.catalogs.length}`);
check("H2", "row ids are exactly the approved set", config.catalogs.map(c => c.id).join(",") === ROWS.join(","));
const baseRows = config.catalogs.filter(c => c.dna && c.dna.mode === "baseline_profile");
check("G1", "exactly one baseline_profile row, and it is dna-match",
  baseRows.length === 1 && baseRows[0].id === "dna-match");
check("G2", "every themed DNA row is weighted, never baseline_profile",
  config.catalogs.filter(c => c.filter === "dna" && c.id !== "dna-match").every(c => c.dna.mode === "weighted"));
if (fs.existsSync(path.join(root, "site", "manifest.json"))) {
  const m = JSON.parse(fs.readFileSync(path.join(root, "site", "manifest.json"), "utf8"));
  check("H3", "22 emitted manifest catalogs", m.catalogs.length === 22, `got ${m.catalogs.length}`);
  check("H4", "manifest id is the approved Thriller id", m.id === "com.github.wtfthriller.discovery", m.id);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const NEUTRAL = Object.fromEntries(registry.map(id => [id, 5]));
const item = (over = {}, meta = {}) => ({
  imdb_id: meta.imdb_id || "tt9999999", type: "movie", title: meta.title || "Probe",
  year: meta.year || 2020, status: "watch", match_score: 70, tags: [], reason: "probe",
  added_at: "2026-08-27T00:00:00Z", added_by: "bootstrap",
  source: "https://example.org/identity ; https://example.org/structure ; https://example.org/review",
  dna: { ...NEUTRAL, ...over }, dna_confidence: 0.9, dna_tags: [], ...meta
});
const scoreOf = (over, def = row("dna-match")) => scoreItem(policy, def, item(over), new Map());

// An eventful thriller: the profile's centre of gravity.
const GOOD = { mystery: 9, investigation: 8, clue_puzzling: 8, culprit_hunt: 7,
  progressive_revelation: 8, revelation_frequency: 8, plot_twists: 7, psychological_strategy: 7,
  cat_and_mouse: 6, deception: 7, hidden_identity: 5, unreliable_perspective: 5, conspiracy: 6,
  mole_inside: 3, corruption: 4, surveillance: 4, evidence_manipulation: 5, technology_threat: 2,
  suspense: 9, action_density: 4, action_intensity: 5, brutality: 6, deadly_game: 0, weirdness: 5,
  military_focus: 0, romance_focus: 1, drama_focus: 4, visual_quality: 9, retro_visual_style: 2,
  pace_speed: 6 };

// THE failure case: enormous investigation, nothing landing, no motion.
const MINDHUNTER = { ...GOOD, investigation: 10, revelation_frequency: 3,
  progressive_revelation: 3, pace_speed: 2, clue_puzzling: 4, plot_twists: 2, suspense: 5 };

check("SANITY", "an eventful thriller scores strongly", scoreOf(GOOD).score >= 60, JSON.stringify(scoreOf(GOOD)));

// ---------------------------------------------------------------------------
// I-L  the six measurements are genuinely separate
// ---------------------------------------------------------------------------
check("I1", "investigation and revelation_frequency are separate dimensions",
  registry.includes("investigation") && registry.includes("revelation_frequency"));
check("I2", "they move the score independently", (() => {
  const invUp = scoreOf({ ...GOOD, investigation: 10 }).score - scoreOf({ ...GOOD, investigation: 2 }).score;
  const revUp = scoreOf({ ...GOOD, revelation_frequency: 10 }).score - scoreOf({ ...GOOD, revelation_frequency: 2 }).score;
  return invUp > 0 && revUp > 0;
})());
check("J1", "investigation and progressive_revelation are separate and both move the score",
  scoreOf({ ...GOOD, progressive_revelation: 10 }).score > scoreOf({ ...GOOD, progressive_revelation: 1 }).score);
check("K1", "plot_twists and progressive_revelation are separate dimensions",
  registry.includes("plot_twists") && registry.includes("progressive_revelation")
  && weights.plot_twists !== undefined && weights.progressive_revelation !== undefined);
check("L1", "a one-big-final-twist fixture is expressible: high twists, low progressive revelation",
  scoreOf({ ...GOOD, plot_twists: 10, progressive_revelation: 3 }).score !== null,
  "nothing was being rebuilt along the way, and the model must be able to say so");
check("L2", "...and it scores below the same fixture with sustained reframing",
  scoreOf({ ...GOOD, plot_twists: 10, progressive_revelation: 3 }).score <
  scoreOf({ ...GOOD, plot_twists: 10, progressive_revelation: 9 }).score);

// ---------------------------------------------------------------------------
// M-Q  THE Mindhunter rule
// ---------------------------------------------------------------------------
const fires = (over, id) => {
  const dna = { ...NEUTRAL, ...over };
  const r = profile.dna_guardrails.combination.find(x => x.id === id);
  if (!r) return false;
  const all = r.all_of.every(c => Object.prototype.hasOwnProperty.call(c, "at_or_above") ? dna[c.dimension] >= c.at_or_above : dna[c.dimension] <= c.at_or_below);
  const any = !r.any_of.length || r.any_of.some(c => Object.prototype.hasOwnProperty.call(c, "at_or_above") ? dna[c.dimension] >= c.at_or_above : dna[c.dimension] <= c.at_or_below);
  return all && any;
};

check("M1", "a Mindhunter-shaped fixture FIRES slow_investigation_without_payoff",
  fires(MINDHUNTER, "slow_investigation_without_payoff"),
  "investigation 10, revelation 3, progressive 3, pace 2");
check("N1", "an EVENTFUL investigation does NOT fire it",
  !fires(GOOD, "slow_investigation_without_payoff"),
  "investigation is exactly what the profile wants when it pays off");
check("N2", "a slow film that still reveals does not fire it",
  !fires({ ...MINDHUNTER, revelation_frequency: 8, progressive_revelation: 8 }, "slow_investigation_without_payoff"),
  "slow is not the problem; silent is");

check("O1", "raising investigation ALONE cannot rescue the Mindhunter-shaped fixture", (() => {
  const base = scoreOf(MINDHUNTER).score;
  const maxed = scoreOf({ ...MINDHUNTER, investigation: 10, clue_puzzling: 10, culprit_hunt: 10 }).score;
  return fires({ ...MINDHUNTER, investigation: 10, clue_puzzling: 10, culprit_hunt: 10 }, "slow_investigation_without_payoff")
    && (maxed === null || base === null || maxed < scoreOf(GOOD).score);
})(), "more procedure is not more payoff");
check("O2", "the Mindhunter-shaped fixture scores far below the eventful one", (() => {
  const m = scoreOf(MINDHUNTER).score, g = scoreOf(GOOD).score;
  return m === null || (g - m) >= 20;
})(), `${scoreOf(MINDHUNTER).score} vs ${scoreOf(GOOD).score}`);
check("P1", "raising revelation_frequency materially improves it", (() => {
  const a = scoreOf(MINDHUNTER).score ?? 0;
  const b = scoreOf({ ...MINDHUNTER, revelation_frequency: 9 }).score ?? 0;
  return b > a;
})());
check("Q1", "raising progressive_revelation materially improves it", (() => {
  const a = scoreOf(MINDHUNTER).score ?? 0;
  const b = scoreOf({ ...MINDHUNTER, progressive_revelation: 9 }).score ?? 0;
  return b > a;
})());

// ---------------------------------------------------------------------------
// R-U  remaining guardrails
// ---------------------------------------------------------------------------
check("R1", "no revelation and no suspense fires low_revelation_thriller",
  fires({ ...GOOD, revelation_frequency: 2, suspense: 3 }, "low_revelation_thriller"));
check("R2", "sustained suspense alone avoids it",
  !fires({ ...GOOD, revelation_frequency: 2, suspense: 9 }, "low_revelation_thriller"));
check("S1", "military-first with no mystery or investigation fires military_first_thriller",
  fires({ ...GOOD, military_focus: 8, mystery: 3, investigation: 3 }, "military_first_thriller"));
check("S2", "military WITH a real mystery does not",
  !fires({ ...GOOD, military_focus: 8, mystery: 8, investigation: 3 }, "military_first_thriller"),
  "a military thriller with a real mystery is wanted");
check("T1", "romance + drama + weak suspense fires romance_drama_dominant",
  fires({ ...GOOD, romance_focus: 7, drama_focus: 7, suspense: 4 }, "romance_drama_dominant"));
check("T2", "sustained suspense makes it moot",
  !fires({ ...GOOD, romance_focus: 7, drama_focus: 7, suspense: 9 }, "romance_drama_dominant"));
check("U1", "poor craft fires cheap_presentation", fires({ ...GOOD, visual_quality: 2 }, "cheap_presentation"));
check("U2", "the profile has NO hard exclusions", profile.dna_guardrails.hard_exclusion.length === 0);
check("U3", "nothing is hard-excluded even at extremes", !hardExcluded(policy, { ...GOOD, military_focus: 10, romance_focus: 10 }));

// ---------------------------------------------------------------------------
// V-Y  presentation, never age
// ---------------------------------------------------------------------------
const guardDims = [...profile.dna_guardrails.hard_exclusion.map(r => r.dimension),
  ...profile.dna_guardrails.combination.flatMap(r => [...r.all_of, ...r.any_of].map(c => c.dimension))];
check("V1", "NO guardrail references retro_visual_style", !guardDims.includes("retro_visual_style"));
check("W1", "retro_visual_style is linear-only: it lowers but never excludes",
  scoreOf({ ...GOOD, retro_visual_style: 9 }).score < scoreOf({ ...GOOD, retro_visual_style: 1 }).score
  && scoreOf({ ...GOOD, retro_visual_style: 10 }).score !== null);
check("X1", "no dimension is about release year", !registry.some(d => /year|age|old|date|decade/.test(d)));
check("X2", "release year changes NO score", (() => {
  const a = scoreItem(policy, row("dna-match"), item(GOOD, { year: 1991, title: "Old" }), new Map());
  const b = scoreItem(policy, row("dna-match"), item(GOOD, { year: 2024, title: "New" }), new Map());
  return a.score === b.score && a.score !== null;
})());
check("Y1", "a Silence-of-the-Lambs-shaped high-craft, high-retro fixture is valid and only softened linearly", (() => {
  const f = { ...GOOD, visual_quality: 10, retro_visual_style: 8 };
  return scoreOf(f).score !== null && !fires(f, "cheap_presentation");
})(), "high craft that simply looks of an earlier era is not cheap");

// ---------------------------------------------------------------------------
// Z-AA  archetypes cannot bypass the revelation requirement
// ---------------------------------------------------------------------------
check("Z1", "EVERY archetype emphasises revelation_frequency at 7 or more",
  profile.dna_baseline.archetypes.every(a => (a.emphasis.revelation_frequency || 0) >= 7),
  profile.dna_baseline.archetypes.filter(a => (a.emphasis.revelation_frequency || 0) < 7).map(a => a.id).join(", "));
check("Z2", "the six approved archetypes are present",
  profile.dna_baseline.archetypes.map(a => a.id).join(",") ===
  "psychological_cat_and_mouse,investigation_puzzle,conspiracy_thriller,information_reality_thriller,action_thriller,deadly_system_thriller");
check("AA1", "no archetype gives the Mindhunter-shaped fixture a large bonus", (() => {
  const pre = baselineContentPre(policy, item(MINDHUNTER), row("dna-match").dna.archetype_bonus_max);
  const good = baselineContentPre(policy, item(GOOD), row("dna-match").dna.archetype_bonus_max);
  return pre.archetypeBonus < good.archetypeBonus;
})(), "an investigation-flavoured archetype without a revelation requirement is exactly the bypass this forbids");
check("AA2", "the investigation_puzzle archetype itself emphasises both payoff dimensions", (() => {
  const a = profile.dna_baseline.archetypes.find(x => x.id === "investigation_puzzle");
  return a.emphasis.revelation_frequency >= 7 && a.emphasis.progressive_revelation >= 7;
})());

// ---------------------------------------------------------------------------
// AB-AD  rows cannot fill with slow procedurals
// ---------------------------------------------------------------------------
const gateHas = (id, dim, val) =>
  row(id).dna.gate.all_of.some(c => c.dimension === dim && c.at_or_above === val);
check("AB1", "investigation-puzzles requires revelation_frequency >= 5",
  gateHas("investigation-puzzles", "revelation_frequency", 5));
check("AC1", "high-suspense requires revelation_frequency >= 5",
  gateHas("high-suspense", "revelation_frequency", 5));
check("AD1", "the Mindhunter-shaped fixture CANNOT enter investigation-puzzles",
  scoreItem(policy, row("investigation-puzzles"), item(MINDHUNTER), new Map()).score === null,
  "the row gate rejects it even though its investigation is maximal");
check("AD2", "...nor high-suspense",
  scoreItem(policy, row("high-suspense"), item(MINDHUNTER), new Map()).score === null);
check("AD3", "the eventful fixture DOES enter investigation-puzzles",
  scoreItem(policy, row("investigation-puzzles"), item(GOOD), new Map()).score !== null);

// ---------------------------------------------------------------------------
// AE-AH  watched semantics
// ---------------------------------------------------------------------------
const watched = watchedEvidenceIdentities(profile);
const evidence = profile.baseline_evidence.items;
check("AE1", "every watched entry accounts for how watching was confirmed",
  evidence.filter(i => i.evidence_type === "watched").every(i => typeof i.watched_confirmation === "string" && i.watched_confirmation.trim()));
check("AF1", "a structural Thriller anchor is not automatically watched",
  evidence.some(i => i.notes.some(n => /structural taste anchor/i.test(n)) && i.evidence_type === "unwatched"));
check("AG1", "no watched identities exist, so no series is excluded by partial exposure",
  watched.length === 0, `watched identities: ${watched.length}`);
{
  const sg = evidence.find(i => i.title === "Squid Game");
  check("AH1", "Squid Game is present and remains recommendable",
    sg && sg.evidence_type === "unwatched" && sg.recommendable === true);
  check("AH2", "...and its notes record why: partial exposure under one series identity",
    sg && sg.notes.some(n => /final season/i.test(n)) && sg.notes.some(n => /ONE public identity|one public identity/i.test(n)),
    "excluding the series would hide the unseen final season");
}
check("AF2", "every baseline reference stays recommendable", evidence.every(i => i.recommendable === true));

// ---------------------------------------------------------------------------
// AI-AO  provenance, determinism, hygiene
// ---------------------------------------------------------------------------
function runValidateWith(items) {
  const file = path.join(root, "data", "library.json");
  const original = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, JSON.stringify({ schema_version: 2, updated_at: "2026-08-27T00:00:00Z", items }, null, 2) + "\n");
    try { return { code: 0, output: execFileSync(process.execPath, ["scripts/validate.mjs"], { cwd: root, encoding: "utf8", stdio: "pipe" }) }; }
    catch (e) { return { code: e.status, output: `${e.stdout || ""}${e.stderr || ""}` }; }
  } finally {
    fs.writeFileSync(file, original);
    if (!fs.readFileSync(file).equals(original)) throw new Error("library.json was not restored");
  }
}
const sourceItems = [...JSON.parse(fs.readFileSync(path.join(root, "data", "library.json"), "utf8")).items];
const discDir = path.join(root, "data", "discoveries");
if (fs.existsSync(discDir)) {
  for (const n of fs.readdirSync(discDir).filter(x => x.endsWith(".json"))) {
    const p = JSON.parse(fs.readFileSync(path.join(discDir, n), "utf8"));
    sourceItems.push(...(Array.isArray(p) ? p : p.items || []));
  }
}
const urlsIn = v => String(v).split(/[;,\s]+/).flatMap(t => {
  try { const u = new URL(t.trim()); return /^https?:$/.test(u.protocol) && u.hostname.includes(".") ? [u.href] : []; }
  catch { return []; }
});
const distinctIn = v => [...new Set(urlsIn(v).map(h => { const u = new URL(h); u.hash = ""; return u.href; }))];

check("AI1", "every item cites real URLs", sourceItems.every(i => urlsIn(i.source).length > 0));
check("AI2", "no item repeats a normalized source URL",
  sourceItems.every(i => urlsIn(i.source).length === distinctIn(i.source).length),
  sourceItems.filter(i => urlsIn(i.source).length !== distinctIn(i.source).length).map(i => i.title).join(", "));
check("AJ1", "every item cites THREE OR MORE DISTINCT sources",
  sourceItems.every(i => distinctIn(i.source).length >= 3),
  sourceItems.filter(i => distinctIn(i.source).length < 3).map(i => `${i.title} (${distinctIn(i.source).length})`).join(", "));
check("AJ2", "every item cites at least one source beyond bare identity metadata",
  sourceItems.every(i => distinctIn(i.source).some(u => !u.includes("cinemeta"))));
check("AK1", "every stored match_score re-derives exactly from DNA",
  sourceItems.every(i => scoreItem(policy, row("dna-match"), i, new Map()).score === i.match_score),
  sourceItems.filter(i => scoreItem(policy, row("dna-match"), i, new Map()).score !== i.match_score).map(i => i.title).join(", "));
check("AL1", "every item has a complete 30-value DNA vector",
  sourceItems.every(i => registry.every(d => Number.isInteger(i.dna[d]))));
check("AL2", "no accepted item is below the calibrated threshold",
  sourceItems.every(i => i.match_score >= profile.automation_rules.minimum_match_score));
if (fs.existsSync(path.join(root, "site", "catalog"))) {
  const p24 = ["movie","series"].map(t => path.join(root, "site", "catalog", t, `past-24h-${t}.json`))
    .filter(f => fs.existsSync(f)).flatMap(f => JSON.parse(fs.readFileSync(f, "utf8")).metas);
  // No BOOTSTRAP title may appear here. The row is NOT required to be empty:
  // once a real daily run lands, its discoveries belong in it, and asserting
  // emptiness would fail on exactly the behaviour the row exists to produce.
  const bootstrapIds = new Set(sourceItems.filter(i => i.added_by === "bootstrap").map(i => i.imdb_id));
  const leaked = p24.filter(m => bootstrapIds.has(String(m.id).split(":")[0]));
  check("AM1", "Past 24h contains no bootstrap item", leaked.length === 0,
    `${leaked.map(m => m.name).join(", ")} leaked`);
}
{
  const dup = runValidateWith([item(GOOD, { imdb_id: "tt5555555", title: "A" }), item(GOOD, { imdb_id: "tt5555555", title: "B" })]);
  check("AN1", "a duplicate public identity FAILS CLOSED", dup.code !== 0 && /duplicate public identity/.test(dup.output));
}
check("AO1", "no personalized-scores.json exists", !fs.existsSync(path.join(root, "data", "personalized-scores.json")));

// ---------------------------------------------------------------------------
// AP-AU  engine integrity, independence, pipeline
// ---------------------------------------------------------------------------
{
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "test", "engine-checksums.json"), "utf8")).files;
  const scripts = fs.readdirSync(path.join(root, "scripts")).filter(n => n.endsWith(".mjs"));
  check("AP1", "every engine file is covered by the drift manifest",
    scripts.filter(n => !["registry.mjs","known-ids.mjs"].includes(n)).every(n => manifest[`scripts/${n}`]));
  const measurable = new Set([...Object.keys(weights), ...required]);
  const bad = [];
  for (const a of profile.dna_baseline.archetypes)
    for (const m of [a.emphasis, a.penalise || {}]) for (const d of Object.keys(m)) if (!measurable.has(d)) bad.push(`${a.id}.${d}`);
  check("AQ1", "every archetype dimension is weighted or required-known", bad.length === 0, bad.join(", "));
  const offenders = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git","node_modules","site"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(mjs|json|yml)$/.test(e.name)) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (rel === "test/thriller-profile.test.mjs") continue;
      const text = fs.readFileSync(full, "utf8");
      for (const b of ["wtf-scifi","wtf-fantasy","wtf-action","wtf-anime"]) if (text.includes(b)) offenders.push(`${rel} -> ${b}`);
      if (text.includes("wtf-addon-template") && rel !== "test/engine-checksums.json") offenders.push(`${rel} -> template`);
    }
  };
  walk(root);
  check("AS1", "no cross-repo reference or runtime dependency", offenders.length === 0, offenders.join("\n         "));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  check("AS2", "zero dependencies", !pkg.dependencies && !pkg.devDependencies);
}
check("AR1", "the profile validates", validateProfile(profile).length === 0, validateProfile(profile).join("\n         "));
{
  let ok = true, out = "";
  try { out = execFileSync(process.execPath, ["scripts/validate.mjs"], { cwd: root, encoding: "utf8", stdio: "pipe" }); }
  catch (e) { ok = false; out = `${e.stdout || ""}${e.stderr || ""}`; }
  check("AT1", "validate.mjs succeeds on the real library", ok, out);
  let built = true;
  try { execFileSync(process.execPath, ["scripts/build-site.mjs"], { cwd: root, stdio: "pipe" }); } catch { built = false; }
  check("AU1", "build-site.mjs succeeds", built);
  check("AU2", "the build emits 22 manifest catalogs",
    JSON.parse(fs.readFileSync(path.join(root, "site", "manifest.json"), "utf8")).catalogs.length === 22);
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
