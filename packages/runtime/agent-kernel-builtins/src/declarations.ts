/**
 * Capability declarations for every shipped product tool.
 *
 * Each entry names the capabilities one invocation needs and projects the
 * call's parsed arguments to the resource each capability applies to. Every
 * projection is total and never empty: an absent or malformed argument falls
 * back to a constant naming the tool's domain, so an unknown resource matches
 * only broad rules and can never slip past a narrow one.
 *
 * The table is verified against the generated tool catalog
 * (`docs/tool-catalog.md`): a shipped tool with no entry fails the coverage
 * spec, so a new tool cannot arrive undeclared.
 *
 * @module @deepseek-ai/dsh-agent-kernel-builtins/declarations
 */

import type { CapabilityDeclaration } from '@deepseek-ai/dsh-agent-kernel'

/**
 * Read one non-empty string field from parsed arguments.
 * @param args - the call's parsed arguments.
 * @param names - field names to try, in order.
 * @param fallback - the domain constant when no field carries text.
 * @returns the first non-empty value, or the fallback.
 */
function fieldOf(args: unknown, names: readonly string[], fallback: string): string {
  if (typeof args !== 'object' || args === null) return fallback
  for (const name of names) {
    const value = (args as Record<string, unknown>)[name]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return fallback
}

/**
 * Read one string array field from parsed arguments and join it.
 * @param args - the call's parsed arguments.
 * @param name - the array field name.
 * @param fallback - the domain constant when the field is absent or empty.
 * @returns the joined members, or the fallback.
 */
function joinedOf(args: unknown, name: string, fallback: string): string {
  if (typeof args !== 'object' || args === null) return fallback
  const value = (args as Record<string, unknown>)[name]
  if (!Array.isArray(value)) return fallback
  const members = value.filter((member): member is string => typeof member === 'string' && member.length > 0)
  return members.length > 0 ? members.join(' ') : fallback
}

/**
 * Read the labels of one `ask_user_question` call.
 * @param args - the call's parsed arguments.
 * @returns the joined question ids, or the user domain constant.
 */
function questionIdsOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) return 'user'
  const value = (args as Record<string, unknown>).questions
  if (!Array.isArray(value)) return 'user'
  const ids = value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => item.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids.length > 0 ? ids.join(' ') : 'user'
}

/**
 * Read the paths one `present` call delivers.
 * @param args - the call's parsed arguments.
 * @returns the joined file paths, or the presentation domain constant.
 */
function presentPathsOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) return 'present'
  const value = (args as Record<string, unknown>).files
  const paths = Array.isArray(value)
    ? value
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(item => item.path)
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
    : []
  if (paths.length > 0) return paths.join(' ')
  return fieldOf(args, ['path'], 'present')
}

/**
 * Read one workflow run's name.
 * @param args - the call's parsed arguments.
 * @returns the workflow meta name, the title, or the workflow domain constant.
 */
function workflowNameOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) return 'workflow'
  const meta = (args as Record<string, unknown>).meta
  if (typeof meta === 'object' && meta !== null) {
    const name = (meta as Record<string, unknown>).name
    if (typeof name === 'string' && name.length > 0) return name
  }
  return fieldOf(args, ['title'], 'workflow')
}

/**
 * One declaration per shipped product tool. Capabilities come from the fixed
 * kernel vocabulary; the comment on each family says why its tools land where
 * they do, so a reviewer can tell a principled mapping from a convenient one.
 */
export const BUILTIN_DECLARATIONS: readonly CapabilityDeclaration[] = [
  // Filesystem reads: content enters context but changes nothing on disk.
  { tool: 'read', capabilities: ['fs.read'], resources: args => fieldOf(args, ['file_path'], 'read') },
  { tool: 'read_image', capabilities: ['fs.read'], resources: args => fieldOf(args, ['file_path'], 'read_image') },
  { tool: 'glob', capabilities: ['fs.read'], resources: args => fieldOf(args, ['path', 'pattern'], 'glob') },
  { tool: 'grep', capabilities: ['fs.read'], resources: args => fieldOf(args, ['path', 'pattern'], 'grep') },
  // Filesystem mutations: the path selects the rule, as with the fs tools.
  { tool: 'write', capabilities: ['fs.write'], resources: args => fieldOf(args, ['file_path'], 'write') },
  { tool: 'edit', capabilities: ['fs.edit'], resources: args => fieldOf(args, ['file_path'], 'edit') },
  // The editor reads the current content on every command and mutates on all
  // but `view`; `create` is treated as an edit of the workspace so one
  // declaration covers the tool without a per-command capability split.
  {
    tool: 'str_replace_editor',
    capabilities: ['fs.read', 'fs.edit'],
    resources: args => fieldOf(args, ['path'], 'str_replace_editor'),
  },
  // Shell execution, one-shot or persistent: the command selects the rule.
  { tool: 'bash', capabilities: ['process.exec'], resources: args => fieldOf(args, ['command'], 'shell') },
  { tool: 'pwsh', capabilities: ['process.exec'], resources: args => fieldOf(args, ['command'], 'shell') },
  // Interactive terminal sessions: the session, not a single command.
  { tool: 'terminal_open', capabilities: ['terminal.interactive'], resources: args => fieldOf(args, ['name', 'type'], 'terminal') },
  { tool: 'terminal_read', capabilities: ['terminal.interactive'], resources: args => fieldOf(args, ['sessionId'], 'terminal') },
  { tool: 'terminal_send', capabilities: ['terminal.interactive'], resources: args => fieldOf(args, ['sessionId'], 'terminal') },
  { tool: 'terminal_signal', capabilities: ['terminal.interactive'], resources: args => fieldOf(args, ['sessionId'], 'terminal') },
  { tool: 'terminal_close', capabilities: ['terminal.interactive'], resources: args => fieldOf(args, ['sessionId'], 'terminal') },
  { tool: 'terminal_list', capabilities: ['terminal.interactive'], resources: () => 'terminal' },
  // Network reads: the query or URL selects the rule.
  { tool: 'web_search', capabilities: ['network.read'], resources: args => joinedOf(args, 'queries', 'web') },
  { tool: 'web_fetch', capabilities: ['network.read'], resources: args => fieldOf(args, ['url'], 'web') },
  // Sandboxed code execution runs code, so it carries the exec capability with
  // the call's own description as the selector.
  { tool: 'run_code', capabilities: ['process.exec'], resources: args => fieldOf(args, ['description'], 'run_code') },
  // Delegation: spawning or steering a subagent, or running the team tools
  // that direct one. The description, label, or target selects the rule.
  { tool: 'subagent', capabilities: ['subagent.spawn'], resources: args => fieldOf(args, ['description'], 'subagent') },
  { tool: 'subagent_fork', capabilities: ['subagent.spawn'], resources: args => fieldOf(args, ['description'], 'subagent') },
  { tool: 'list_subagent_models', capabilities: ['subagent.spawn'], resources: args => fieldOf(args, ['provider'], 'subagent') },
  { tool: 'interrupt_agent', capabilities: ['subagent.spawn'], resources: args => fieldOf(args, ['agent_id', 'target'], 'subagent') },
  { tool: 'send_message', capabilities: ['subagent.spawn'], resources: args => fieldOf(args, ['agent_id', 'target'], 'subagent') },
  { tool: 'list_agents', capabilities: ['subagent.spawn'], resources: args => fieldOf(args, ['scope'], 'agents') },
  { tool: 'spawn_teammate', capabilities: ['subagent.spawn'], resources: args => fieldOf(args, ['name'], 'subagent') },
  { tool: 'wait_agent', capabilities: ['subagent.spawn'], resources: () => 'subagent' },
  // Team task boards keep agent-team work state; the task id or subject
  // selects the rule, like any other piece of task memory.
  { tool: 'team_task_create', capabilities: ['memory.write'], resources: args => fieldOf(args, ['subject'], 'team') },
  { tool: 'team_task_get', capabilities: ['memory.read'], resources: args => fieldOf(args, ['task_id'], 'team') },
  { tool: 'team_task_list', capabilities: ['memory.read'], resources: () => 'team' },
  { tool: 'team_task_update', capabilities: ['memory.write'], resources: args => fieldOf(args, ['task_id'], 'team') },
  // Workflows and schedules start deferred work; the name or title selects it.
  { tool: 'workflow', capabilities: ['workflow.start'], resources: args => workflowNameOf(args) },
  { tool: 'ralph', capabilities: ['workflow.start'], resources: args => fieldOf(args, ['objective'], 'ralph') },
  { tool: 'schedule_create', capabilities: ['workflow.start'], resources: args => fieldOf(args, ['at', 'date'], 'schedule') },
  { tool: 'schedule_delete', capabilities: ['workflow.start'], resources: args => fieldOf(args, ['id'], 'schedule') },
  { tool: 'schedule_list', capabilities: ['memory.read'], resources: () => 'schedule' },
  // Goals and todos are task memory the harness itself keeps.
  { tool: 'create_goal', capabilities: ['memory.write'], resources: args => fieldOf(args, ['objective'], 'goal') },
  { tool: 'update_goal', capabilities: ['memory.write'], resources: args => fieldOf(args, ['goal_id'], 'goal') },
  { tool: 'get_goal', capabilities: ['memory.read'], resources: () => 'goal' },
  { tool: 'todo_write', capabilities: ['memory.write'], resources: () => 'todo' },
  // Session queries read the harness's own durable records.
  { tool: 'session_event_read', capabilities: ['memory.read'], resources: args => fieldOf(args, ['session_id'], 'session') },
  { tool: 'session_event_search', capabilities: ['memory.read'], resources: args => fieldOf(args, ['query', 'session_id'], 'session') },
  { tool: 'session_event_trace', capabilities: ['memory.read'], resources: args => fieldOf(args, ['session_id'], 'session') },
  { tool: 'session_search', capabilities: ['memory.read'], resources: args => fieldOf(args, ['query'], 'session') },
  { tool: 'session_trace', capabilities: ['memory.read'], resources: args => fieldOf(args, ['session_id'], 'session') },
  // Presentations and skills read workspace content into context: the paths or
  // the skill name select the rule.
  { tool: 'present', capabilities: ['fs.read'], resources: presentPathsOf },
  { tool: 'lsp', capabilities: ['fs.read'], resources: args => fieldOf(args, ['file_path'], 'lsp') },
  { tool: 'skill', capabilities: ['fs.read'], resources: args => fieldOf(args, ['name'], 'skill') },
  // The plan tool and the cordis toolset reach the runtime's own composition:
  // leaving plan mode or mounting code is proposed policy, not file or shell.
  { tool: 'exit_plan_mode', capabilities: ['policy.propose'], resources: () => 'plan' },
  { tool: 'cordis_define', capabilities: ['policy.propose'], resources: args => fieldOf(args, ['pluginId', 'packageId', 'idPrefix'], 'cordis') },
  { tool: 'cordis_inspect_list', capabilities: ['policy.propose'], resources: () => 'cordis' },
  { tool: 'cordis_inspect_query', capabilities: ['policy.propose'], resources: args => fieldOf(args, ['method', 'provider', 'platform'], 'cordis') },
  { tool: 'cordis_inspect_self', capabilities: ['policy.propose'], resources: args => fieldOf(args, ['pluginId', 'packageId'], 'cordis') },
  { tool: 'cordis_run', capabilities: ['policy.propose'], resources: args => fieldOf(args, ['pluginId', 'packageId'], 'cordis') },
  { tool: 'cordis_stop', capabilities: ['policy.propose'], resources: args => fieldOf(args, ['pluginId'], 'cordis') },
  { tool: 'cordis_undefine', capabilities: ['policy.propose'], resources: args => fieldOf(args, ['pluginId'], 'cordis') },
  // Background jobs observe or stop shell work; stopping executes, listing and
  // reading observe recorded output.
  { tool: 'job_kill', capabilities: ['process.exec'], resources: args => fieldOf(args, ['job_id'], 'jobs') },
  { tool: 'job_list', capabilities: ['memory.read'], resources: () => 'jobs' },
  { tool: 'job_output', capabilities: ['memory.read'], resources: args => fieldOf(args, ['job_id'], 'jobs') },
  // Asking the user is requesting a human decision, with the question ids as
  // the selector.
  { tool: 'ask_user_question', capabilities: ['approval.request'], resources: questionIdsOf },
  // MCP resource access rides the same bridge as the server's tools, so the
  // server and the resource URI select the rule.
  { tool: 'list_mcp_resources', capabilities: ['mcp.call'], resources: args => `mcp:${fieldOf(args, ['server'], 'mcp')}` },
  { tool: 'list_mcp_resource_templates', capabilities: ['mcp.call'], resources: args => `mcp:${fieldOf(args, ['server'], 'mcp')}` },
  { tool: 'read_mcp_resource', capabilities: ['mcp.call'], resources: args => `mcp:${fieldOf(args, ['server'], 'mcp')}/${fieldOf(args, ['uri'], 'resource')}` },
  // Managing the profile's plugins and bundles changes the runtime's own
  // composition: proposed policy, with the action and target as the selector.
  { tool: 'plugin_manager', capabilities: ['policy.propose'], resources: args => fieldOf(args, ['target', 'action'], 'plugins') },
  // The workspace dependency payload only reports bundled interpreter and
  // library paths; it reads, and the constant names the payload family.
  { tool: 'load_workspace_dependencies', capabilities: ['fs.read'], resources: () => 'workspace-dependencies' },
  // Browser automation reads the live session: navigation selects the URL it
  // opens, and every other action selects the instruction it carries.
  { tool: 'stagehand_navigate', capabilities: ['browser.read'], resources: args => fieldOf(args, ['url'], 'browser') },
  { tool: 'stagehand_act', capabilities: ['browser.read'], resources: args => fieldOf(args, ['instruction'], 'browser') },
  { tool: 'stagehand_observe', capabilities: ['browser.read'], resources: args => fieldOf(args, ['instruction'], 'browser') },
  { tool: 'stagehand_extract', capabilities: ['browser.read'], resources: args => fieldOf(args, ['instruction'], 'browser') },
  { tool: 'stagehand_screenshot', capabilities: ['browser.read'], resources: args => fieldOf(args, ['url'], 'browser') },
  { tool: 'stagehand_tabs', capabilities: ['browser.read'], resources: args => fieldOf(args, ['url', 'action'], 'browser') },
]
