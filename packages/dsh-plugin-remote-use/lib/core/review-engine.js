/**
 * 审批决策核心（INTERFACES.md 【A】；规则依据 DESIGN §8.3 / §10.0.1 / §13.4）。
 *
 * **纯逻辑模块**：不引入任何依赖、不用 `node:fs`、不做 I/O、不用网络。
 *
 * 为什么必须有这个模块（实测，DESIGN §10.0.1）：
 *   1. ACP 的 `session/request_permission` **只带 `toolCallId`**——没有工具名、没有参数，
 *      也没有申请的沙箱档位（§13.3 / §13.4）。
 *   2. 模型会**过度申请权限**：一次「写单个文件到工作区外」被沙箱拒绝后，它申请的是
 *      `danger-full-access`（最高档，整个文件系统无限制），而不是够用的窄档。
 *   ⇒ 主机若无条件放行，**第一次越权申请就等于交出全盘控制**。
 *
 * 因此这里的规则引擎从缓存取回 `rawInput`，读出 `sandbox_permissions`，与本次操作
 * 实际所需的最小档位比较：申请宽于所需即拒绝；`danger-full-access` 一律要求人工确认，
 * 规则不得自动放行。
 *
 * **规则顺序本身是被测契约**（顺序写错必须能让测试失败）：
 *   1. 缓存缺失（`rawInput === undefined`）→ `reject-once` / `source='cache-miss'`
 *   2. 档位检查（`danger-full-access` → 人工；宽于所需 → `reject-once` / `'tier-check'`）
 *   3. 任务内拒绝记忆 → `reject-once` / `'memory'`
 *   4. 任务内批准记忆 → `allow-once` / `'memory'`
 *   5. 任务级授权范围（`allowedPaths` / `allowedTools`）→ `allow-once` / `'policy'`
 *   6. 其余 → 上报人工（缺省 `optionId` 为 `reject-once`，人工批准后由调用方覆盖）
 */

/** 沙箱档位，从窄到宽（DESIGN §8.3 档位比较表）。 */
export const TIER = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** 审批应答的 optionId：ACP 硬编码只有这两个值（DESIGN §2.3）。 */
export const OPTION = /** @type {{ readonly ALLOW_ONCE: 'allow-once', readonly REJECT_ONCE: 'reject-once' }} */ ({
  ALLOW_ONCE: 'allow-once',
  REJECT_ONCE: 'reject-once',
})

/**
 * 默认「写类工具」名单。INTERFACES.md 要求至少含这四个；
 * 调用方可用 `policy.writeTools` 扩展（例如再包一层自定义写工具）。
 */
export const WRITE_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor', 'fs_write'])

/**
 * 默认「命令类工具」名单：档位按 `workspace-write` 判，记忆键取命令首词。
 */
export const COMMAND_TOOLS = Object.freeze(['pwsh', 'bash', 'sh', 'cmd', 'powershell', 'shell'])

/**
 * `policy.requiredTier` 缺失/非法时的兜底所需档位（取中间档）。
 * 决策路径**绝不抛错**：一次抛错等于审批无人应答，从机 turn 会永久挂起（DESIGN §8.4）。
 */
export const FALLBACK_TIER = 'workspace-write'

/** 无限制档：申请它必须人工确认，规则不得自动放行（DESIGN §8.3 / §10.0.1）。 */
const DANGER_TIER = 'danger-full-access'

/**
 * @typedef {object} ApprovalRequest
 * @property {string} toolCallId
 * @property {string} toolName             来自 `tool_call` 缓存的 `title`
 * @property {unknown} rawInput            缓存的完整参数；`undefined` = 缓存缺失
 * @property {string} taskId
 */

/**
 * @typedef {object} Decision
 * @property {'allow-once'|'reject-once'} optionId
 * @property {'memory'|'policy'|'human'|'cache-miss'|'tier-check'} source
 * @property {string} reason               人类可读，进审计；被拒时会作为 diagnostic 反馈给模型
 * @property {boolean} needsHuman          `true` 表示规则引擎无法决定，需要上报人工
 */

/**
 * 审批策略（`decideApproval` 的 `ctx.policy`）。
 *
 * `requiredTier` 是**本次操作所需的最小档位**，由调用方决定；调用方可用
 * `inferRequiredTier(rawInput, { workspaceRoot, toolName, defaultTier })` 计算它。
 * 下面三个带 `?` 的字段是**契约之外的兼容扩展**：只在 `requiredTier` 缺失/非法、
 * 需要引擎自己兜底推断时才会被使用。
 *
 * @typedef {object} ApprovalPolicy
 * @property {string} requiredTier
 * @property {string[]} [allowedTools]  任务级授权：工具名白名单
 * @property {string[]} [allowedPaths]  任务级授权：目录白名单（前缀包含）
 * @property {string} [workspaceRoot]   兼容扩展：兜底推断用的工作区根
 * @property {string[]} [writeTools]    兼容扩展：覆盖默认写类工具名单
 * @property {string[]} [commandTools]  兼容扩展：覆盖默认命令类工具名单
 */

/**
 * 规范化后的路径。
 * @typedef {object} NormalizedPath
 * @property {string} path        规范化路径（`'/'` 分隔，已折叠 `'.'` / `'..'`）
 * @property {string} key         比较用键（Windows 风格路径已小写）
 * @property {boolean} absolute   是否绝对路径
 * @property {boolean} windows    是否 Windows 风格（盘符或 UNC）
 */

/** @type {Set<string>} */
const WRITE_TOOL_SET = new Set(WRITE_TOOLS)

/** @type {Set<string>} */
const COMMAND_TOOL_SET = new Set(COMMAND_TOOLS)

/**
 * 审批决策。**顺序与规则**见文件头（顺序是被测契约）。
 *
 * 唯一的副作用：命中规则 4 且记忆里是 `'once'` 作用域的批准时，会调用
 * `memory.consumeOnce(key)` 把它用掉——「批准一次」必须真的只放行一次，不能依赖
 * 调用方自觉（否则它会静默退化成任务级授权）。
 *
 * @param {ApprovalRequest} req
 * @param {object} ctx
 * @param {import('./task-memory.js').TaskMemory} ctx.memory
 * @param {ApprovalPolicy} ctx.policy
 * @returns {Decision}
 */
export function decideApproval(req, ctx) {
  const request = isPlainObject(req) ? req : {}
  const context = isPlainObject(ctx) ? ctx : {}
  const policy = isPlainObject(context.policy) ? context.policy : {}
  const memory = isPlainObject(context.memory) ? context.memory : undefined
  const toolCallId = typeof request.toolCallId === 'string' && request.toolCallId !== '' ? request.toolCallId : undefined
  const rawInput = request.rawInput

  // ── 规则 1：缓存缺失 → 直接拒绝，绝不默认放行（DESIGN §5.2 / §8.3）──────────────
  if (!isPlainObject(rawInput)) {
    return decision(
      OPTION.REJECT_ONCE,
      'cache-miss',
      false,
      cacheMissReason(toolCallId, rawInput),
    )
  }

  // ── 规则 2：档位检查（DESIGN §8.3；主机审批请求看不到申请内容，只能靠缓存）─────
  const requestedTier = readRequestedTier(rawInput)
  const requiredTier = resolveRequiredTier(request, policy)
  if (requestedTier !== undefined) {
    if (!TIER.includes(requestedTier)) {
      return decision(
        OPTION.REJECT_ONCE,
        'tier-check',
        false,
        unrecognizedTierReason(requestedTier, requiredTier),
      )
    }
    if (requestedTier === DANGER_TIER) {
      // 无限制档：规则不得自动放行，必须人工确认（§10.0.1 的核心缺口）
      return decision(
        OPTION.REJECT_ONCE,
        'tier-check',
        true,
        dangerTierReason(requiredTier),
      )
    }
    if (tierIndex(requestedTier) > tierIndex(requiredTier)) {
      return decision(
        OPTION.REJECT_ONCE,
        'tier-check',
        false,
        tooWideTierReason(requestedTier, requiredTier),
      )
    }
  }

  // ── 规则 3 / 4：任务内记忆（键在档位检查之后才算，顺序由契约固定）──────────────
  const key = memoryKey(request)
  const state = typeof memory?.lookup === 'function' ? memory.lookup(key) : 'unknown'
  if (state === 'rejected') {
    return decision(OPTION.REJECT_ONCE, 'memory', false, rejectMemoryReason(key))
  }
  if (state === 'allowed') {
    const consumedOnce =
      typeof memory?.consumeOnce === 'function' ? memory.consumeOnce(key) === true : false
    return decision(OPTION.ALLOW_ONCE, 'memory', false, approveMemoryReason(key, consumedOnce))
  }

  // ── 规则 5：任务级授权范围 ──────────────────────────────────────────────────
  const authorization = matchTaskAuthorization(request, policy)
  if (authorization !== undefined) {
    return decision(OPTION.ALLOW_ONCE, 'policy', false, policyReason(key, authorization))
  }

  // ── 规则 6：上报人工（缺省 optionId 为 reject-once，人工批准后调用方覆盖）───────
  return decision(OPTION.REJECT_ONCE, 'human', true, humanReason(key))
}

/**
 * 从 `rawInput` 推断「本次操作实际需要的最小档位」。保守：判定不清时返回 `defaultTier`。
 *
 * 规则（按本实现的判定顺序）：
 *   1. 不是对象 / 空对象 / 无路径无命令信息 → `defaultTier`
 *   2. 命令类工具（`toolName ∈ commandTools`，或未给工具名但 `rawInput.command` 非空）
 *      → `'workspace-write'`
 *   3. 涉及文件路径（`rawInput.file_path` / `rawInput.path`）：
 *      - 路径在 `workspaceRoot` 之外（或无法判定为之内）→ `'workspace-write'`
 *      - 路径在 `workspaceRoot` 之内 → 写类操作 `'workspace-write'`，否则 `'read-only'`
 *      - 无法解析成绝对路径（相对路径且没有绝对 `workspaceRoot`）→ `defaultTier`
 *
 * 写类判定优先用 `opts.toolName ∈ writeTools`；`toolName` 缺失时退化为看参数形状
 * （`content` / `new_string` / `edits` / `patch` …），宁可判宽。
 *
 * ⚠️ 契约签名里没有 `toolName`，而「写操作仍需 workspace-write」只能由工具名判定；
 * 因此本实现接受**契约之外的** `opts.toolName` / `opts.commandTools`（可选，缺省不报错）。
 * `decideApproval` 会把 `req.toolName` 传进来。
 *
 * @param {unknown} rawInput
 * @param {{ workspaceRoot?: string, writeTools?: string[], commandTools?: string[], toolName?: string, defaultTier: string }} opts
 * @returns {string} 档位名（`TIER` 之一）
 */
export function inferRequiredTier(rawInput, opts) {
  const options = isPlainObject(opts) ? opts : {}
  const fallback = TIER.includes(options.defaultTier) ? options.defaultTier : FALLBACK_TIER
  if (!isPlainObject(rawInput)) return fallback

  const writeTools = toNameSet(options.writeTools, WRITE_TOOL_SET)
  const commandTools = toNameSet(options.commandTools, COMMAND_TOOL_SET)
  const toolName = typeof options.toolName === 'string' ? options.toolName : undefined

  // 2) 命令类工具
  const isCommandTool =
    toolName !== undefined && toolName.trim() !== ''
      ? commandTools.has(toolName.trim().toLowerCase())
      : firstToken(extractCommand(rawInput)) !== undefined
  if (isCommandTool) return 'workspace-write'

  // 1) / 3) 路径类
  const targetRaw = extractPathValue(rawInput)
  if (targetRaw === undefined) return fallback
  const root = normalizePath(options.workspaceRoot)
  if (root === undefined) return fallback
  const target = normalizePath(targetRaw)
  if (target === undefined) return fallback
  const resolved = target.absolute ? target : resolveRelative(root, target)
  if (resolved === undefined) return fallback

  if (isPathInside(root, resolved)) {
    return isWriteOperation(toolName, rawInput, writeTools) ? 'workspace-write' : 'read-only'
  }
  return 'workspace-write'
}

/**
 * 记忆键（导出以便测试与审计）。
 *
 *   - 写类工具 → `write:<目录前缀>`（取 `rawInput.file_path` / `rawInput.path` 的父目录，
 *     **保留原样分隔符**，便于审计时和模型自己的路径对照）
 *   - 命令类工具 → `exec:<命令首词>`（`rawInput.command` 的第一个空白分隔 token）
 *   - 其余 → `tool:<toolName>`
 *
 * 兜底：写类工具但没给路径 → 退化为 `tool:<toolName>`；路径没有目录部分（如 `a.txt`）
 * → `write:.`；工具名缺失 → `tool:unknown`。
 *
 * @param {ApprovalRequest} req
 * @returns {string} 非空记忆键
 */
export function memoryKey(req) {
  const request = isPlainObject(req) ? req : {}
  const toolName =
    typeof request.toolName === 'string' && request.toolName.trim() !== ''
      ? request.toolName.trim()
      : undefined
  const rawInput = request.rawInput
  const kind = classifyTool(toolName, rawInput)
  if (kind === 'write') {
    const directory = parentDirectory(extractPathValue(rawInput))
    if (directory !== undefined) return `write:${directory}`
  } else if (kind === 'command') {
    const token = firstToken(extractCommand(rawInput))
    if (token !== undefined) return `exec:${token}`
  }
  return `tool:${toolName ?? 'unknown'}`
}

/* ─────────────────────────── 决策辅助 ─────────────────────────── */

/**
 * 构造 Decision（字段顺序与契约 typedef 一致）。
 * @param {'allow-once'|'reject-once'} optionId
 * @param {'memory'|'policy'|'human'|'cache-miss'|'tier-check'} source
 * @param {boolean} needsHuman
 * @param {string} reason
 * @returns {Decision}
 */
function decision(optionId, source, needsHuman, reason) {
  return { optionId, source, reason, needsHuman }
}

/**
 * 解析「本次操作所需的最小档位」：以 `policy.requiredTier` 为权威；
 * 缺失/非法时才用 `inferRequiredTier` 兜底（决策路径不抛错、不静默放行）。
 * @param {ApprovalRequest} request
 * @param {ApprovalPolicy} policy
 * @returns {string}
 */
function resolveRequiredTier(request, policy) {
  if (TIER.includes(policy.requiredTier)) return policy.requiredTier
  return inferRequiredTier(request.rawInput, {
    workspaceRoot: policy.workspaceRoot,
    toolName: request.toolName,
    writeTools: policy.writeTools,
    commandTools: policy.commandTools,
    defaultTier: FALLBACK_TIER,
  })
}

/**
 * 读出申请档位（可能不存在 = 不申请提权）。
 *
 * 同时接受 `sandbox_permissions`（契约字段）与 `sandboxPermissions`（防御性别名：
 * 如果模型换了拼写而主机不认识，就会漏掉一次真实提权申请）。两者同时出现时取**更宽**
 * 的那个（fail closed）。
 *
 * @param {Record<string, unknown>} rawInput
 * @returns {string | undefined}
 */
function readRequestedTier(rawInput) {
  const candidates = [rawInput.sandbox_permissions, rawInput.sandboxPermissions]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => /** @type {string} */ (value).trim())
  if (candidates.length === 0) return undefined
  for (const candidate of candidates) {
    if (!TIER.includes(candidate)) return candidate // 未知档位 → 走「无法比较」的拒绝分支
  }
  return candidates.reduce((widest, current) =>
    tierIndex(current) > tierIndex(widest) ? current : widest,
  )
}

/**
 * 任务级授权范围匹配（`allowedTools` 精确匹配、`allowedPaths` 前缀包含）。
 * @param {ApprovalRequest} request
 * @param {ApprovalPolicy} policy
 * @returns {string | undefined} 命中说明（拼进 reason）；未命中 `undefined`
 */
function matchTaskAuthorization(request, policy) {
  /** @type {string[]} */
  const matches = []
  const toolName = typeof request.toolName === 'string' ? request.toolName : undefined
  const allowedTools = Array.isArray(policy.allowedTools) ? policy.allowedTools : []
  if (toolName !== undefined && allowedTools.some((allowed) => allowed === toolName)) {
    matches.push(`tool "${toolName}" is listed in allowedTools`)
  }

  const allowedPaths = Array.isArray(policy.allowedPaths) ? policy.allowedPaths : []
  const targetRaw = extractPathValue(request.rawInput)
  if (targetRaw !== undefined && allowedPaths.length > 0) {
    const target = resolveTargetPath(targetRaw, policy.workspaceRoot)
    if (target !== undefined) {
      for (const entry of allowedPaths) {
        const root = normalizePath(entry)
        if (root !== undefined && isPathInside(root, target)) {
          matches.push(`path "${targetRaw}" is under allowedPaths entry "${String(entry)}"`)
          break
        }
      }
    }
  }

  return matches.length > 0 ? matches.join('; ') : undefined
}

/* ─────────────────────────── reason 文案 ─────────────────────────── */

/**
 * @param {string | undefined} toolCallId
 * @param {unknown} rawInput
 * @returns {string}
 */
function cacheMissReason(toolCallId, rawInput) {
  const id = toolCallId ?? '(missing toolCallId)'
  const shape = rawInput === undefined ? 'undefined' : rawInput === null ? 'null' : typeof rawInput
  return (
    `Cache miss for toolCallId "${id}" (rawInput is ${shape}): the host has no recorded ` +
    `tool_call, so it cannot read sandbox_permissions or the tool arguments. Denied by default ` +
    `(fail closed). Re-issue the tool call so the host records it before requesting escalation.`
  )
}

/**
 * @param {string} requested
 * @param {string} required
 * @returns {string}
 */
function unrecognizedTierReason(requested, required) {
  return (
    `Requested sandbox tier "${requested}" is not a recognized tier ` +
    `(narrow to wide: ${TIER.join(' < ')}), so it cannot be verified. Rejected. ` +
    `Retry with the narrowest sufficient tier: "${required}".`
  )
}

/**
 * @param {string} required
 * @returns {string}
 */
function dangerTierReason(required) {
  const head =
    `Requested sandbox tier "${DANGER_TIER}" is the unrestricted tier: it always requires ` +
    `explicit human confirmation on the host and must never be auto-approved by a rule.`
  if (tierIndex(required) < tierIndex(DANGER_TIER)) {
    return `${head} If this operation only needs the narrowest sufficient tier, retry with "${required}" instead.`
  }
  return `${head} No narrower tier is sufficient for this operation, so human confirmation is mandatory.`
}

/**
 * @param {string} requested
 * @param {string} required
 * @returns {string}
 */
function tooWideTierReason(requested, required) {
  return (
    `Requested sandbox tier "${requested}" is wider than the minimum required tier "${required}" ` +
    `for this operation. Over-requesting is rejected: retry this exact operation with the ` +
    `narrowest sufficient tier "${required}", or omit "sandbox_permissions" when no escalation is needed.`
  )
}

/**
 * @param {string} key
 * @returns {string}
 */
function rejectMemoryReason(key) {
  return (
    `Denied earlier in this task for approval key "${key}": the same class of request is not asked ` +
    `again within this task. Use a different, narrower operation instead of retrying this one.`
  )
}

/**
 * @param {string} key
 * @param {boolean} consumedOnce
 * @returns {string}
 */
function approveMemoryReason(key, consumedOnce) {
  return consumedOnce
    ? `Approved for this single occurrence by a once-scope approval recorded in this task ` +
        `(key "${key}"); that once-scope grant is now consumed.`
    : `Approved earlier in this task for approval key "${key}" (task-scope memory).`
}

/**
 * @param {string} key
 * @param {string} match
 * @returns {string}
 */
function policyReason(key, match) {
  return `Allowed by the task-level authorization declared for this task (approval key "${key}"): ${match}.`
}

/**
 * @param {string} key
 * @returns {string}
 */
function humanReason(key) {
  return (
    `No rule decided for approval key "${key}": no cache gap, no tier violation, and neither ` +
    `approval memory nor task-level authorization matched. Escalating to the host human; if the ` +
    `human does not answer this defaults to reject-once.`
  )
}

/* ─────────────────────────── 纯工具函数 ─────────────────────────── */

/**
 * 档位在宽窄序中的序号；未知档位返回 `-1`。
 * @param {string} tier
 * @returns {number}
 */
function tierIndex(tier) {
  const index = TIER.indexOf(tier)
  return index >= 0 ? index : -1
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 名单转小写集合；未给出/为空时用默认名单。
 * @param {unknown} list
 * @param {Set<string>} fallback
 * @returns {Set<string>}
 */
function toNameSet(list, fallback) {
  if (!Array.isArray(list) || list.length === 0) return fallback
  /** @type {Set<string>} */
  const set = new Set()
  for (const entry of list) {
    if (typeof entry === 'string' && entry.trim() !== '') set.add(entry.trim().toLowerCase())
  }
  return set.size > 0 ? set : fallback
}

/**
 * 工具分类：`'write'` | `'command'` | `'other'`。
 * 工具名（忽略大小写）是权威；工具名缺失时才用参数形状兜底。
 * @param {string | undefined} toolName
 * @param {unknown} rawInput
 * @param {Set<string>} [writeTools]
 * @param {Set<string>} [commandTools]
 * @returns {'write' | 'command' | 'other'}
 */
function classifyTool(toolName, rawInput, writeTools = WRITE_TOOL_SET, commandTools = COMMAND_TOOL_SET) {
  const name = typeof toolName === 'string' ? toolName.trim().toLowerCase() : ''
  if (name !== '') {
    if (writeTools.has(name)) return 'write'
    if (commandTools.has(name)) return 'command'
    return 'other'
  }
  if (hasWriteShape(rawInput)) return 'write'
  if (firstToken(extractCommand(rawInput)) !== undefined) return 'command'
  return 'other'
}

/**
 * 是否写类操作。
 * @param {string | undefined} toolName
 * @param {unknown} rawInput
 * @param {Set<string>} writeTools
 * @returns {boolean}
 */
function isWriteOperation(toolName, rawInput, writeTools) {
  if (typeof toolName === 'string' && toolName.trim() !== '') {
    return writeTools.has(toolName.trim().toLowerCase())
  }
  return hasWriteShape(rawInput)
}

/**
 * 参数形状像不像写操作（仅在没有工具名时使用；宁可判宽）。
 * @param {unknown} rawInput
 * @returns {boolean}
 */
function hasWriteShape(rawInput) {
  if (!isPlainObject(rawInput)) return false
  return (
    'content' in rawInput ||
    'new_string' in rawInput ||
    'new_str' in rawInput ||
    'old_string' in rawInput ||
    'old_str' in rawInput ||
    'edits' in rawInput ||
    'patch' in rawInput
  )
}

/**
 * 取目标路径（契约字段：`file_path` 优先，其次 `path`）。
 * @param {unknown} rawInput
 * @returns {string | undefined}
 */
function extractPathValue(rawInput) {
  if (!isPlainObject(rawInput)) return undefined
  const value = rawInput.file_path !== undefined ? rawInput.file_path : rawInput.path
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 取命令字符串。
 * @param {unknown} rawInput
 * @returns {string | undefined}
 */
function extractCommand(rawInput) {
  if (!isPlainObject(rawInput)) return undefined
  const value = rawInput.command
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * 命令首词（第一个空白分隔 token）。
 * @param {string | undefined} command
 * @returns {string | undefined}
 */
function firstToken(command) {
  if (typeof command !== 'string') return undefined
  const match = /^\s*(\S+)/.exec(command)
  return match === null ? undefined : match[1]
}

/**
 * 父目录（保留原样分隔符；`a.txt` → `'.'`；`/a.txt` → `'/'`；`C:\` → `'C:\'`）。
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function parentDirectory(value) {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw === '') return undefined
  const trimmed = raw.length > 1 ? raw.replace(/[\\/]+$/, '') : raw
  if (/^[a-zA-Z]:$/.test(trimmed)) return `${trimmed}${raw.includes('\\') ? '\\' : '/'}`
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) return '.'
  if (index === 0) return trimmed.slice(0, 1)
  return trimmed.slice(0, index)
}

/**
 * 纯字符串路径规范化（不依赖 `node:path`，避免平台差异）。
 * @param {unknown} value
 * @returns {NormalizedPath | undefined} 无法解析时 `undefined`
 */
function normalizePath(value) {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw === '') return undefined
  const windows = /^[a-zA-Z]:[\\/]/.test(raw) || /^[\\/]{2}/.test(raw)
  const unified = raw.replace(/\\/g, '/')
  const unc = unified.startsWith('//')
  const startsSlash = unified.startsWith('/')
  /** @type {string[]} */
  const segments = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
      else segments.push('..')
      continue
    }
    segments.push(segment)
  }
  let path = segments.join('/')
  if (unc) path = `//${path}`
  else if (startsSlash) path = `/${path}`
  else if (path === '') path = '.'
  return {
    path,
    key: windows ? path.toLowerCase() : path,
    absolute: windows || startsSlash,
    windows,
  }
}

/**
 * 相对路径按 root 解析（纯字符串拼接后重新规范化）。
 * @param {NormalizedPath} root
 * @param {NormalizedPath} relative
 * @returns {NormalizedPath | undefined} root 不是绝对路径时 `undefined`
 */
function resolveRelative(root, relative) {
  if (!root.absolute) return undefined
  return normalizePath(`${root.path}/${relative.path}`)
}

/**
 * 把 `rawInput` 里的路径解析为可比较的绝对路径。
 * @param {unknown} value
 * @param {unknown} workspaceRoot
 * @returns {NormalizedPath | undefined} 无法解析成绝对路径时 `undefined`（调用方按「无法判断」处理）
 */
function resolveTargetPath(value, workspaceRoot) {
  const target = normalizePath(value)
  if (target === undefined) return undefined
  if (target.absolute) return target
  const root = normalizePath(workspaceRoot)
  if (root === undefined) return undefined
  return resolveRelative(root, target)
}

/**
 * target 是否位于 root 之内（含 root 自身）。任一侧是 Windows 风格时忽略大小写。
 * @param {NormalizedPath} root
 * @param {NormalizedPath} target
 * @returns {boolean}
 */
function isPathInside(root, target) {
  const caseInsensitive = root.windows || target.windows
  const a = caseInsensitive ? root.key.toLowerCase() : root.key
  const b = caseInsensitive ? target.key.toLowerCase() : target.key
  if (a === b) return true
  const prefix = a.endsWith('/') ? a : `${a}/`
  return b.startsWith(prefix)
}
