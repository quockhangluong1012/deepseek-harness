/**
 * Load-time template expansion for skill instruction bodies.
 *
 * A skill body may reference its own directory as `${DSH_SKILL_DIR}` and the loading agent's
 * session id as `${DSH_SESSION_ID}`. Expansion runs at load time in the `tool-skill` package,
 * before the shared `renderSkillContent` wrapper frames the body. Any other `${...}` sequence
 * stays verbatim, and a variable whose value is absent stays verbatim as well: virtual skills
 * carry no `path`, so they leave `${DSH_SKILL_DIR}` unexpanded, and a tool call without a
 * loading agent leaves `${DSH_SESSION_ID}` unexpanded.
 *
 * @module @deepseek-ai/dsh-tool-skill/template
 */

import { dirname } from 'node:path'

/**
 * Explicit variable record for skill body template expansion.
 */
export interface SkillTemplateVars {
  /** Skill directory derived from the skill's absolute `SKILL.md` path; absent for virtual skills. */
  readonly skillDir?: string | undefined
  /** Loading agent's session id; absent when the tool call carries no agent. */
  readonly sessionId?: string | undefined
}

/**
 * Derive the `${DSH_SKILL_DIR}` value from a skill's absolute `SKILL.md` path.
 * @param path - absolute `SKILL.md` path from the skill summary or definition; `undefined` for virtual skills.
 * @returns the skill's own directory, or `undefined` when the skill has no path so the variable stays verbatim.
 */
export function skillDirForSkillPath(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined
  }
  return dirname(path)
}

/**
 * Expand the known skill body template variables in one instruction body.
 * @param content - raw skill instruction body.
 * @param vars - explicit values for the known variables; absent values stay verbatim.
 * @returns the body with `${DSH_SKILL_DIR}` and `${DSH_SESSION_ID}` replaced where values exist.
 */
export function expandSkillTemplates(content: string, vars: SkillTemplateVars): string {
  return content.replace(/\$\{DSH_SKILL_DIR\}|\$\{DSH_SESSION_ID\}/g, (match) => {
    if (match === '${DSH_SKILL_DIR}') {
      return vars.skillDir ?? match
    }
    return vars.sessionId ?? match
  })
}
