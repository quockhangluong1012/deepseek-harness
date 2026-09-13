import io, re

report = io.open("research/notes/final_report_evolutionary-harness-dsh-cf2785.md", encoding="utf-8").read()
spans = re.findall(r'"([^"\n]{20,})"', report)
notes = {}
import glob
for f in glob.glob("research/notes/*.md"):
    try:
        notes[f] = io.open(f, encoding="utf-8").read()
    except Exception:
        pass
out = []
for s in spans:
    hits = [f for f, b in notes.items() if s in b]
    tag = "OK" if hits else "MISS"
    disp = s[:90].replace("\n", " ")
    who = ",".join(h.split("/")[-1][:24] for h in hits[:3])
    out.append(tag + " | " + disp + " || " + who)
io.open("qres.txt", "w", encoding="utf-8").write("\n".join(out))
print(len(spans), "spans;", sum(1 for o in out if o.startswith("OK")), "ok")
