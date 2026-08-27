// GENERATED ONCE AT SCAFFOLD TIME - this repo's frozen DNA vocabulary.
//
// This is the one file the generator writes from the profile rather than
// copying verbatim, and it is what lets validate-profile.mjs stay genre-neutral
// and vendored. The guard it feeds is deliberately strict: data/taste-profile.json
// must declare EXACTLY these dimensions and EXACTLY these tags, no more and no
// fewer, so a typo becomes a loud failure instead of quiet new metadata.
//
// Changing this list is a schema decision. It means a registry version bump, a
// migration for every already-enriched record, and a review of every consumer -
// never a casual edit.

export const CANONICAL_DIMENSIONS = [
  "mystery",
  "investigation",
  "clue_puzzling",
  "culprit_hunt",
  "progressive_revelation",
  "revelation_frequency",
  "plot_twists",
  "psychological_strategy",
  "cat_and_mouse",
  "deception",
  "hidden_identity",
  "unreliable_perspective",
  "conspiracy",
  "mole_inside",
  "corruption",
  "surveillance",
  "evidence_manipulation",
  "technology_threat",
  "suspense",
  "action_density",
  "action_intensity",
  "brutality",
  "deadly_game",
  "weirdness",
  "military_focus",
  "romance_focus",
  "drama_focus",
  "visual_quality",
  "retro_visual_style",
  "pace_speed"
];

export const CANONICAL_DNA_TAGS = [
  "serial_killer",
  "police_procedural",
  "espionage",
  "heist",
  "kidnapping",
  "courtroom",
  "hacker",
  "deepfake",
  "witness",
  "prison",
  "small_town",
  "urban_night",
  "cold_case",
  "undercover",
  "stalker",
  "home_invasion",
  "survival_game",
  "journalism",
  "cult",
  "amnesia"
];

// The single deliberate exception to the shared absent..dominant scale:
// pace_speed measures slow..fast. Exactly one dimension may be slow_to_fast.
export const SLOW_TO_FAST_DIMENSION = "pace_speed";
