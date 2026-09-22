# Agent Note: Evolution journey page (dual-face client)

Status: implemented

English | [中文](2026-09-12-evolution-client-ui.zh.md)

## Problem

The Phase 6 slice — whose behaviour the [Evolutionary Harness subsystem](../../../../docs/subsystems/evolutionary-harness.md) describes — shipped the `evolutionController` Remote service, the `/journey` read model, and the governance commands, but the Web half was still planned: nothing in the browser could show a Scope's recorded evolution, decide a staged write, or read the curator's recorded passes. The browser also cannot reach a Host Cordis service, so a curator card built on `ctx.evolutionCurator` could not be honest — it would have had to claim a state it never read.

## Decision

**One package, two faces.** `@deepseek-ai/dsh-client-ui-evolution` carries the browser page and its own Host Remote namespace. Scope verbs stay on the landed `ctx.evolutionController` (`evolution` namespace: `read`, `setInstructions`, `setLessons`, `setProfile`, `addContextItem`, `removeContextItem`, `rebuildMemory`, `listStaged`, `approveStaged`, `rejectStaged`, `timeline({ scopeId, range })`, and the `follow` stream); nothing was renamed and no read model moved. The package's own host face adds exactly one namespace with one verb — `evolutionCurator/status` over `ctx.evolutionCurator.lastRunAt()` and `passes()` — because that is the only way a browser can read a recorded pass instead of guessing one. An unmounted curator is reported as unmounted, never as a pass that never ran.

**The page is an additive shell panel, not a second `shell.page`.** `shell.page` is declared `{ kind: 'single' }` and already owned by the Workspace page, which registers its occupant only while open. A second conditional occupant collides in both directions: whichever opens second registers into an occupied single seat, and the failure lands inside the sibling plugin's own registration path, which knows only about `ctx.get('workspacePage')`. The documented additive extension point is the `sidebar.panellist` list id plus the matching `main` keyed entry, so the journey page registers `evolution-journey` in both and is reached from the sidebar rail. The `journeyPage` opener service the wave plan named was dropped with the placement: the row itself is the opener, and nothing would have consumed a service.

**Pending rows read the record projection, not the timeline's copy.** The page's `read()` projection carries `staged`, which the follow stream keeps live, so an approval retires its row in the same step the controller answers. The timeline is refetched after a decision for the day counts (`stagedApproved` / `stagedRejected`) the record itself does not keep, and for nothing else.

**Capacity is the record's own accounting.** The used/capacity bar reads `read().usage`, and the two document bars read the timeline's `cumulative.lessonsBytes` / `profileBytes` — both server-side projections of the same store call, so no byte count is re-derived in the browser. A zero ceiling renders a zero-width bar rather than a division by zero.

**Empty states are honest by construction.** A zero-filled day bucket of a bounded range is a calendar fact, not an event, so it never becomes a row: the page lists only the days that carry a delta or a decision and states the range's day count beside them. No curator record, no timeline, and no pending write each render their own line, and a quiet Scope renders three of them rather than a fabricated row.

## Alternatives considered

**Registering the page on `shell.page` as the wave plan froze it.** Rejected: the seat is single-occupancy and the Workspace page holds it; the collision paths are described above, and the failure would surface as a broken sibling rather than a missing page.

**A `journeyPage` opener service consumed by `ui-workspace`.** Rejected: `ui-workspace` reads one hard-coded seam name (`workspacePage`), so a second opener would need edits in a package this slice does not own, and the sidebar-rail panel needs no cross-package agreement at all.

**Rendering pending rows from `timeline.pending`.** Rejected: the timeline is a snapshot taken at fetch time, so a background write staged a second later would not appear until the next range switch or refresh.

**Showing the journal's `memoryUpdatedAt` as the only lesson/profile fact.** Rejected: the store now stamps each family separately, and the read model emits distinct `instructions`, `lessons`, and `profile` deltas; the page renders those kinds rather than collapsing them again.

**Faking the curator card from the reviewer's `lastExtraction`.** Rejected: the reviewer and the curator are different actors — one extracts lessons, the other moves skill lifecycle — and conflating them would have shown a pass that never happened.

## Consequences

The Web composition now shows the journey, decides staged writes, reads a recorded curator pass, and reads the brief's capacity, over the same verbs the CLI uses. The page costs one `read`, one `timeline`, one curator status read, and one follow generation per open Scope; a decision costs one write plus one timeline refetch. The curator card is only as rich as the ledger summary (`passId`, `at`, `snapshot`, transition count), so transitions and rollbacks remain CLI surfaces. The ZIP journey export and the `snapshots/web/evolution-journey` scenario from the specification are deliberately not part of this change: the user waived snapshot work, and a scenario needs recorded expectations. The page is verified on the real surface instead.

## Testing

`packages/client/ui-evolution/tests/` covers the host face (mounted and unmounted curator), the Remote face (every bound verb's request shape, failure unwrapping, one baseline per generation, the double-baseline guard, stream failure, idle-until-abort), the page (buckets with every delta kind and both decision counts, decisions retiring their row, capacity bars, range switching, follow baseline/upsert/failure, no-Scope/loading/empty states), the seats, and the plugin registrations. `packages/client/connection/tests/evolution-fixture.client.spec.ts` covers the fixture transport: every controller verb, the curator status face, the four timeline windows, and the follow baseline with an idle abort. Per-file coverage on this package's `src` tree is 100%.
