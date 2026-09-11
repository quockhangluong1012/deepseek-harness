// @vitest-environment jsdom
/**
 * The panel's presentation: the empty line with nothing to report, the
 * checklist with its status marks and running count, and the produced-file
 * rows that open their file in the Sidebar.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { ProgressBody, type ProgressBodyProps } from '../src/client/ProgressBody.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'session-1' as SessionId

const LIST: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

function timelineOf(...paths: readonly string[]): ConversationTimelineSnapshot {
  return {
    turnOrder: [1],
    turns: new Map([[1, {
      data: {
        get: (key: string) => key === 'deliverables'
          ? { produced: paths.map((path, seq) => ({ seq, path })) }
          : undefined,
      },
    }]]),
  } as unknown as ConversationTimelineSnapshot
}

/** Props stub: the framework hooks stand in with plain reads; the tab's own action is the recorder. */
function stub(options: {
  todos?: readonly TodoItem[] | null
  files?: readonly string[]
  cwd?: string
  translate?: ProgressBodyProps['t']
} = {}): { props: ProgressBodyProps; openResource: Mock } {
  const { todos = null, files = [], cwd = '/work', translate = makeTranslate(zh) } = options
  const openResource = vi.fn()
  const props = {
    sessionId: SESSION,
    t: translate,
    useChat: (selector: (snapshot: unknown) => unknown) => selector({ timeline: timelineOf(...files) }),
    useProjection: () => todos,
    useSessions: (selector: (state: unknown) => unknown) =>
      selector({ byId: { [SESSION]: { cwd } } }),
    useTabInfo: () => ({ tab: { actions: { openResource } } }),
  } as unknown as ProgressBodyProps
  return { props, openResource }
}

describe('ProgressBody', () => {
  it('says so while the Session has neither a checklist nor a produced file', () => {
    const { props } = stub()
    const view = render(<ProgressBody {...props} />)
    expect(screen.getByText('还没有任务或文件。助手开始工作后会显示在这里。')).toBeTruthy()
    expect(view.container.querySelector('[data-progress-section]')).toBeNull()
  })

  it('lists the checklist with a mark per status and the running count', () => {
    const { props } = stub({ todos: LIST })
    const view = render(<ProgressBody {...props} />)
    expect(screen.getByText('任务')).toBeTruthy()
    expect(screen.getByText('1/3')).toBeTruthy()
    const rows = [...view.container.querySelectorAll('[data-status]')]
    expect(rows.map(row => [row.getAttribute('data-status'), row.textContent]))
      .toEqual([
        ['completed', '搭骨架'],
        ['in_progress', '写组件'],
        ['pending', '补测试'],
      ])
    // The done item carries the check; the two unfinished ones carry the ring.
    expect(screen.getByRole('img', { name: '已完成' }).querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('img', { name: '进行中' }).querySelector('svg')).toBeNull()
    expect(screen.getByRole('img', { name: '待处理' }).querySelector('svg')).toBeNull()
  })

  it('lists produced files by their last segment and opens the whole path', () => {
    const { props, openResource } = stub({ files: ['out/report.html'] })
    const view = render(<ProgressBody {...props} />)
    expect(screen.getByText('产出文件')).toBeTruthy()
    const row = screen.getByRole('button', { name: '打开 out/report.html' })
    expect(row.getAttribute('title')).toBe('out/report.html')
    expect(row.textContent).toBe('report.html')
    fireEvent.click(row)
    expect(openResource).toHaveBeenCalledExactlyOnceWith(
      'dsh-resource://file/session/session-1/out/report.html',
    )
    expect(view.container.querySelector('[data-progress-section="tasks"]')).toBeNull()
  })

  it('counts files with the singular label for exactly one', () => {
    const t = makeTranslate(en)
    render(<ProgressBody {...stub({ files: ['a.ts'], translate: t }).props} />)
    expect(screen.getByText('1 file')).toBeTruthy()
    cleanup()
    render(<ProgressBody {...stub({ files: ['a.ts', 'b.ts'], translate: t }).props} />)
    expect(screen.getByText('2 files')).toBeTruthy()
  })

  it('shows the checklist above the produced files, one row each', () => {
    const { props } = stub({ todos: LIST, files: ['src/a.ts', 'src/a.ts'] })
    const view = render(<ProgressBody {...props} />)
    expect([...view.container.querySelectorAll('[data-progress-section]')]
      .map(section => section.getAttribute('data-progress-section')))
      .toEqual(['tasks', 'output'])
    // A path produced twice is one row.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('addresses a file outside the workspace by its absolute path', () => {
    const { props, openResource } = stub({ files: ['/elsewhere/notes.txt'] })
    render(<ProgressBody {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 /elsewhere/notes.txt' }))
    expect(openResource).toHaveBeenCalledExactlyOnceWith(
      'dsh-resource://file/absolute/elsewhere/notes.txt',
    )
  })

  it('falls back to the whole path when it has no last segment', () => {
    render(<ProgressBody {...stub({ files: ['/'] }).props} />)
    expect(screen.getByRole('button', { name: '打开 /' }).textContent).toBe('/')
  })
})
