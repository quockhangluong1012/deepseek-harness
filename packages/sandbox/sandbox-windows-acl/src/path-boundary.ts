/**
 * Canonical directory-boundary checks for the Windows ACL workspace and
 * private-temp capabilities.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/path-boundary
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** Whether `root` is the same canonical directory as `candidate` or contains it. */
function containsDirectory(root: string, candidate: string): boolean {
  let rootReal: string
  let candidateReal: string
  try {
    rootReal = realpathSync.native(root)
  } catch (error: unknown) {
    throw new Error(`Windows ACL boundary check failed: cannot resolve root "${root}"`, { cause: error })
  }
  try {
    candidateReal = realpathSync.native(candidate)
  } catch (error: unknown) {
    throw new Error(`Windows ACL boundary check failed: cannot resolve candidate "${candidate}"`, { cause: error })
  }
  const relation = relative(rootReal, candidateReal)
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * Reject a temp parent that is inside the workspace: every child created
 * below it would inherit the standing workspace capability. A temp parent
 * above the workspace is allowed because the fresh temp child is a sibling
 * of the workspace, not its parent.
 * @param workspaceRoot - the canonical workspace root that receives the standing ACE.
 * @param tempRoot - the existing parent beneath which a private temp child would be created.
 */
export function assertTempRootOutsideWorkspace(workspaceRoot: string, tempRoot: string): void {
  if (containsDirectory(workspaceRoot, tempRoot)) {
    throw new Error(`Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`)
  }
}

/**
 * Reject overlap between an actual private temp directory and any writable
 * directory: either inheritance direction would merge the two capabilities.
 * @param writableDirs - directories carrying the standing workspace capability.
 * @param tempDir - the existing directory carrying the revocable temp capability.
 */
export function assertPrivateTempDisjoint(writableDirs: readonly string[], tempDir: string): void {
  for (const writableDir of writableDirs) {
    if (containsDirectory(writableDir, tempDir) || containsDirectory(tempDir, writableDir)) {
      throw new Error(`AclSandbox private temp directory must be disjoint from writable directories: writable=${writableDir}; temp=${tempDir}`)
    }
  }
}
