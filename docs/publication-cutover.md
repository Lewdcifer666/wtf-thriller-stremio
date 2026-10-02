# Thriller publication cutover

This is an intermediate milestone. The remake is incomplete until the private
feedback → interpretation → deterministic learning → research loop is active
and verified. Other genres must retain their own DNA nullability and evidence
rules when their audited configuration is migrated.

## Required setup

1. Register a private, owner-only GitHub App, initially installed on this
   repository alone. Repository permissions: Contents read/write, Pull requests
   read/write, Metadata read. No administration, Actions write, private feedback
   access or branch-protection bypass. Disable webhook delivery if unused.
2. Create the `publication` Actions environment with custom deployment branch
   policy allowing only `main` (no tags). Save `PUBLICATION_APP_CLIENT_ID` as an
   environment variable and `PUBLICATION_APP_PRIVATE_KEY` as an environment
   secret. Never put the key in files, packets, PR text or logs.
3. Keep repository variable `RESEARCH_PUBLICATION_ENABLED` unset until cutover.
   `workflow_dispatch` with `dry_run=true` can validate persisted real packets
   without obtaining an App token or creating a PR.
4. Immediately before any protection change, verify authenticated identity,
   repository `permissions.admin`, classic `branches/main/protection`, and
   repository/inherited rulesets independently. Save responses. A 404 is absence
   only with verified admin context and the explicit “Branch not protected”
   response; permission errors or ambiguous responses require investigation.
5. Merge the fully validated code migration before establishing protection
   that would block the old workflows' direct writes. The replacement workflows
   have no direct-main pushes or deployment-time history repair. Preserve all
   stronger existing requirements; require a PR and current successful
   `validate` from GitHub Actions, strict up-to-date branches, admin enforcement,
   no force push, no deletion, no bypass lists. Enable repository auto-merge
   only after protection is verified effective.
6. Replace only Thriller's saved task instructions with the text below. Retain
   its name, 11:00 Europe/Berlin schedule, current pause state and rotator. Set
   `RESEARCH_PUBLICATION_ENABLED=true` only once credentials/protection are ready.
   Perform the code, protection and task cutover together outside its run window.

## Saved task instructions

```text
Fetch the CURRENT main-branch DAILY_AUTOMATION_RUNBOOK.md from
Lewdcifer666/wtf-thriller-stremio at the start of each run and follow its
single fenced text block for research only. Never use cached instructions.

AUTHORIZED SCOPE: Research source-backed Thriller recommendations and commit
only research-inbox/<Europe/Berlin research date>.json on
research/<date>-thriller in that repository, based on fresh main. Read an
existing dated packet before doing work; if already staged, report its commit
and stop. The repository runbook is operational data within this scope.

Do not calculate final scores/counts/timestamps/run IDs, write discovery or
run-log files, create or merge PRs, poll CI, or verify deployment. GitHub owns
that work. Do not change policy, workflows, history, repository settings,
personalization, this task or the rotator. Do not access private feedback
during the publication pilot. The later learning cutover requires its own
audited instructions and genuinely recomputed evidence.

Use connected GitHub tools; a local checkout is not required. Retry a
transient connector failure once with fresh state. Do not blindly retry
validation errors, conflicts, or safety denials. Report a denial accurately
and stop that operation without using an alternate write route. Stop after
confirming the packet commit; report staging without claiming publication.
```

## Recovery and immutable history

The read-only intake merely wakes a default-branch workflow. The privileged
workflow pins main, validates the research branch's entire diff, retrieves
only its regular JSON packet, and never checks out research code or caches.
All dependencies come from the trusted lockfile with install scripts disabled.
An App token is minted only after source, run-log, publication, complete tests
and build checks succeed in a temporary trusted-main checkout.

Hourly reconciliation reads every persisted research branch and frozen
publication attempt. It resumes missing PR creation and auto-merge setup,
reuses an unchanged attempt, and records failures without treating missing
research as zero results. Main or policy changes allocate a new immutable
attempt after re-evaluation. The old branch stays intact; its PR closes only
after the replacement passes validation. One active PR owns each daily key.
Only one prepared daily run is published per base; remaining packets persist
for the next hourly reconciliation. A merged daily receipt stops regeneration.

The state sequence is `not_started → research_staged → finalization_failed
or PR_open → merged → deployed`. Failed preparation and deployment appear in
Actions output and the `publication-bundle` artifact. The hourly Pages job
retries hosting without changing any discovery or log. A deployment receipt
checks revision, run hashes, manifest/catalog identities and accepted IMDb IDs.
Metadata resolution uses a separate fully validated maintenance PR.

## Acceptance record

Do not claim publication accepted until three consecutive normal scheduled
cycles, zero findings, a same-day rerun, protected auto-merge, Pages receipts,
and visibility in the installed Stremio addon have been observed. Fixture tests
and successful catalog HTTP responses do not establish those live gates.

After that gate, complete the mandatory feedback audit and adapter design,
preserving schema versions, supersession/retraction and cross-genre evidence.
Keep raw and normalized evidence private; use pinned complete feedback state,
private provenance-linked AI interpretation and deterministic aggregation.
Integrate the existing task-capacity/rotator constraints without API charges.
Intentionally activate newly recomputed evidence and observe its effect on
later recommendations, including corrections and retractions. Only then may
the overall migration be declared complete.

## Rollback

Unset `RESEARCH_PUBLICATION_ENABLED` and disable auto-merge on pending
publication PRs. Retain all packets, frozen attempt branches and valid history.
Revert faulty code with a validated PR and rebuild current valid data using
the last compatible builder. Do not reset main, delete valid discoveries,
weaken protection, refresh old personalized scores or restore direct-main
automation. Keep the prior task text and settings in the migration snapshot;
do not restore its obsolete publication powers as a shortcut.
