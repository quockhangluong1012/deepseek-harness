import { readFileSync, writeFileSync } from 'node:fs'

const jobs = [
  ['docs/config-catalog.zh.md', [
    ['dsh-command-verifiers', 'dsh-compaction-basic'],
    ['dsh-mentor-loop', 'dsh-message-feedback'],
    ['dsh-misconception', 'dsh-office-to-pdf'],
    ['dsh-repo-index', 'dsh-sandbox-local'],
    ['dsh-repo-map', 'dsh-sandbox-local'],
    ['dsh-research-controller', 'dsh-sandbox-local'],
    ['dsh-tool-git', 'dsh-tool-goal'],
    ['dsh-working-set', 'dsh-workspace-changes'],
  ], ['dsh-tool-call-timeout-policy', 'dsh-workspace-memory-llm']],
  ['docs/tool-catalog.zh.md', [
    ['dsh-tool-changes', 'dsh-tool-present'],
    ['dsh-tool-git', 'dsh-tool-terminal'],
  ], []],
]

const heading = name => `## \`@deepseek-ai/${name}\``
const anchorId = name => name.replace(/^dsh-/, '')
const anchor = name => `<a id="deepseek-aidsh-${anchorId(name)}"></a>`

for (const [file, pairs, orphans] of jobs) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const indexOfHeading = name => {
    const at = lines.findIndex(l => l === heading(name))
    if (at < 0) throw new Error(`${file}: missing heading ${name}`)
    return at
  }
  const ensureAnchor = name => {
    const at = indexOfHeading(name)
    if (lines[at - 1] === '' && lines[at - 2] === anchor(name)) return false
    const insertAt = lines[at - 1] === '' ? at - 1 : at
    lines.splice(insertAt, 0, anchor(name), '')
    return true
  }
  for (const [n, x] of pairs) {
    const at = indexOfHeading(n)
    const displaced = lines[at - 1] === '' ? at - 2 : at - 1
    if (lines[displaced] === anchor(x)) {
      lines.splice(displaced, 1)
      if (lines[displaced - 1] === '' && lines[displaced] === '') lines.splice(displaced, 1)
    }
    ensureAnchor(n)
    ensureAnchor(x)
    console.log(`${file}: ${n} / ${x} repaired`)
  }
  for (const name of orphans) {
    const at = lines.findIndex(l => l === anchor(name))
    if (at < 0) { console.log(`${file}: orphan ${name} absent`); continue }
    lines.splice(at, 1)
    if (lines[at] === '' && lines[at - 1] === '') lines.splice(at, 1)
    console.log(`${file}: removed orphan anchor ${name}`)
  }
  writeFileSync(file, lines.join('\n'))

  // Verify every anchor sits directly above the heading it names.
  const text = readFileSync(file, 'utf8')
  const all = text.split('\n')
  const problems = []
  all.forEach((l, i) => {
    const m = l.match(/^<a id="deepseek-aidsh-([^"]+)"><\/a>$/)
    if (!m) return
    let j = i + 1
    while (all[j] === '') j++
    const hm = (all[j] ?? '').match(/^## `@deepseek-ai\/([^`]+)`$/)
    if (!hm || anchorId(hm[1]) !== m[1]) problems.push(`line ${i + 1}: ${m[1]} -> ${hm ? hm[1] : (all[j] ?? '').slice(0, 40)}`)
  })
  const ids = [...text.matchAll(/<a id="(deepseek-aidsh-[^"]+)"><\/a>/g)].map(m => m[1])
  const dupes = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))]
  console.log(`${file}: ${ids.length} anchors, duplicates: ${dupes.join(', ') || 'none'}`)
  console.log(`${file}: misplaced: ${problems.join(' | ') || 'none'}`)
}
