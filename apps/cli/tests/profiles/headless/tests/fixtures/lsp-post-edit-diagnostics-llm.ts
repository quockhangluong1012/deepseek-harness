import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')
const HIGH = ReasoningEffortId('high')
const WRITE_ID = ToolCallId('lsp-post-edit-write')
const WRITE_ARGS = JSON.stringify({ file_path: 'diagnostics.ts', content: "const invalid: number = 'bad'\n" })

function* textReply(text: string): Iterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class LspPostEditDiagnosticsAdapter extends LlmAdapter {
  private writeIssued = false

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: OFF, name: 'Off' }, { id: HIGH, name: 'High' }],
        defaultEffort: HIGH,
      },
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.writeIssued) {
      const appended = options.messages.some((message) => {
        if (message.role !== 'tool') return false
        const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        return text.includes('Created file')
          && text.includes('Diagnostics for diagnostics.ts:\n1:1 error: LSP_FIXTURE_DIAGNOSTIC')
      })
      yield* textReply(appended ? 'LSP_POST_EDIT_DIAGNOSTICS_OK' : 'LSP_POST_EDIT_DIAGNOSTICS_MISSING')
      return
    }
    this.writeIssued = true
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: WRITE_ID, name: 'write', argumentsDelta: WRITE_ARGS }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: WRITE_ID, name: 'write', arguments: WRITE_ARGS },
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'lsp-post-edit-diagnostics-test-llm'
export const inject = ['llm']

/** Register the scripted provider used by the real headless profile e2e. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['lsp-mock'], new LspPostEditDiagnosticsAdapter())
}
