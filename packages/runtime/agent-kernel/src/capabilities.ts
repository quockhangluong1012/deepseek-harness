/**
 * The tool capability registry: which capabilities one registered tool needs,
 * and against which resource each applies.
 *
 * A tool declares its own capabilities from the package that owns it, because
 * only that package knows how an invocation maps to a resource. A tool with no
 * declaration resolves to `undefined`, which the policy engine turns into a
 * fail-closed denial — never an implicit grant.
 *
 * @module @deepseek-ai/dsh-agent-kernel/capabilities
 */

import type { CapabilityDeclaration, CapabilityRegistry, CapabilityRequest } from './types.ts'

/**
 * The registry `ctx.agentKernel.capabilities` names. Registering one tool twice
 * replaces the earlier declaration; the earlier disposer then removes nothing,
 * so a re-registration cannot leave the tool undeclared.
 */
export class ToolCapabilityRegistry implements CapabilityRegistry {
  /** The current declaration per registered tool name. */
  private readonly declarations = new Map<string, CapabilityDeclaration>()

  /**
   * Register one tool's capability declaration.
   * @param declaration - the declaration; its `resources` projection must be total.
   * @returns a disposer that removes this declaration while it is still the registered one.
   */
  register(declaration: CapabilityDeclaration): () => void {
    this.declarations.set(declaration.tool, declaration)
    return () => {
      if (this.declarations.get(declaration.tool) === declaration) this.declarations.delete(declaration.tool)
    }
  }

  /**
   * Resolve the capability requests one invocation needs.
   * @param toolName - registered tool name.
   * @param args - the call's parsed arguments.
   * @returns the requests, or undefined when the tool declared none.
   * @throws When the declaration's own `resources` projection throws, which is a defect in the declaring package.
   */
  resolve(toolName: string, args: unknown): readonly CapabilityRequest[] | undefined {
    const declaration = this.declarations.get(toolName)
    if (declaration === undefined) return undefined
    const resource = declaration.resources(args)
    return declaration.capabilities.map(capability => ({ capability, resource }))
  }

  /**
   * Whether one tool declared capabilities.
   * @param toolName - registered tool name.
   * @returns true when a declaration is registered.
   */
  has(toolName: string): boolean {
    return this.declarations.has(toolName)
  }

  /** Number of registered declarations. */
  get size(): number {
    return this.declarations.size
  }
}
