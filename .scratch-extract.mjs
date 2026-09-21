import { readFileSync } from 'node:fs'
const text = readFileSync('docs/tool-catalog.md', 'utf8')
const heads = [...text.matchAll(/^### `([^`]+)`/gm)]
heads.forEach((m, i) => {
  const end = i + 1 < heads.length ? heads[i + 1].index : text.length
  const block = text.slice(m.index, end)
  const props = [...new Set([...block.matchAll(/^ {4,}"([A-Za-z_][A-Za-z0-9_]*)":/gm)].map(x => x[1]))]
  console.log(m[1] + ' :: ' + props.slice(0, 18).join(','))
})
