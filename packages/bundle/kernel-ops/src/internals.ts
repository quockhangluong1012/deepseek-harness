/**
 * Process output for the kernel command line. Tests replace these through
 * {@link internals}, so a command can be driven without capturing the real
 * stdio streams.
 * @module @deepseek-ai/dsh-kernel-ops/internals
 */

/** Writers an ops command prints through. */
export const internals: {
  /** Write one command's ordinary output. */
  write: (text: string) => void
  /** Write one command's failure text. */
  writeError: (text: string) => void
} = {
  write: (text) => { process.stdout.write(text) },
  writeError: (text) => { process.stderr.write(text) },
}
