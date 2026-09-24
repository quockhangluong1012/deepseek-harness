/**
 * Built-in tool capability declarations for the agent kernel.
 *
 * The kernel's registry starts empty and fails closed, so a deployment that
 * turns on `mode: 'enforce'` stops every tool call until something declares
 * it. This plugin declares every shipped product tool: the capabilities one
 * invocation needs and the resource projection each capability applies to.
 * Mount it beside the kernel when enforce mode must govern real traffic, and
 * leave it out when a deployment declares its own surface instead.
 *
 * The declarations live here rather than in the tool packages because only
 * the policy plane may extend the capability vocabulary, and because a tool
 * package must stay mountable without the kernel. A deployment that renames a
 * tool or ships its own tools declares those itself; an undeclared tool stays
 * denied. Names minted at runtime are declared by their own bridge: the MCP
 * client declares every synced `mcp__*` tool it publishes.
 *
 * @module @deepseek-ai/dsh-agent-kernel-builtins
 */

import type { Context } from '@deepseek-ai/cordis'
import { BUILTIN_DECLARATIONS } from './declarations.ts'

export { BUILTIN_DECLARATIONS } from './declarations.ts'

/** Plugin name used by loader diagnostics. */
export const name = 'agent-kernel-builtins'

/**
 * Required services. The kernel is injected rather than imported so
 * composition order never matters: the declarations register once the kernel
 * service exists, however the two plugins were mounted.
 */
export const inject = ['agentKernel']

/**
 * Register every built-in declaration with the kernel. Registration is an
 * effect, so unloading this plugin removes exactly the declarations it added.
 * @param ctx - the mounting composition's scope context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposers = BUILTIN_DECLARATIONS.map(declaration => ctx.agentKernel.capabilities.register(declaration))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'agent-kernel-builtins.declarations')
}
