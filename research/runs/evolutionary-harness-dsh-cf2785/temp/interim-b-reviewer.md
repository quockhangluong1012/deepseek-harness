# Interim B — evolution-reviewer (loci L1, L3)

## Findings (from investigator B, verified by orchestrator spot-reads index.ts:1-120)

- Listener `session/event`: turn/start→beginTurn (reset buffer), turn/end→onTurnEnd→observeTurn (try/catch warn, never rejects), else bufferEvent (index.ts:392-394, 490-500, 596-628). No sync history scan; in-flight turns contribute observed suffix (index.ts:8-12).
- observeTurn order: resolve scope → indexOutputs (ALWAYS) → recallQueryOf → gate chain: !enabled return; admittedBytes < minTurnTextBytes (200) return; cooldown (60000) return; no route warn-skip; else defer auto/never (index.ts:630-656).
- producedEntry filter: in outputTools (write/edit/str_replace_editor) + non-error outcome + path=file_path||path + str_replace_editor skips view/undo_edit + resolve cwd + realpath fallback + isInside scope only (index.ts:275-293, 841-902; spec:199-202).
- Extraction call: temperature 0, purpose evolution-review (no reasoning), maxOutputTokens 1024, maxInputBytes 131072 drop-oldest, route configured-pair else session header; failures: error/aborted throw, max-tokens→truncated:true, tool-call blocks reject (index.ts:942-973, 329-340).
- Defer auto: one coalesced snapshot per session, first-snapshot deadline deferMaxAgeMs 1800000, unref timer; disposal/teardown drops (index.ts:718-772).
- Rebuild: drops archived, newest-first slice rebuildSessionLimit 20, rankedRows ?? exactRows through admittedRow (human-only), no-route→extraction-failed, currentLessons='', origin rebuild always-direct even under writeApproval (index.ts:427-513, 457-482).
- Squeeze: 4 headings Purpose/Preferences/Decisions/References, pressure order References→Purpose, UTF-8 clip, truncated flag; store maxAgentBytes authoritative with clip+retry (squeeze.ts, prompt.ts, index.ts:992-1024).

## Committed position

**Turn/end là điểm hẹn duy nhất của cả hai đường, nhưng gate tách chúng thành "luôn-index" và "hiếm-extract".** `enabled:false` không tắt reviewer — nó chỉ tắt extraction. Mọi luận về "tắt evolution" phải nói rõ indexing vẫn chạy. (Serves L1, L3.)
