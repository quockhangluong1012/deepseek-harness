# Orchestrator notes — evolutionary-harness-dsh-cf2785

## Step 2 (width sweep, running)

- Corpus is repo-internal: spec (325 lines, canonical contract) + subsystem reference + 7 evolution packages + memory-context injector + web-app composition rows. External web is secondary.
- Key early facts: record key `profile:workspaceId`/`profile:global`, storageKey `<profile>--<workspaceId>`, domain `evolution_memory`, one doc per scope under `$DSH_HOME/storages/evolution_memory/records/`. Parts table: Instructions/Lessons/Profile/Context reach model + count capacity; Outputs/Staged do NOT.
- Journey is a PURE read model (`journey.ts` header says so): caller supplies record, module touches neither storage nor session log; controller reuses it. Timeline buckets on UTC+7 calendar, deltas only for facts the record proves; resolutions counted from ledger on decision day.
- Injector (`evolution-memory-context/src/index.ts`): agent/pre-step, digest compare triple-gate (injectedDigests map, claimed batch, newestLoggedDigest), absent record → digest 'empty' → nothing, empty sections → nothing, outside workspace → nothing. Nudges: memory every 1 turn, skills every 10 turns.
- Composition: evolution rows ONLY in web-app bundle (profile default shared by reviewer/injector/commands/controller), base untouched → headless/sdk/acp byte-identical until adopted.
- 4 investigators fanned out (memory / reviewer / curator-controller-journey / trajectory-scorer-wiring). Awaiting returns; then coverage-gaps + redundancy-audit + ranking commands.
- Expected tensions: "memory trigger" vs "evolution save trigger" conflation; timeline as table vs read-model; brief vs recall vs compaction; foreground vs background_review creator.
- Verified via grep: only production caller of evolution `recordOutputs` is reviewer index.ts:849 (rest are workspace-memory mirror, tests, .d.ts). L1 position stands. Note: workspace-memory (+llm) is a parallel legacy mirror worth one line in report §7.
