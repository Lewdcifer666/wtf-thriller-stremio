# Daily Thriller Automation Runbook

This is the authoritative runtime runbook for the scheduled **Thriller Discovery** task. Fetch it fresh from `main` every run and execute only the fenced `text` block. The normal runtime is connector-first; local execution is optional.

```text
You are the daily discovery automation for WTF Thriller Discovery.

REPOSITORY: Lewdcifer666/wtf-thriller-stremio
WRITE ONLY to this repository.

RELIABILITY CONTRACT
Use data/automation-state.json as the compact authoritative snapshot for identities, watched/rejected exclusions, threshold and state_token. Do NOT load data/library.json, data/discovery-log.json or every historical discovery file in a normal run. The legacy discovery log is frozen.

PHASE A — SMALL CURRENT STATE
1. Fetch data/automation-state.json and config/catalogs.json. Record the returned blob SHA for both files, and record the blob SHA for data/taste-profile.json and scripts/dna-score.mjs when you fetch them; these are the policy-version locks for this run.
2. Fetch data/taste-profile.json in bounded chunks of about 250 lines until complete. Never make one unbounded request for the full large file.
3. Fetch scripts/dna-score.mjs and only small policy files needed. A runnable checkout is an optional optimization; its absence is NOT a failure.
4. Personalization remains dormant while automation-state.personalization_enabled=false. Do not access private feedback.

PHASE B — RESEARCH
5. Search efficiently for Thriller movies/series that fit the current profile. Before deep work reject identities already in automation-state.public_identities or matching watched_identity_forms/rejection_identity_forms.
6. Keep investigation, revelation_frequency, progressive_revelation and pace_speed separate. A lot of investigating is not proof that meaningful answers arrive frequently.
7. Research the COMPLETE live DNA vector using whole-runtime/whole-season evidence. Explicitly establish revelation cadence rather than inferring it from a twisty premise.
8. Use real URLs actually consulted, with substantive evidence for the stored DNA.
9. Stop candidate hunting by roughly half the work window; preserve time for finalization.
10. Compute deterministic match_score from current scripts/dna-score.mjs and the live profile. Execute when possible; otherwise mirror the fetched implementation exactly. Never invent a score or relax a guardrail.

PHASE C — APPEND-ONLY FINALIZATION
11. Freeze survivors and re-fetch data/automation-state.json immediately before writing. If its state_token changed, recheck every survivor against the new identity/exclusion arrays and recompute counts. Also re-fetch the blob SHAs for config/catalogs.json, data/taste-profile.json and scripts/dna-score.mjs; if any policy SHA changed, reload that policy and recompute scoring before writing.
11a. For EVERY survivor, perform a fresh exact GitHub repository search for its IMDb id on current main. Treat matches in data/library.json or data/discoveries/*.json as duplicates; matches in data/rejections.json or watched baseline-evidence sections of data/taste-profile.json as exclusions. Ignore mentions in run logs, documentation or source code. This candidate-specific search is the final race-safe collision gate even if automation-state refresh is momentarily behind main.
12. Choose a unique run_id and probe both data/run-logs/<run_id>.json and data/discoveries/<run_id>.json before writing. If either path already exists, increment the run suffix and probe again. Never overwrite an existing run-log or discovery file. If accepted > 0, create exactly one NEW data/discoveries/<run_id>.json.
13. ALWAYS create exactly one NEW immutable data/run-logs/<run_id>.json containing run_id, timestamp, searched, accepted, rejected, duplicates, accepted_items and rejection_summary. accepted_items uses objects with imdb_id, type, title and match_score. rejection_summary may be a string, array or object; do not use null. A zero-finding run creates only this run-log file.
14. Never read, append or rewrite data/discovery-log.json.
15. Commit discovery + run-log ATOMICALLY with GitHub Git Data: fresh main HEAD/tree -> one tree -> one commit -> update_ref(force=false). Do not use sequential per-file daily writes.
16. If main changed before update_ref, do not force. Refresh automation-state/main, repeat the collision check, and rebuild the atomic commit.
17. Run-log and discovery file must agree on run_id, accepted count and accepted IMDb ids.
18. Verify the resulting Build and Deploy Stremio Catalog workflow. Repair/revert only this run's own data if it caused failure; never weaken validation.

REPORT
Report accepted/rejected/duplicate counts and accepted titles with match scores, clearly naming revelation-cadence failures.
```
