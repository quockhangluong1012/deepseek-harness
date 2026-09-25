let buffered = Buffer.alloc(0)

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      send({
        id: message.id,
        result: {
          capabilities: {
            positionEncoding: 'utf-16',
            textDocumentSync: 1,
            definitionProvider: true,
          },
        },
      })
      break
    case 'textDocument/didOpen':
      send({
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: message.params.textDocument.uri,
          diagnostics: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            message: 'LSP_FIXTURE_DIAGNOSTIC',
          }],
        },
      })
      break
    case 'shutdown':
      send({ id: message.id, result: null })
      break
    case 'exit':
      process.exit(0)
  }
}

process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk])
  for (;;) {
    const headerEnd = buffered.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const match = /Content-Length: (\d+)/iu.exec(buffered.toString('ascii', 0, headerEnd))
    if (match === null) throw new Error('missing Content-Length')
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buffered.length < bodyStart + length) return
    const message = JSON.parse(buffered.toString('utf8', bodyStart, bodyStart + length))
    buffered = buffered.subarray(bodyStart + length)
    handle(message)
  }
})
