/**
 * The one rule about a task's working directory, shared by both ends of a pairing.
 *
 * WHY IT IS SHARED: the directory is a WORKER-side absolute path. The master stores it and sends
 * it as the ACP session's `cwd`; the worker advertises what it should be inside its pairing
 * string. Both ends must agree on what "usable" means -- two copies of the rule would drift, and
 * the drift would look like a worker advertising a path the master then refuses.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS (DESIGN §6.4): this is where the task runs AND the scope the
 * sandbox allows writes to. A relative or empty value does not fail where it is set -- DSH's ACP
 * server rejects a non-absolute `cwd` with an opaque -32602, and an empty one binds the task to
 * the relay process's launch directory, so the task writes somewhere nobody chose.
 *
 * Two messages, one rule: `assertUsableCwd` is worded for the MASTER configuring a worker (it
 * names the field to fix), while `isAbsoluteTaskPath` is the bare predicate the WORKER's own
 * settings page uses to word its own refusal.
 */

/**
 * Is this a path a task may be given: absolute, non-empty?
 *
 * Windows drive-absolute (`C:\x`, `C:/x`) and POSIX-absolute (`/x`) only. A UNC path is
 * deliberately not accepted: nothing has been validated against a share, and a task whose scope
 * is a network path is a different security question than this plugin answers.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAbsoluteTaskPath(value) {
  if (typeof value !== 'string') return false
  const path = value.trim()
  if (path === '') return false
  return /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith('/')
}

/**
 * Report why a worker cwd is unusable, or '' when it is fine.
 *
 * @param {string} cwd
 * @returns {string} a human-readable problem, or '' when usable
 */
export function assertUsableCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return 'worker cwd is empty -- set `cwd` to an absolute path that exists on the worker'
  }
  if (!isAbsoluteTaskPath(cwd)) {
    return `worker cwd must be an absolute path, got "${cwd}" (a relative path would bind tasks to the relay's launch directory)`
  }
  return ''
}
