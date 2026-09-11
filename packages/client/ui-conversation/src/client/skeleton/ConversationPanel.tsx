/** Root-scoped main occupant; Session binding belongs to its Conversation child. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'

/**
 * Render the Conversation with optional current-Session binding.
 * @param props - main-slot inputs and the declared Conversation renderer.
 * @returns the Conversation subtree.
 */
export function ConversationPanel({
  renderSlot, pageOccupied,
}: PropsRuntime<'main'> & PropsRenderSlots<'main.conversation'>) {
  // The frame owns the page slot and hands its occupancy down as this slot's
  // owner share; the Conversation reads the fact through its own seat.
  return renderSlot('main.conversation', { pageOccupied })
}
