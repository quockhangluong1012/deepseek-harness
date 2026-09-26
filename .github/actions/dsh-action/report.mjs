/**
 * Report one dsh Action run from its stream-JSON file: write the run result to
 * the job summary, comment the failure result on the event's pull request or
 * issue, and exit non-zero so a failed run fails the job.
 *
 * The token is read from `GH_TOKEN` and is never written to any output.
 * @module dsh-action/report
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Ceiling for one published body, in characters. */
const MAX_BODY_CHARS = 8000
/** REST host used when the runner does not set `GITHUB_API_URL`. */
const DEFAULT_API_URL = 'https://api.github.com'

/**
 * Read the terminal facts of one newline-delimited run-event file. Malformed
 * lines and unknown event types are skipped: the projection is an append-only
 * stream that a killed process can truncate mid-line.
 * @param text - complete run-event file content, possibly empty.
 * @returns the `final` answer, the last `error` message, and the event count.
 */
export function summarizeStream(text) {
  let events = 0
  let answer
  let error
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // A truncated final line is not an event; the count already read stands.
      continue
    }
    events += 1
    if (event?.type === 'final' && typeof event.text === 'string') answer = event.text
    if (event?.type === 'error' && typeof event.message === 'string') error = event.message
  }
  return { events, answer, error }
}

/**
 * Resolve the pull request or issue a workflow event belongs to.
 * @param event - parsed `GITHUB_EVENT_PATH` document, or undefined.
 * @returns the comment target, or undefined when the event carries none.
 */
export function commentTarget(event) {
  const number = event?.pull_request?.number ?? event?.issue?.number
  return typeof number === 'number' ? number : undefined
}

/**
 * Bound one published body, keeping its head and naming the truncation.
 * @param text - body to bound.
 * @returns the body, truncated at {@link MAX_BODY_CHARS} characters.
 */
export function bound(text) {
  if (text.length <= MAX_BODY_CHARS) return text
  return `${text.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`
}

/**
 * Comment one failure result on the event's pull request or issue.
 * @param target - resolved repository, number, and REST host.
 * @param token - bearer token from the environment; never logged.
 * @param body - bounded Markdown comment body.
 * @param request - fetch-compatible request function.
 * @returns whether the comment was accepted.
 */
async function postComment(target, token, body, request) {
  const response = await request(`${target.apiUrl}/repos/${target.repository}/issues/${String(target.number)}/comments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ body }),
  })
  return response.ok
}

/** Read one optional environment document. */
function readEvent(path) {
  if (path === undefined || path === '') return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // The runner always writes this file; an unreadable one means no target.
    return undefined
  }
}

/**
 * Report one run and return the exit code the step must use.
 * @param options - injectable environment, HTTP request, and output append.
 * @returns 0 for a completed run, 1 for a failed one.
 */
export async function main(options = {}) {
  const env = options.env ?? process.env
  const request = options.request ?? fetch
  const append = options.append ?? appendFileSync
  // A missing or unparsable exit code means the run's outcome is unknown, so
  // the report treats it as a failure instead of inventing a completed run.
  const exitCode = env.DSH_EXIT_CODE === undefined ? 1 : Number.parseInt(env.DSH_EXIT_CODE, 10)
  const resultPath = env.DSH_RESULT_PATH ?? 'dsh-result.jsonl'
  let stream = ''
  try {
    stream = readFileSync(resultPath, 'utf8')
  } catch {
    // The run step writes this file; a missing one still owes the job a report.
  }
  const summary = summarizeStream(stream)
  const failed = exitCode !== 0
  const status = failed ? 'failed' : 'completed'
  const detail = summary.error ?? `dsh exited with code ${String(exitCode)} before reporting an error message`
  const result = failed ? detail : summary.answer ?? '(no answer text)'

  const summaryPath = env.GITHUB_STEP_SUMMARY
  if (summaryPath !== undefined && summaryPath !== '') {
    append(summaryPath, `## dsh run ${status}\n\nStream events: ${String(summary.events)} (exit code ${String(exitCode)})\n\n${bound(result)}\n`)
  }

  const outputPath = env.GITHUB_OUTPUT
  if (outputPath !== undefined && outputPath !== '') {
    append(outputPath, `answer<<DSH_EOF\n${summary.answer ?? ''}\nDSH_EOF\n`)
    append(outputPath, `status=${status}\n`)
    append(outputPath, `result-path=${resultPath}\n`)
  }

  const repository = env.GITHUB_REPOSITORY
  const number = commentTarget(readEvent(env.GITHUB_EVENT_PATH))
  if (failed && env.DSH_COMMENT_ON_FAILURE !== 'false' && repository !== undefined && number !== undefined) {
    const target = { repository, number, apiUrl: env.GITHUB_API_URL ?? DEFAULT_API_URL }
    let posted = false
    try {
      posted = await postComment(target, env.GH_TOKEN ?? '', `dsh run failed.\n\n\`\`\`\n${bound(detail)}\n\`\`\`\n`, request)
    } catch {
      // A transport failure is reported without the token or request details.
      posted = false
    }
    if (!posted) {
      console.warn(`dsh-action: could not comment the failure result on ${repository}#${String(number)}`)
    }
  }
  return failed ? 1 : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
