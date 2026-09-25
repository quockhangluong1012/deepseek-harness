import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { LspInstance, readHostSource } from '@deepseek-ai/dsh-lsp-stdio'
import { encodeMessage } from '@deepseek-ai/dsh-lsp-stdio'
import type { ConnectionSpawner, ConnectionWriter } from '@deepseek-ai/dsh-lsp-stdio/src/connection.ts'
import type { InstanceSpec } from '@deepseek-ai/dsh-lsp-stdio/src/instance.ts'
import type { LspProviderQuery, LspQueryResult } from '@deepseek-ai/dsh-lsp'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'

const fixtureServer = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))

let root: string
let ws: string
let ctx: Context
let fs: LocalFileSystem
const live: LspInstance[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-inst-')))
  ws = join(root, 'ws')
  await mkdir(ws)
  await writeFile(join(ws, 'a.ts'), 'const x = 1\n')
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  fs = ctx.fs as LocalFileSystem
})

afterEach(async () => {
  const instances = live.splice(0)
  const ownedContext = ctx
  const directory = root
  for (const instance of instances) await instance.dispose()
  await ownedContext.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
})

function makeInstance(
  env: Record<string, string> = {},
  overrides: Partial<InstanceSpec> = {},
  writer?: ConnectionWriter,
  spawner: ConnectionSpawner = spawnSubprocess,
): LspInstance {
  const instance = new LspInstance({
    command: process.execPath,
    args: [fixtureServer],
    cwd: ws,
    workspaceUri: pathToFileURL(ws).href,
    env: { ...scrubbedParentEnv(), ...env },
    configuration: { setting: 42 },
    initializationOptions: { init: true },
    maxMessageBytes: 16_000_000,
    maxStderrBytes: 100_000,
    shutdownTimeoutMs: 200,
    killGraceMs: 200,
    diagnosticsWaitMs: 500,
    ...overrides,
  }, spawner, writer)
  live.push(instance)
  return instance
}

function query(operation: LspProviderQuery['operation'] = 'goToDefinition'): LspProviderQuery {
  if (operation === 'diagnostics') {
    return { operation, filePath: 'a.ts', workspaceRoot: ws, languageId: 'typescript' }
  }
  return { operation, filePath: 'a.ts', position: { line: 0, character: 6 }, workspaceRoot: ws, languageId: 'typescript' }
}

/** Run a query against an instance, reading the source first the way the provider does. */
async function run(instance: LspInstance, operation: LspProviderQuery['operation'] = 'goToDefinition', signal?: AbortSignal): Promise<LspQueryResult> {
  const workspace = {
    target: await fs.resolve(ws),
    canonicalPath: ws,
    fileUrl: pathToFileURL(ws).href,
  }
  const source = await readHostSource(fs, 'a.ts', workspace, 4_000_000)
  return instance.query(query(operation), source, signal)
}

/** Build an instance whose "server" is an inline node script (for teardown-escalation control). */
function scriptInstance(script: string, overrides: Partial<InstanceSpec> = {}): LspInstance {
  const instance = new LspInstance({
    command: process.execPath,
    args: ['-e', script],
    cwd: ws,
    workspaceUri: pathToFileURL(ws).href,
    env: scrubbedParentEnv(),
    configuration: null,
    initializationOptions: null,
    maxMessageBytes: 16_000_000,
    maxStderrBytes: 100_000,
    shutdownTimeoutMs: 150,
    killGraceMs: 150,
    diagnosticsWaitMs: 500,
    ...overrides,
  }, spawnSubprocess)
  live.push(instance)
  return instance
}

/** An inline server that answers initialize + definition and echoes a location. */
const RESPONDING_SERVER =
  'let b=Buffer.alloc(0);'
  + 'const fr=(o)=>{const x=Buffer.from(JSON.stringify({jsonrpc:"2.0",...o}));return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
  + 'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);for(;;){const s=b.indexOf("\\r\\n\\r\\n");if(s<0)break;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);if(b.length<s+4+len)break;const m=JSON.parse(b.toString("utf8",s+4,s+4+len));b=b.subarray(s+4+len);'
  + 'if(m.method==="initialize")process.stdout.write(fr({id:m.id,result:{capabilities:{positionEncoding:"utf-16",textDocumentSync:1,definitionProvider:true}}}));'
  + 'else if(m.method==="textDocument/definition")process.stdout.write(fr({id:m.id,result:null}));'
  + '}});'

const locJson = () => JSON.stringify({ uri: pathToFileURL(join(ws, 'a.ts')).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } })

describe('LspInstance server-request handling', () => {
  it('answers workspace/configuration with the static config per item', async () => {
    const instance = makeInstance({ LSP_FAKE_ON_OPEN: 'configuration', LSP_FAKE_DEF: locJson() })
    // The query drives didOpen, which makes the fake emit workspace/configuration; a healthy answer
    // keeps the query working.
    await expect(run(instance, 'goToDefinition')).resolves.toMatchObject({ kind: 'locations' })
  })

  it('accepts a lifecycle client/registerCapability request', async () => {
    const instance = makeInstance({ LSP_FAKE_ON_OPEN: 'lifecycle', LSP_FAKE_DEF: 'null' })
    await expect(run(instance, 'goToDefinition')).resolves.toEqual({ kind: 'locations', locations: [], resolvedWorkspaceUri: pathToFileURL(ws).href })
  })

  it('rejects a workspace/applyEdit request but keeps serving', async () => {
    const instance = makeInstance({ LSP_FAKE_ON_OPEN: 'applyEdit', LSP_FAKE_DEF: 'null' })
    await expect(run(instance, 'goToDefinition')).resolves.toEqual({ kind: 'locations', locations: [], resolvedWorkspaceUri: pathToFileURL(ws).href })
  })

  it('rejects an unknown server request but keeps serving', async () => {
    const instance = makeInstance({ LSP_FAKE_ON_OPEN: 'unknown', LSP_FAKE_DEF: 'null' })
    await expect(run(instance, 'goToDefinition')).resolves.toEqual({ kind: 'locations', locations: [], resolvedWorkspaceUri: pathToFileURL(ws).href })
  })
})

describe('LspInstance query and abort', () => {
  it('sends includeDeclaration for references', async () => {
    const instance = makeInstance({ LSP_FAKE_REFS: JSON.stringify([JSON.parse(locJson())]) })
    await expect(run(instance, 'findReferences')).resolves.toMatchObject({ kind: 'locations' })
  })

  it('rejects a query aborted before it starts', async () => {
    const instance = makeInstance({ LSP_FAKE_DEF: 'null' })
    const controller = new AbortController()
    controller.abort(new Error('pre-abort'))
    await expect(run(instance, 'goToDefinition', controller.signal)).rejects.toThrow(/pre-abort/)
  })

  it('cancels an in-flight request on abort and rejects', async () => {
    const instance = makeInstance({ LSP_FAKE_HANG: '1' })
    const controller = new AbortController()
    // Warm the instance first so the abort lands during the hanging request, not during startup.
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 300))
    controller.abort(new Error('mid-flight'))
    await expect(pending).rejects.toThrow(/mid-flight/)
  })

  it('terminates the instance when the server ignores $/cancelRequest past the grace', async () => {
    // The hang server never honors cancellation, so after the bounded grace the instance must be torn
    // down (its process closed) rather than left with an active request.
    const instance = makeInstance({ LSP_FAKE_HANG: '1' }, { killGraceMs: 100 })
    const controller = new AbortController()
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 300))
    controller.abort(new Error('mid-flight'))
    await expect(pending).rejects.toThrow(/mid-flight/)
    expect(instance.dead).toBe(true)
  })

  it('resolves the cancel grace when the server honors $/cancelRequest', async () => {
    // A server that answers $/cancelRequest by settling the pending request lets the grace race
    // resolve via the request rather than the timeout, so the instance is NOT force-terminated.
    const script = 'let b=Buffer.alloc(0),reqId=null;'
      + 'const fr=(o)=>{const x=Buffer.from(JSON.stringify({jsonrpc:"2.0",...o}));return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
      + 'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);for(;;){const s=b.indexOf("\\r\\n\\r\\n");if(s<0)break;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);if(b.length<s+4+len)break;const m=JSON.parse(b.toString("utf8",s+4,s+4+len));b=b.subarray(s+4+len);'
      + 'if(m.method==="initialize")process.stdout.write(fr({id:m.id,result:{capabilities:{positionEncoding:"utf-16",textDocumentSync:1,definitionProvider:true}}}));'
      + 'else if(m.method==="textDocument/definition")reqId=m.id;'
      + 'else if(m.method==="$/cancelRequest"&&reqId!==null)process.stdout.write(fr({id:reqId,error:{code:-32800,message:"request cancelled"}}));'
      + 'else if(m.method==="shutdown")process.stdout.write(fr({id:m.id,result:null}));'
      + 'else if(m.method==="exit")process.exit(0);'
      + '}});'
    const instance = scriptInstance(script, { killGraceMs: 2_000 })
    const controller = new AbortController()
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 300))
    controller.abort(new Error('mid-flight'))
    await expect(pending).rejects.toThrow(/mid-flight/)
    // The server acknowledged cancellation within grace, so the instance was not force-killed.
    expect(instance.dead).toBe(false)
    await instance.dispose()
  })

  it('observes abort while awaiting a slow initialize handshake', async () => {
    // A server that answers nothing (not even initialize) leaves `ready` pending; an abort must be
    // observed during that wait instead of hanging the tool-timeout signal.
    const instance = scriptInstance('setInterval(()=>{},1000)', { killGraceMs: 100 })
    const controller = new AbortController()
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    controller.abort(new Error('handshake-abort'))
    await expect(pending).rejects.toThrow(/handshake-abort/)
    await instance.dispose()
  })

  it('terminates when abort interrupts a backpressured didOpen write', async ({ task, signal }) => {
    // The fixture consumes initialized, then stops reading. A document larger than the stdio pipe
    // keeps didOpen's write callback pending until cancellation forces bounded process teardown.
    await writeFile(join(ws, 'a.ts'), 'x'.repeat(2_000_000))
    const marker = join(root, 'initialized.log')
    const didOpenStarted = Promise.withResolvers<undefined>()
    let didOpenFinished = false
    let processClosed = false
    const instance = makeInstance({
      LSP_FAKE_INITIALIZED_MARKER: marker,
      LSP_FAKE_PAUSE_STDIN_AFTER_INITIALIZED: '1',
    }, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    }, (stdin, message, done) => {
      if ((message as { method?: unknown }).method !== 'textDocument/didOpen') {
        stdin.write(encodeMessage(message), done)
        return
      }
      stdin.write(encodeMessage(message), (error) => {
        didOpenFinished = true
        done(error)
      })
      didOpenStarted.resolve(undefined)
    }, (spec) => {
      const handle = spawnSubprocess(spec)
      void Promise.allSettled([handle.done]).then(([result]) => { processClosed = result.status === 'fulfilled' })
      return handle
    })
    const controller = new AbortController()
    const outcome = run(instance, 'goToDefinition', controller.signal)
      .then(() => undefined, (error: unknown) => error)
    await waitForFile(marker, task.timeout, signal)
    await didOpenStarted.promise
    signal.throwIfAborted()
    expect(didOpenFinished).toBe(false)
    expect(processClosed).toBe(false)
    controller.abort(new Error('didOpen-abort'))
    const failure = await outcome
    expect(() => { throw failure }).toThrow(/didOpen-abort/)
    expect(didOpenFinished).toBe(true)
    expect(processClosed).toBe(true)
    expect(instance.dead).toBe(true)
  })

  it('terminates when stdin fails during the didOpen write', async () => {
    const instance = makeInstance({}, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    }, failingWriter('textDocument/didOpen'))
    await expect(run(instance, 'goToDefinition')).rejects.toThrow()
    expect(instance.dead).toBe(true)
  })

  it('finishes teardown before rejecting a request write failure', async () => {
    const instance = makeInstance({}, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    }, failingWriter('textDocument/definition'))
    await expect(run(instance, 'goToDefinition')).rejects.toThrow(/fixture textDocument\/definition failure/)
    expect(instance.dead).toBe(true)
  })

  it('rejects when the server lacks the operation capability', async () => {
    const instance = makeInstance({ LSP_FAKE_CAPS: JSON.stringify({ definitionProvider: false }), LSP_FAKE_DEF: 'null' })
    await expect(run(instance, 'goToDefinition')).rejects.toThrow(/does not support goToDefinition/)
  })

  it('propagates a server error response even when a signal is supplied (not an abort)', async () => {
    // A live signal is passed, but the request fails for a server reason; the catch must rethrow
    // without treating it as an abort.
    const instance = makeInstance({ LSP_FAKE_ERROR: '1' })
    const controller = new AbortController()
    await expect(run(instance, 'goToDefinition', controller.signal)).rejects.toThrow(/server refused/)
  })

  it('keeps a settled result but awaits teardown when didClose cannot be written', async () => {
    const instance = makeInstance({
      LSP_FAKE_DEF: 'null',
    }, { shutdownTimeoutMs: 100, killGraceMs: 100 }, failingWriter('textDocument/didClose'))
    await expect(run(instance, 'goToDefinition')).resolves.toEqual({
      kind: 'locations',
      locations: [],
      resolvedWorkspaceUri: pathToFileURL(ws).href,
    })
    expect(instance.dead).toBe(true)
  })

})

describe('LspInstance diagnostics', () => {
  it('resolves normalized diagnostics from a matching publish', async () => {
    const uri = pathToFileURL(join(ws, 'a.ts')).href
    const instance = makeInstance({
      LSP_FAKE_ON_OPEN: 'diagnostics',
      LSP_FAKE_DIAGNOSTICS_URI: uri,
      LSP_FAKE_DIAGNOSTICS: JSON.stringify([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'boom', source: 'tsc', code: 2322 },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, message: 'no severity means error' },
      ]),
    })
    await expect(run(instance, 'diagnostics')).resolves.toEqual({
      kind: 'diagnostics',
      diagnostics: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 'error', message: 'boom', source: 'tsc', code: '2322' },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, severity: 'error', message: 'no severity means error' },
      ],
    })
  })

  it('matches TypeScript Windows URIs with an encoded lowercase drive', async () => {
    const instance = makeInstance({
      LSP_FAKE_ON_OPEN: 'diagnostics',
      LSP_FAKE_DIAGNOSTICS_URI: 'file:///c%3A/workspace/a.ts',
      LSP_FAKE_DIAGNOSTICS: JSON.stringify([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'drive URI' },
      ]),
    })
    await expect(instance.query(query('diagnostics'), {
      fileUrl: 'file:///C:/workspace/a.ts',
      text: 'const x = 1\n',
    })).resolves.toEqual({
      kind: 'diagnostics',
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'error', message: 'drive URI' }],
    })
  })

  it('preserves case-sensitive POSIX URI paths', async () => {
    const instance = makeInstance({
      LSP_FAKE_ON_OPEN: 'diagnostics',
      LSP_FAKE_DIAGNOSTICS_URI: 'file:///tmp/Workspace/a.ts',
      LSP_FAKE_DIAGNOSTICS: JSON.stringify([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'wrong path' },
      ]),
    }, { diagnosticsWaitMs: 100 })
    await expect(instance.query(query('diagnostics'), {
      fileUrl: 'file:///tmp/workspace/a.ts',
      text: 'const x = 1\n',
    })).resolves.toEqual({ kind: 'diagnostics', diagnostics: [] })
  })

  it('publishes against the opened URI when the fixture has no URI override', async () => {
    const instance = makeInstance({
      LSP_FAKE_ON_OPEN: 'diagnostics',
      LSP_FAKE_DIAGNOSTICS: JSON.stringify([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'opened URI' },
      ]),
    })
    await expect(run(instance, 'diagnostics')).resolves.toEqual({
      kind: 'diagnostics',
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'error', message: 'opened URI' }],
    })
  })

  it('resolves an empty result when nothing is published within the wait window', async () => {
    const instance = makeInstance({}, { diagnosticsWaitMs: 100 })
    const started = Date.now()
    await expect(run(instance, 'diagnostics')).resolves.toEqual({ kind: 'diagnostics', diagnostics: [] })
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })

  it('ignores a publish for a different uri and still resolves empty after the wait', async () => {
    const instance = makeInstance({
      LSP_FAKE_ON_OPEN: 'diagnostics',
      LSP_FAKE_DIAGNOSTICS_URI: 'file:///somewhere/else.ts',
      LSP_FAKE_DIAGNOSTICS: JSON.stringify([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'not ours' }]),
    }, { diagnosticsWaitMs: 150 })
    await expect(run(instance, 'diagnostics')).resolves.toEqual({ kind: 'diagnostics', diagnostics: [] })
  })

  it('resolves via a delayed publish that arrives before the wait elapses', async () => {
    const uri = pathToFileURL(join(ws, 'a.ts')).href
    const instance = makeInstance({
      LSP_FAKE_ON_OPEN: 'diagnostics',
      LSP_FAKE_DIAGNOSTICS_URI: uri,
      LSP_FAKE_DIAGNOSTICS: JSON.stringify([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: 'delayed warning' }]),
      LSP_FAKE_DIAGNOSTICS_DELAY_MS: '50',
    }, { diagnosticsWaitMs: 2_000 })
    await expect(run(instance, 'diagnostics')).resolves.toEqual({
      kind: 'diagnostics',
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'warning', message: 'delayed warning' }],
    })
  })

  it('captures publishDiagnostics sent before the didOpen write callback settles', async () => {
    const uri = pathToFileURL(join(ws, 'a.ts')).href
    const instance = makeInstance({
      LSP_FAKE_ON_OPEN: 'diagnostics',
      LSP_FAKE_DIAGNOSTICS_URI: uri,
      LSP_FAKE_DIAGNOSTICS: JSON.stringify([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'early error' },
      ]),
    }, { diagnosticsWaitMs: 1_000 }, (stdin, message, done) => {
      const finish = (): void => { setTimeout(() => { done() }, 100) }
      if ((message as { method?: unknown }).method === 'textDocument/didOpen') {
        stdin.write(encodeMessage(message), finish)
        return
      }
      stdin.write(encodeMessage(message), done)
    })
    await expect(run(instance, 'diagnostics')).resolves.toEqual({
      kind: 'diagnostics',
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'error', message: 'early error' }],
    })
  })

  it('rejects malformed push diagnostics without crashing notification dispatch', async () => {
    const uri = pathToFileURL(join(ws, 'a.ts')).href
    const instance = makeInstance({
      LSP_FAKE_ON_OPEN: 'diagnostics',
      LSP_FAKE_DIAGNOSTICS_URI: uri,
      LSP_FAKE_DIAGNOSTICS: JSON.stringify([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 5, message: 'bad severity' },
      ]),
      LSP_FAKE_DEF: 'null',
    })
    await expect(run(instance, 'diagnostics')).rejects.toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
    expect(instance.dead).toBe(false)
    await expect(run(instance, 'goToDefinition')).resolves.toMatchObject({ kind: 'locations', locations: [] })
  })

  it('rejects on caller abort during the wait rather than degrading to empty', async () => {
    const instance = makeInstance({}, { diagnosticsWaitMs: 5_000 })
    const controller = new AbortController()
    const pending = run(instance, 'diagnostics', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    controller.abort(new Error('diagnostics-abort'))
    await expect(pending).rejects.toThrow(/diagnostics-abort/)
  })

  it('never sends a request/response for diagnostics (push notification only)', async () => {
    // No LSP_FAKE_DIAGNOSTICS_URI/DIAGNOSTICS configured and no matching onOpen kind: the fixture
    // answers no textDocument/* request for diagnostics, proving the operation never round-trips one.
    const instance = makeInstance({}, { diagnosticsWaitMs: 100 })
    const result = await run(instance, 'diagnostics')
    expect(result).toEqual({ kind: 'diagnostics', diagnostics: [] })
  })
})

describe('LspInstance disposal', () => {
  it('lets a server finish protocol exit before signal escalation', async () => {
    const marker = join(root, 'graceful-exit.log')
    const instance = makeInstance({
      LSP_FAKE_DEF: 'null',
      LSP_FAKE_EXIT_DELAY_MS: '75',
      LSP_FAKE_EXIT_MARKER: marker,
    }, { shutdownTimeoutMs: 500 })
    await run(instance, 'goToDefinition')
    await instance.dispose()
    expect(await readFile(marker, 'utf8')).toBe('EXIT\nCLEAN\n')
  })

  it('is idempotent — a second dispose awaits close without error', async () => {
    const instance = makeInstance({ LSP_FAKE_DEF: 'null' })
    await run(instance, 'goToDefinition')
    await instance.dispose()
    await expect(instance.dispose()).resolves.toBeUndefined()
  })

  it('rejects a query after disposal', async () => {
    const instance = makeInstance({ LSP_FAKE_DEF: 'null' })
    await run(instance, 'goToDefinition')
    await instance.dispose()
    await expect(run(instance, 'goToDefinition')).rejects.toThrow(expect.objectContaining({ code: 'LSP_DISPOSED' }))
  })

  it('reports dead after the process closes', async () => {
    const instance = makeInstance({ LSP_FAKE_DEF: 'null' })
    await run(instance, 'goToDefinition')
    await instance.dispose()
    expect(instance.dead).toBe(true)
  })

  it('escalates to SIGKILL when the server ignores shutdown and SIGTERM', async () => {
    // Server answers initialize, ignores shutdown, and traps SIGTERM so only SIGKILL stops it.
    const script = RESPONDING_SERVER + 'process.on("SIGTERM",()=>{});'
    const instance = scriptInstance(script, { shutdownTimeoutMs: 100, killGraceMs: 100 })
    await run(instance, 'goToDefinition')
    await expect(instance.dispose()).resolves.toBeUndefined()
  })

  it('awaits a surviving managed-range helper on every concurrent dispose', async () => {
    const marker = join(root, 'helper.pid')
    const helper = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'
    const script = 'const{spawn}=require("node:child_process");const{writeFileSync}=require("node:fs");'
      + `const helper=spawn(process.execPath,["-e",${JSON.stringify(helper)}],{stdio:"ignore"});`
      + `writeFileSync(${JSON.stringify(marker)},String(helper.pid));`
      + RESPONDING_SERVER
    const instance = scriptInstance(script, { shutdownTimeoutMs: 100, killGraceMs: 100 })
    await run(instance, 'goToDefinition')
    const helperPid = Number(await readFile(marker, 'utf8'))
    try {
      const first = instance.dispose()
      await instance.dispose()
      expect(processAlive(helperPid)).toBe(false)
      await first
    } finally {
      if (processAlive(helperPid)) process.kill(helperPid, 'SIGKILL')
      await waitForProcessExit(helperPid)
    }
  })

  it('carries a non-Error abort reason as a generic aborted error', async () => {
    const instance = makeInstance({ LSP_FAKE_HANG: '1' })
    const controller = new AbortController()
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 200))
    controller.abort('a string reason, not an Error')
    await expect(pending).rejects.toThrow(/aborted/)
  })
})

/** Probe a pid without changing its state. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/, 1)[0]
    return !/^[ZXx]$/.test(state ?? '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Wait until a process can no longer execute so temporary-workspace cleanup cannot race handle release. */
async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (processAlive(pid)) {
    if (Date.now() - started > timeoutMs) throw new Error(`process ${pid} did not exit`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** Write normally except for one method whose callback receives a deterministic transport error. */
function failingWriter(method: string, failure = new Error(`fixture ${method} failure`)): ConnectionWriter {
  return (stdin, message, done) => {
    if ((message as { method?: unknown }).method === method) {
      queueMicrotask(() => { done(failure) })
      return
    }
    stdin.write(encodeMessage(message), done)
  }
}

/** Wait until a fixture marker exists, bounded so a broken handshake cannot hang the test. */
async function waitForFile(path: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const started = Date.now()
  for (;;) {
    signal.throwIfAborted()
    try {
      await readFile(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Date.now() - started > timeoutMs) throw new Error('waitForFile timed out')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}
