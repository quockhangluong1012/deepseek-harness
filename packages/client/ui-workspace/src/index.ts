/**
 * Workspace picker plugin, node half. Declares the optional `workspacePage`
 * opener seam; the browser half ships via exports["./client"], discovered
 * through the package.json dsh.client declaration.
 */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/**
 * Optional opener for a Workspace's own page; absent compositions fall back
 * to expand/collapse. Lives here so the sidebar never depends on a specific
 * page implementation and the type edge points one way.
 */
export interface WorkspacePageOpener {
  /**
   * Open one Workspace's page.
   * @param workspaceId - Workspace identity to show.
   */
  open(workspaceId: WorkspaceId): void
}

/** Host plugin body — no host-side behavior for the workspace picker plugin. */
export function apply(): void {}
