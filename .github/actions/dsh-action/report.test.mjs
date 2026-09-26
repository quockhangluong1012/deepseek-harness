/** Focused, keyless suite for the dsh Action run reporter. */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { bound, commentTarget, main, summarizeStream } from './report.mjs'

/** One temporary directory removed when the process exits. */
function temporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-action-report-'))
  process.on('exit', () => { rmSync(root, { recursive: true, force: true }) })
  return root
}

/** Write one file and return its path. */
function file(root, name, content) {
  const path = join(root, name)
  writeFileSync(path, content)
  return path
}

/** Record one run's appends and HTTP requests. */
function harness(options) {
  const appends = []
  const requests = []
  return {
    appends,
    requests,
    run(overrides = {}) {
      return main({
        env: { ...options.env, ...overrides },
        append: (path, text) => { appends.push([path, text]) },
        request: async (url, init) => {
          requests.push([url, init])
          return options.response ?? { ok: true }
        },
      })
    },
  }
}

test('summarizeStream reads the final answer and the last error', () => {
  const text = [
    JSON.stringify({ type: 'session', sessionId: 'session-1' }),
    '',
    '{ truncated',
    JSON.stringify({ type: 'error', message: 'first failure' }),
    JSON.stringify({ type: 'error', message: 'second failure' }),
    JSON.stringify({ type: 'final', text: 'the answer' }),
  ].join('\n')
  assert.deepEqual(summarizeStream(text), { events: 4, answer: 'the answer', error: 'second failure' })
  assert.deepEqual(summarizeStream(''), { events: 0, answer: undefined, error: undefined })
})

test('commentTarget reads the pull request or issue a run belongs to', () => {
  assert.equal(commentTarget({ pull_request: { number: 314 } }), 314)
  assert.equal(commentTarget({ issue: { number: 77 } }), 77)
  assert.equal(commentTarget({ repository: { full_name: 'deepseek-ai/deepseek-harness' } }), undefined)
  assert.equal(commentTarget(undefined), undefined)
})

test('bound keeps short bodies and names a truncated one', () => {
  assert.equal(bound('short'), 'short')
  const truncated = bound('x'.repeat(9000))
  assert.equal(truncated.length, 8000 + '\n\n[truncated]'.length)
  assert.match(truncated, /\n\n\[truncated\]$/)
})

test('a completed run reports its answer without commenting', async () => {
  const root = temporaryDirectory()
  const resultPath = file(root, 'dsh-result.jsonl', `${JSON.stringify({ type: 'final', text: 'all checks passed' })}\n`)
  const run = harness({
    env: {
      DSH_EXIT_CODE: '0',
      DSH_RESULT_PATH: resultPath,
      GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
      GITHUB_OUTPUT: join(root, 'output.txt'),
      GITHUB_REPOSITORY: 'deepseek-ai/deepseek-harness',
      GITHUB_EVENT_PATH: file(root, 'event.json', JSON.stringify({ pull_request: { number: 314 } })),
      GH_TOKEN: 'token-never-printed',
    },
  })
  assert.equal(await run.run(), 0)
  assert.equal(run.requests.length, 0)
  assert.match(run.appends[0][1], /## dsh run completed/)
  assert.match(run.appends[0][1], /all checks passed/)
  assert.equal(run.appends[1][1], 'answer<<DSH_EOF\nall checks passed\nDSH_EOF\n')
  assert.deepEqual(run.appends.slice(2).map(([, text]) => text), ['status=completed\n', `result-path=${resultPath}\n`])
})

test('a failed run comments its failure result on the triggering pull request', async () => {
  const root = temporaryDirectory()
  const resultPath = file(root, 'dsh-result.jsonl', [
    JSON.stringify({ type: 'error', message: 'verification: test "app" failed' }),
    JSON.stringify({ type: 'final', text: 'the run gave up' }),
    '',
  ].join('\n'))
  const run = harness({
    env: {
      DSH_EXIT_CODE: '1',
      DSH_RESULT_PATH: resultPath,
      GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
      GITHUB_OUTPUT: join(root, 'output.txt'),
      GITHUB_REPOSITORY: 'deepseek-ai/deepseek-harness',
      GITHUB_EVENT_PATH: file(root, 'event.json', JSON.stringify({ issue: { number: 77 } })),
      GITHUB_API_URL: 'https://api.github.test',
      GH_TOKEN: 'token-never-printed',
    },
  })
  assert.equal(await run.run(), 1)
  assert.equal(run.requests.length, 1)
  const [url, init] = run.requests[0]
  assert.equal(url, 'https://api.github.test/repos/deepseek-ai/deepseek-harness/issues/77/comments')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer token-never-printed')
  assert.match(JSON.parse(init.body).body, /verification: test "app" failed/)
  assert.match(run.appends[0][1], /## dsh run failed/)
  assert.deepEqual(run.appends.slice(1).map(([, text]) => text)[0], 'answer<<DSH_EOF\nthe run gave up\nDSH_EOF\n')
})

test('a failed run without a comment target still reports and fails', async () => {
  const root = temporaryDirectory()
  const run = harness({
    env: { DSH_EXIT_CODE: '1', DSH_RESULT_PATH: join(root, 'absent.jsonl'), GITHUB_STEP_SUMMARY: join(root, 'summary.md') },
  })
  assert.equal(await run.run(), 1)
  assert.equal(run.requests.length, 0)
  assert.match(run.appends[0][1], /Stream events: 0 \(exit code 1\)/)
  assert.match(run.appends[0][1], /before reporting an error message/)
})

test('a disabled comment posts nothing', async () => {
  const root = temporaryDirectory()
  const run = harness({
    env: {
      DSH_EXIT_CODE: '1',
      DSH_RESULT_PATH: join(root, 'absent.jsonl'),
      GITHUB_REPOSITORY: 'deepseek-ai/deepseek-harness',
      GITHUB_EVENT_PATH: file(root, 'event.json', JSON.stringify({ pull_request: { number: 314 } })),
      DSH_COMMENT_ON_FAILURE: 'false',
    },
  })
  assert.equal(await run.run(), 1)
  assert.equal(run.requests.length, 0)
})

test('a refused or thrown comment never changes the failed run outcome', async () => {
  const root = temporaryDirectory()
  const env = {
    DSH_EXIT_CODE: '1',
    DSH_RESULT_PATH: join(root, 'absent.jsonl'),
    GITHUB_REPOSITORY: 'deepseek-ai/deepseek-harness',
    GITHUB_EVENT_PATH: file(root, 'event.json', JSON.stringify({ pull_request: { number: 314 } })),
  }
  const refused = harness({ env, response: { ok: false } })
  assert.equal(await refused.run(), 1)
  assert.equal(refused.requests.length, 1)
  assert.equal(await main({
    env,
    append: () => {},
    request: async () => { throw new Error('transport is down') },
  }), 1)
})

test('an unknown run outcome is reported as a failure', async () => {
  const root = temporaryDirectory()
  const run = harness({ env: { DSH_RESULT_PATH: join(root, 'absent.jsonl'), GITHUB_STEP_SUMMARY: join(root, 'summary.md') } })
  assert.equal(await run.run(), 1)
  assert.match(run.appends[0][1], /exit code 1/)
})
