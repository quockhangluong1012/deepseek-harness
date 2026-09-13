## Coverage Matrix — query phrase → atomic item mapping

| Query phrase (verbatim) | Mapped atomic item(s) | Scope check | Gap? |
|---|---|---|---|
| "cơ chế evolutionary harness" | Sub-Q1: harness là gì + cơ chế tổng thể; Entity: evolutionary harness | OK — full scope, không thu hẹp | No |
| "cơ chế hoạt động" | Sub-Q1 + Sub-Q2 (flows end-to-end) | OK | No |
| "các flow chạy thế nào" | Sub-Q2: flows end-to-end (ai gọi ai, input/output, thứ tự) | OK — bao cả runtime wiring chứ không chỉ từng package | No |
| "khi nào trigger memory" | Sub-Q3 + Entity: memory trigger + Entity: evolution-memory | OK — gồm điều kiện, call-site, dữ liệu ghi | No |
| "khi nào trigger lưu output vào evolution" | Sub-Q4 + Entity: evolution save trigger | OK — phân biệt với memory trigger, không gộp chung | No |
| "các evolution timeline hoạt động" | Sub-Q5 + Entity: evolution timeline + Entity: evolution-trajectory | OK — stage, thứ tự, artifact mỗi stage | No |
| "tất cả những thứ liên quan tới evolutionary harness" | Sub-Q6 + Entity: related surfaces (session log, spill, goal, skill-telemetry, Agent Notes, profiles) + 7 package entities | OK — liệt kê đủ 7 package, không bỏ sót | No |
| "repo deepseek harness này" | Scope: working tree tại thời điểm run | OK | No |
| "nghiên cứu chuyên sâu" / "--profile full" | Tier=full, format=structured, gear=full | OK — không hạ xuống light | No |
