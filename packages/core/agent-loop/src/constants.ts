/** Shared agent-loop scheduler defaults.
 * @module dsh-agent-loop/constants
 */

/** Default maximum in-flight parallel-safe calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10
/**
 * Default maximum entered steps per agent turn. The longest recorded product
 * turn runs 7 steps; 100 bounds a runaway tool-calling loop to 100 model
 * calls per turn while leaving legitimate long turns untouched.
 */
export const DEFAULT_MAX_STEPS = 100
/**
 * Default maximum honored `agent/request-error` retries per step. Provider
 * retry policies stay authoritative below this ceiling (their default allows
 * 5); the loop cap only stops a listener that recovers unconditionally, so a
 * step cannot retry forever.
 */
export const DEFAULT_MAX_REQUEST_RETRIES = 10
