/**
 * Classification of assembled contributions. `core/system-prompt` owns the
 * names; this module owns what each name family means to the compiler, so a
 * contribution's authority and its retention class are decided in one table
 * rather than at each use site.
 *
 * The table mirrors the section and context families that ship today. An
 * unlisted family is treated as untrusted repository content — data, never an
 * instruction authority — so a new contributor is never silently trusted.
 *
 * @module @deepseek-ai/dsh-agent-context/classify
 */

import type { TrustLabel } from '@deepseek-ai/dsh-agent-kernel'
import type { ContextSourceKind, RetentionClass } from './types.ts'

/** What one contribution family means to the compiler. */
export interface SourceClass {
  /** What the family's content is for. */
  readonly kind: ContextSourceKind
  /** Whether the family's content is instruction authority or data. */
  readonly trust: TrustLabel
  /** Which subsystem the family's content came from. */
  readonly source: 'policy' | 'tool' | 'repo' | 'subagent'
}

/** One classified contribution family. */
interface ContributionClass extends SourceClass {
  /** The `name` prefix (`harness:`, `tool:`) that selects this class. */
  readonly prefix: string
}

/**
 * The contribution families that ship today, matched by the `name` prefix
 * every registered section and runtime context already carries.
 */
export const CONTRIBUTION_CLASSES: readonly ContributionClass[] = [
  { prefix: 'harness:', kind: 'policy', trust: 'trusted', source: 'policy' },
  { prefix: 'deployment:', kind: 'policy', trust: 'trusted', source: 'policy' },
  { prefix: 'plan:', kind: 'plan', trust: 'trusted', source: 'policy' },
  { prefix: 'team:', kind: 'policy', trust: 'trusted', source: 'policy' },
  { prefix: 'sandbox:', kind: 'policy', trust: 'trusted', source: 'policy' },
  { prefix: 'approval:', kind: 'policy', trust: 'trusted', source: 'policy' },
  { prefix: 'subagent:', kind: 'policy', trust: 'trusted', source: 'subagent' },
  { prefix: 'tool:', kind: 'tool', trust: 'trusted', source: 'tool' },
  { prefix: 'tools:', kind: 'tool', trust: 'trusted', source: 'tool' },
  { prefix: 'context:', kind: 'artifact', trust: 'trusted', source: 'repo' },
  { prefix: 'ui:', kind: 'artifact', trust: 'trusted', source: 'repo' },
  { prefix: 'app:', kind: 'artifact', trust: 'trusted', source: 'repo' },
]

/** The class an unlisted contribution family resolves to. */
export const UNCLASSIFIED_CONTRIBUTION: SourceClass = {
  kind: 'artifact',
  trust: 'untrusted',
  source: 'repo',
}

/**
 * The default retention class of an assembled contribution, by kind. Authority
 * about the task itself — the permission that applies, the contract, its plan,
 * and its evidence — is placed even when it alone exceeds the ceiling; guidance
 * and data are droppable. A durable task fact read from the kernel view is
 * required regardless of its kind, because the task's own record outranks any
 * assembled guidance.
 */
export const RETENTION_BY_KIND: Record<ContextSourceKind, RetentionClass> = {
  policy: 'required',
  task: 'required',
  plan: 'required',
  evidence: 'required',
  memory: 'compressible',
  artifact: 'compressible',
  history: 'compressible',
  tool: 'compressible',
}

/**
 * Classify one registered contribution by its name.
 * @param name - the section or runtime context name.
 * @returns the family's kind, trust, and source, or the unclassified safe default.
 */
export function classifyContribution(name: string): SourceClass {
  for (const rule of CONTRIBUTION_CLASSES) {
    if (name.startsWith(rule.prefix)) return { kind: rule.kind, trust: rule.trust, source: rule.source }
  }
  return UNCLASSIFIED_CONTRIBUTION
}

/**
 * Resolve the default retention class of one assembled contribution's kind.
 * @param kind - the source kind.
 * @returns whether an assembled source of that kind may be dropped to fit a budget.
 */
export function retentionOf(kind: ContextSourceKind): RetentionClass {
  return RETENTION_BY_KIND[kind]
}
