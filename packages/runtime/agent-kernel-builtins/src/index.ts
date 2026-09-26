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
 * The same shipped-surface role covers §10.6's independent reviewer: this
 * plugin registers the product's reviewer on the kernel's coding-lifecycle
 * port, so a deployment that mounts both gets the REVIEW phase's implementer
 * without composing one. The reviewer stays dormant until a deployment enables
 * `Config.codingLifecycle.review.enabled` on the kernel.
 *
 * @module @deepseek-ai/dsh-agent-kernel-builtins
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { BUILTIN_DECLARATIONS } from './declarations.ts'
import { registerCodingReviewer } from './reviewer.ts'

export { BUILTIN_DECLARATIONS } from './declarations.ts'
export { registerCodingReviewer } from './reviewer.ts'

/** Plugin name used by loader diagnostics. */
export const name = 'agent-kernel-builtins'

/** Plugin configuration. */
export interface Config {
  /**
   * Whether this plugin registers the shipped independent reviewer on the
   * kernel's coding-lifecycle port. Switch it off when the deployment registers
   * its own reviewer, because the kernel refuses a second one.
   */
  reviewer?: boolean
}

/** Runtime configuration schema for the built-ins plugin. */
export const Config: Schema<Config> = z.object({
  reviewer: z.boolean().default(true),
})

/**
 * Required services. The kernel is injected rather than imported so
 * composition order never matters: the declarations register once the kernel
 * service exists, however the two plugins were mounted.
 */
export const inject = ['agentKernel']

/**
 * Register every built-in declaration with the kernel, and the shipped
 * independent reviewer unless the deployment supplies its own. Registration is
 * an effect, so unloading this plugin removes exactly what it added.
 * @param ctx - the mounting composition's scope context.
 * @param config - validated plugin configuration; an omitted field takes its schema default.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => {
    const disposers = BUILTIN_DECLARATIONS.map(declaration => ctx.agentKernel.capabilities.register(declaration))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'agent-kernel-builtins.declarations')
  if (config.reviewer ?? true) {
    ctx.effect(() => registerCodingReviewer(ctx), 'agent-kernel-builtins.reviewer')
  }
}
