# Synthesis conflicts (Step 11.2)

Read all 3 drafts in full (A 2035w, B 2166w, C 2027w). No substantive factual conflicts — all three share one evidence base (evidence-digest + 4 interim notes) and identical committed positions (dual-gate turn/end, pure read-model timeline, two queues + 30/90d lifecycle, web-app-only composition).

## Conflict 1 (cosmetic): heading language
- Draft A uses ASCII headings exactly as in `required_section_headings` ("Buc tranh tong the...").
- Drafts B/C use Vietnamese-diacritic equivalents ("Bức tranh tổng thể...").
- **Verdict:** Vietnamese headings win (report language is Vietnamese; decomposition slugs were ASCII-only for JSON safety). Synthesizer: use B/C heading text.

## Conflict 2 (emphasis, not fact): who owns the brief render
- Draft A table says controller is "lễ tân brief và recall" (imprecise shorthand).
- Drafts B/C + subsystem correctly place brief rendering in `dsh-evolution-memory-context` (context group), controller only edits the record.
- **Verdict:** B/C. Brief injector = evolution-memory-context; controller = record editor. One sentence in §2 must state this split explicitly (model-visible brief vs human/Web record editing).

## Conflict 3 (potentially confusing): "three nested loops" framing vs per-question structure
- All drafts use the 8 required H2s; the loops framing appears inside §1/§3 consistently.
- **Verdict:** keep loops framing in §1 + §3 only; §§4–6 stay trigger/timeline-first for lookup. No cut needed.

No vault note reads required (repo-internal corpus, no claim IDs). Proceed to synthesis.
