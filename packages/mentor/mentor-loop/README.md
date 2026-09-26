---
description: "The §20 mentor quality loop as a plugin over the agent loop, the kernel's claims and evidence, the misconception engine, and the learner record: derives the stage from those seams, takes at most one durable action per step, and injects each stage's directive into the mentor agent's next request (ctx.mentorLoop)."
kind: "package-reference"
---

# @deepseek-ai/dsh-mentor-loop

English | [中文](README.zh.md)

## Summary

`dsh-mentor-loop` runs a mentor session through §20's quality loop. On each admitted pre-step it derives where the learner stands from the session log, the kernel's claims and evidence, the misconception pipelines, and the learner record; takes at most one durable action — record a detection, complete a stage, or count a recurring mistake; then appends the current stage's instruction to the mentor agent's next request as one injected message. It runs no agent loop, calls no model, and keeps no state of its own, so a resumed session reaches the same position.

## Table of Contents

- [Use this package](#use-this-package)
- [Reading the position](#reading-the-position)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the loop with a learner record and the misconception engine, and name the learner every session on that context mentors.

```yaml
- name: '@deepseek-ai/dsh-mentor-loop'
  config:
    learnerId: user-1
    maxDirectiveChars: 2000
```

`ctx.mentorLoop.position(agent)` reads where a session stands without writing anything, `step(agent)` performs the one action that position calls for and returns the next position, and the registered `agent/pre-step` listener does the same on every admitted step, appending the owed directive to that step's messages. A caller that only wants the text calls `directiveMessage(agent)`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `learnerId` | required | The learner whose record every session on this context mentors; a blank id fails at load |
| `maxDirectiveChars` | `2000` | Cap in UTF-16 characters on one injected directive |

### Observable behavior and failures

The loop waits rather than guessing: every stage it cannot advance names what it waits for, and that name is the fact a caller or a listener can act on. `step` throws what the owners throw — a thesis no pattern matches, a fact the current stage does not accept — while the pre-step path contains such a failure, logs it as a warning, and leaves the turn's decision as the other listeners left it. With no `agentKernel` mounted the loop stops at devil-advocate, because the session holds no claim or observation to act on. Each distinct position is announced once through `mentor/loop-position`, and that per-session memory is dropped when the session is disposed.

-----

<a id="reading-the-position"></a>
## Reading the position

The position is derived on every read, never stored, so a resumed or replayed session reaches the same stage. The newest thesis the learner stated decides it, and an occurrence already in progress decides it even when the newest message is a reply rather than a restated thesis.

| §20 stage | Action | The position stands there when |
|---|---|---|
| `observe` | `none` | the session holds no learner message yet |
| `evaluate` | `none` | the newest thesis matches no catalogued pattern |
| `devil-advocate` | `none` | the session holds no claim about the thesis, or no recorded observation to contradict it |
| `misconception-detection` | `detect` | a catalogued thesis with the mentor's claim and recorded observations |
| `teach`, `exercise`, `reassess` | `deliver`, then `advance` | a pipeline stage owes its directive, or the learner has spoken after it |
| `learner-model-update` | `none` | a cycle this loop just closed, waiting while the record does not yet carry the resolution |

A stage advances only after the learner speaks again, so one turn cannot run the whole cycle: `deliver` puts the stage's instruction in the request, and the next learner message completes the stage. An `explain` or `counterexample` stage completes as `delivered`, an `exercise` stage as `attempted` with the learner's message as the attempt, a `new-case` stage takes the newest case in the learner's history that this cycle has not used, and a `reassess` stage reads the new thesis: a catalogued match means the misconception repeated, and no match means it is resolved. A repeated reassessment also counts a recurring mistake on the learner record.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One pure derivation drives everything.** The position is a function of what the session, the kernel view, the misconception pipelines, and the learner record already hold; nothing about the loop's progress is stored, so a resumed session resumes at the same stage.
- **The engine owns the teaching text.** This package adds the §20 stage's request line, the exercise pointer, and the cap to the directive the engine rendered, and it names the stage that produced each message in the message source, so the log proves what was delivered.
- **At most one durable action per step.** A step detects, advances, or delivers — and only advances the cycle past one stage, so a long conversation cannot skip a stage the learner never saw.
- **The learner's own case history supplies the new case.** The loop picks the newest case the cycle has not used and waits at the new-case stage when the learner has none, rather than inventing one.
- **A mentor-side fault never fails the learner's turn.** The pre-step listener contains the failure and logs it; the step still happens when the caller drives the loop itself.
- **Announcements are deduplicated per session.** The position is emitted only when its signature changes, and the memory is cleared on disposal, so a listener sees each stage and each named wait once.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `MentorLoop`, the pre-step listener, `position`, `step`, and the seam reads |
| [`src/position.ts`](src/position.ts) | The §20 stage list, the counter-evidence rule, and the pure position derivation |
| [`src/observe.ts`](src/observe.ts) | What one session's derived messages show: the newest thesis and the newest delivered directive |
| [`src/render.ts`](src/render.ts) | The text of one injected message |
| [`src/types.ts`](src/types.ts) | The stages, the actions, the position, and the injected message source |
| [`src/events.ts`](src/events.ts) | The position notification |

### No invariant companion

No runtime invariant companion is published because the loop owns no state to check: every value it reports is recomputed from the session log, the kernel view, the engine, and the learner record on the next read, and the engine and the record are the owners of what a step writes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-misconception`](../misconception/README.md) — the catalogue, the pipeline stages, and the directives this loop injects.
- [`dsh-learner-model`](../learner-model/README.md) — the record whose case history picks the next case, and which takes the resolution, the recurrence, and the recurring mistake.
- [DeepSeek Harness 2.0 evolution spec](../../../specs/deepseek-harness-2.0-evolution-spec.md) §20 — the observe, evaluate, devil advocate, detection, teach, exercise, reassess, learner-model update order this loop implements.
- [Agent kernel subsystem](../../../docs/subsystems/agent-kernel.md) — the claims and evidence the devil-advocate stage waits for.
- [Session subsystem](../../../docs/subsystems/session.md) — the derived messages a position is read from, and the log an injected directive is committed to.

-----

<a id="model-experience"></a>
## Model Experience

### Injected stage directive

#### What the model sees

On every admitted `agent/pre-step` the loop appends one synthetic user message to that step's messages when the position calls for delivery, so the mentor agent reads it beside the learner's own message. The text starts with `Mentor loop — ` followed by the stage's request, one of five sentences this package owns: `correct this misconception in your next reply, in the learner's own terms` at explain, `show the counterexample below and ask what it does to the learner's thesis` at counterexample, `assign the exercise below, then wait for the learner` at exercise, `set the case below as the learner's next reading` at new-case, and `read the learner's new work and reassess it against the objective below` at reassess. An exercise line `Exercise <exerciseId> targets: <objective>.` follows when the stage assigned one, then the engine's own directive for that stage. The message source carries `kind: 'mentor-loop'` plus the stage's digest, so the log identifies the stage the text came from.

#### Token effect

Conditional and retained. One message is appended only while the position's action is `deliver`, and at most one per stage, because a stage whose digest is already in the log stops calling for delivery. The whole text is capped at `maxDirectiveChars` UTF-16 characters, and the appended message stays in the session log, so it enters every later request of that session.

#### KV Cache effect

Append-only. A delivery appends one message and rewrites no earlier one, so a provider's cached prefix stays reusable up to the append point. Replay and resume inject nothing that is already logged: the loop reads the delivered digest back from the session's derived messages, so a session that already carries a stage's directive never delivers it a second time.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the loop cannot observe or decide for a deployment. They are current package constraints.

- **The position never carries the occurrence** — `MentorLoopPosition` declares `misconceptionId` and `mentor/loop-position` reports it, but no derivation path sets it, so a listener learns which occurrence is in progress only from the injected message's source or from the engine.
- **The completing fact follows the stage, not the message** — an `explain` or `counterexample` stage completes as `delivered` and an `exercise` stage records whatever text the learner sent as the attempt, so any learner message after the directive advances the cycle.
- **One learner per context** — `Config.learnerId` is the learner for every session on that context, so a context mentoring several learners needs one mounted instance per learner.
- **One occurrence at a time per session** — the loop works the occurrence the newest delivered directive names, else the one whose pattern matches the newest thesis, so another pipeline the learner holds waits its turn.
- **The derivation reads the learner record only for case history** — it never reads a misconception's status, so a resolution or status change written by anything else does not move the position.
- **No kernel means no detection** — with no `agentKernel` mounted, the session holds no claim and no observation, so the loop stands at devil-advocate.
- **A failing step is logged, not surfaced** — through the pre-step path the failure reaches `ctx.logger` as a warning, and the turn proceeds without the directive.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The pre-step listener runs `next()` first and returns the untouched decision when the step rejects or the signal aborts, so the loop never short-circuits another listener's direct reply. A step that closes a cycle reports the learner-model update it just caused instead of re-deriving, because the closed pipeline derives back to a fresh detection or to an evaluate wait rather than to the update this step performed. Announcement memory is keyed by session id and cleared both on disposal and through the plugin's own effect, so a context that drops a session does not keep its signature.

</details>
