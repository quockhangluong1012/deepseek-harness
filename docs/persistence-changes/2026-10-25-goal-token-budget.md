---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-25-goal-token-budget

English | [中文](2026-10-25-goal-token-budget.zh.md)

## Summary

Adds an optional per-goal token budget (maxGoalTokens) and its folded running counter (tokensUsed) to the goal/change event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-goal-token-budget
baseline: false
changes:
  - root: "event:goal/change"
    previous: "2026-09-11-initial"
    after: "592ed1c602a431ef09b3da454efabb8b70db10e783013248dd37dc4baaa64fbd"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both fields are optional on read; an event committed before this change has neither field, and the goal domain's decoder defaults a missing tokensUsed to zero and leaves maxGoalTokens unset. Every new write populates tokensUsed; maxGoalTokens is populated only when a caller requests a budget. The goal projection's stateVersion was bumped from 6 to 7 so a projection cache persisted before this change recomputes from the session log instead of failing the now-required tokensUsed field on the live projection wire schema.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/goal/goal/tests packages/goal/goal-round-driver/tests packages/goal/tool-goal/tests packages/goal/command-goal/tests: 147 tests passed, including a dedicated regression test decoding a goal/change event with no tokensUsed field at all.

<a id="dev-note"></a>
## Dev Note

None.
