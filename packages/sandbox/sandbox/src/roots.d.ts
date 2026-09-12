/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root plus the platform temp areas", and this module is that
 * meaning's one home. The Seatbelt profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, and the
 * bwrap and Landlock dialects reduce from here with explicit per-runner
 * spellings (bwrap mounts the temp area as an ephemeral `/tmp` tmpfs rather
 * than binding the host temp; Landlock grants the same canonical set through
 * launcher flags). The Windows ACL runner grants a per-session private temp
 * child rather than the whole `os.tmpdir()` the fence allows — a deliberate
 * narrowing documented here so the two tools in one session never silently
 * disagree about write scope. Parity is pinned by test.
 *
 * Network effects are out of scope: no backend confines network access, so
 * `read-only` denies file writes but does not prevent exfiltration.
 *
 * @module dsh-sandbox/roots
 */
import type { SandboxExecutionPolicy } from './index.ts'
/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or the spelling as-is when resolution fails
 *   (a missing root matches nothing until it exists — the conservative
 *   outcome; inventing a fallback would grant a path the caller never named).
 */
export declare function canonicalPath(path: string): string
/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, the host `/tmp`, and
 * the per-user platform temp dir (`os.tmpdir()` — the real temp area for
 * mkstemp-family tools; omitting it would deny what the mode promises).
 * UNC and `\\?\`-prefixed workspace roots are rejected: no backend can
 * enforce them (the Windows ACL path would hash an un-normalized UNC string
 * into a capability SID), so fail loud at derivation rather than granting an
 * unenforced scope.
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
export declare function writableRoots(policy: SandboxExecutionPolicy): string[]
/**
 * Resolve one tool call's working directory: an explicit model path first,
 * making a relative one session-workspace-relative; otherwise the filesystem
 * identity of the session cwd, leaving executor defaulting as the fallback. A
 * resolved sandbox-policy root wins so workdir and confinement use the exact
 * same per-call identity. The one home for the resolution every shell tool
 * shares, so the next fix cannot land on one call site only.
 * @param workdir - the model's explicit workdir argument, if given.
 * @param headerCwd - the calling session header cwd, if any.
 * @param root - the resolved sandbox-policy workspace root, if any.
 * @returns the workdir to pass the executor, or undefined for its default.
 */
export declare function resolveWorkdir(workdir: string | undefined, headerCwd: string | undefined, root?: string): string | undefined
//# sourceMappingURL=roots.d.ts.map
