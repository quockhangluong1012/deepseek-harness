# Search plan — evolutionary-harness-dsh-cf2785 (repo-internal adaptation)

Step 2 template assumes web/academic corpus. For this repo-internal mechanism query, "sources" = primary repo files (READ) + vault notes for external background. Lens mapping preserved: breadth = systematic per-package coverage; depth = spec/subsystem/canonical contracts + tests as load-bearing evidence; adversarial = limits/non-goals/never-claims + byte-identical-disable proof.

| Atomic item | Search/read query | Type | Lens | Target |
|---|---|---|---|---|
| Sub-Q1 overall mechanism | specs/evolutionary-harness.spec.md full read | repo | depth/canonical | factual |
| Sub-Q1 overall mechanism | docs/subsystems/evolutionary-harness.md + Cordis API surface | repo | depth/canonical | factual |
| Sub-Q1 overall mechanism | packages/evolution/README.md group map | repo | breadth | factual |
| Entity command-evolution | packages/evolution/command-evolution/src/index.ts + journey.ts + types.ts | repo | breadth | factual |
| Entity command-evolution | packages/evolution/command-evolution/README.md + tests | repo | depth | canonical |
| Entity evolution-controller | packages/evolution/evolution-controller/src/index.ts + types.ts | repo | breadth | factual |
| Entity evolution-controller | packages/evolution/evolution-controller/README.md + tests/controller.host.spec.ts | repo | depth | canonical |
| Entity evolution-curator | packages/evolution/evolution-curator/src/index.ts + consolidate.ts + safety.ts | repo | breadth | factual |
| Entity evolution-curator | packages/evolution/evolution-curator/README.md + tests | repo | depth | canonical |
| Entity evolution-memory | packages/evolution/evolution-memory/src/index.ts + types.ts + digest.ts + spec.ts | repo | breadth | factual |
| Entity evolution-memory | packages/evolution/evolution-memory/README.md + tests/store.spec.ts | repo | depth | canonical |
| Entity evolution-reviewer | packages/evolution/evolution-reviewer/src/index.ts + prompt.ts + squeeze.ts | repo | breadth | factual |
| Entity evolution-reviewer | packages/evolution/evolution-reviewer/README.md + tests | repo | depth | canonical |
| Entity evolution-scorer | packages/evolution/evolution-scorer/src/*.ts + README | repo | breadth | factual |
| Entity evolution-trajectory | packages/evolution/evolution-trajectory/src/index.ts + sharegpt.ts + README | repo | breadth | factual |
| Sub-Q2 flows | packages/context/evolution-memory-context/src/index.ts + render.ts + sections.ts | repo | breadth | factual |
| Sub-Q2 flows | packages/bundle/web-app/cordis.patch.yml evolution rows | repo | depth | canonical |
| Sub-Q2 flows | grep evolution across packages (wiring: remotes, client-ui-evolution, skill-manage/telemetry) | repo | breadth | factual |
| Sub-Q3 memory trigger | reviewer turn/end listener + gating + setLessons/setUserProfile call-sites | repo | breadth | factual |
| Sub-Q3 memory trigger | memory-context agent/pre-step injector + digest compare | repo | breadth | factual |
| Sub-Q4 evolution save trigger | reviewer output indexing → recordOutputs call-site + filter predicate | repo | breadth | factual |
| Sub-Q4 evolution save trigger | stageWrite/approveStaged/rejectStaged paths (reviewer fork, /memory pending/approve) | repo | breadth | factual |
| Sub-Q5 timeline | command-evolution journey.ts scopeTimeline + renderTimeline + types | repo | depth | canonical |
| Sub-Q5 timeline | controller follow feed + timeline verbs | repo | breadth | factual |
| Sub-Q6 related | skill telemetry/manage READMEs + curator adopt/pin/ledger | repo | breadth | factual |
| Sub-Q6 related | session log/turn events, spill, goal, compaction recall vs brief | repo | breadth | factual |
| Adversarial | spec Limits + Product-choices-open-to-override + README Known Limitations | repo | adversarial | contrarian |
| Adversarial | "evolution never writes inside project / disabling restores byte-identical" proof (bundle base vs web-app, headless snapshots) | repo | adversarial | contrarian |
| Adversarial | "outputs never reach model / staged pending until approved / extraction needs route" negative claims | repo | adversarial | contrarian |
| External | Hermes Agent Nous Research memory/curator prior art (spec cites hermes-agent.nousresearch.com) | web | depth | canonical |
| External | Cordis plugin ctx.effect/ctx.on composition background (only if gaps) | web | breadth | factual |

Coverage: every atomic item ≥3 repo sources. time_periods empty → Lens D N/A. Minimum adversarial: spec Limits + byte-identical + never-claims (≥3).
