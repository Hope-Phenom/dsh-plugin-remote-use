/**
 * Browser half of dsh-plugin-remote-use.
 *
 * One Settings section (`settings.section`) that owns the plugin's operator surface: the
 * availability of every paired worker, a per-worker diagnostics panel (fresh self-check,
 * screenshot, link ping), the task list, and an emergency stop.
 *
 * Written as a plain module-loader factory: no build step, React comes from the browser
 * module table, and nothing from `@deepseek-ai/*` is required beyond the platform seeds.
 * This mirrors the shape of the sibling notification plugin, which is the working reference
 * for a third-party Settings page in this app.
 *
 * All state lives on the Host and is read through `/api/dsh/dsh-plugin-remote-use`, so the
 * page never duplicates plugin logic -- in particular it does not decide readiness itself,
 * it renders the worker's own report.
 *
 * DELIBERATELY ABSENT: a role selector. Switching this machine between master and worker
 * (symmetric pairing) is planned but is a different risk class from managing known workers,
 * so the page only STATES the current role instead of offering a dead control.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-use',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this page. */
    const NS = 'dsh-plugin-remote-use'
    /** Data route served by the Host half. */
    const ROUTE = '/api/dsh/dsh-plugin-remote-use'

    const zh = {
      nav: '远程工作节点',
      title: '远程工作节点',
      description: '把涉及 GUI 的自动化任务派给配对的工作节点执行，避免抢占本机的鼠标与键盘；可用状态、诊断与急停都在这里。',
      groupRole: '本机角色',
      roleMaster: '主机',
      roleNote: '本机作为主机向工作节点派单。切换为工作节点（对称配对）尚未实现。',
      groupWorkers: '工作节点',
      loading: '正在读取工作节点状态…',
      noWorkers: '尚未配置工作节点。请在 profile 补丁中配置后重启。',
      reportPending: '就绪报告未在限时内取得 —— 工作节点可能不可达。连接状态见下。',
      verdictReady: '就绪',
      verdictBlocked: '不可用',
      verdictUnknown: '未知',
      linkConnected: '已连接',
      linkDown: '未连接',
      labelCwd: '工作目录',
      labelSession: '交互会话',
      labelCounts: '检查结果',
      labelActive: '在途任务',
      labelLink: '连接',
      countsText: '阻断 {b} · 警告 {w} · 未检查 {u}',
      reconnects: '重连 {n} 次',
      approvals: '审批 {n} 次',
      heartbeatFailures: '心跳失败 {n} 次',
      generatedAt: '报告时间',
      cachedAge: '缓存 {n} 毫秒',
      btnSelfcheck: '重新自检',
      btnScreenshot: '截图',
      btnPing: '连接测试',
      btnAll: '全部重新自检',
      showChecks: '显示全部检查（{n}）',
      hideChecks: '收起检查',
      colId: '项',
      colName: '检查',
      colStatus: '结果',
      colActual: '实测',
      colFix: '修复方式',
      statusPass: '通过',
      statusFail: '失败',
      statusWarn: '警告',
      statusUnchecked: '未检查',
      statusSkip: '跳过',
      groupTasks: '任务',
      noTasks: '暂无任务记录。',
      colTask: '任务',
      colWorker: '工作节点',
      colState: '状态',
      colTools: '工具',
      colStarted: '开始',
      waiting: '等待审批',
      groupDanger: '急停',
      dangerNote: '打断所有工作节点上的在途任务。取消是协作式的，任务需到达停顿点后才结算为已中止。',
      btnStopAll: '全部急停',
      stopping: '正在停止…',
      stopped: '已请求取消 {n} 个任务',
      nothingToStop: '没有在途任务',
      loadFailed: '无法连接插件数据接口',
      retry: '重试',
      shotDone: '截图已保存：{p}',
      busy: '处理中…',
      screenshotHint: '截图保存在主机临时目录，可在会话中引用该路径。',
      // --- approvals ---
      groupApprovals: '等待你批准的请求',
      approvalsNone: '当前没有等待批准的请求。',
      approvalsUnavailable: '此构建没有审批队列，引擎无法自行裁定的请求会被直接拒绝。',
      approvalsNote: '审阅引擎无法自行裁定的请求会停在这里等待，而不是直接失败；超过下面的时限仍未处理则按拒绝处理 —— 所以"放行"永远是一个明确的动作。',
      approvalsBudget: '每个请求最多等待 {s} 秒',
      colTool: '工具',
      colTier: '所需档位',
      colWaited: '已等待',
      colArgs: '参数',
      btnAllow: '允许一次',
      btnDeny: '拒绝',
      approving: '正在提交…',
      approvalAllowed: '已允许一次',
      approvalDenied: '已拒绝',
      groupAudit: '最近的裁定',
      auditNone: '尚无裁定记录。',
      auditNote: '追加写入，位置：{p}',
      auditByEngine: '引擎',
      auditByHuman: '你',
      auditByTimeout: '超时未处理',
      auditByNoAnswerer: '无人可问',
      auditByDisposed: '插件已卸载',
      // --- pairing ---
      btnAdd: '添加工作节点',
      btnEdit: '编辑',
      btnDelete: '删除',
      btnSave: '保存',
      btnCancel: '取消',
      btnRecheck: '重新自检',
      confirmDelete: '删除工作节点 {id}？该操作会立即断开连接并写入设置文件。',
      formAddTitle: '添加工作节点',
      formEditTitle: '编辑工作节点 {id}',
      fieldId: '标识（id）',
      fieldIdHint: '插件内部使用，也是 profile 补丁里的键；保存后不建议再改。',
      fieldName: '显示名称',
      fieldUrl: '中继地址',
      fieldUrlHint: '从机中继的 WebSocket 地址，例如 ws://192.168.1.101:7331。',
      fieldToken: '访问令牌',
      fieldTokenHint: '留空表示保持原令牌不变。令牌只写入主机，不会回传到本页面。',
      fieldTokenNew: '访问令牌（必填）',
      fieldCwd: '工作目录',
      fieldCwdHint: '从机上的绝对路径；同时也是从机沙箱允许写入的范围。',
      fieldEnabled: '启用',
      fieldSerial: '并发任务数',
      fieldSerialHint: 'GUI 是独占资源，通常保持 1。',
      tokenStored: '已保存（{hint}）',
      tokenMissing: '未设置',
      savedApplied: '已保存并生效：新增 {a} · 移除 {r} · 重建 {c}',
      savedRebuilt: '已保存。审批策略变更，所有工作节点已重建。',
      savedNoChange: '已保存，无需变更。',
      groupAdvanced: '审批与连接',
      fieldTier: '默认档位',
      fieldTierHint: '从机申请宽于该档位时，主机的审阅引擎会拒绝。',
      fieldApprovalTimeout: '审批超时（毫秒）',
      fieldApprovalTimeoutHint: '超时按拒绝处理。',
      fieldHeartbeat: '心跳间隔（毫秒）',
      fieldHeartbeatHint: '0 表示关闭。用于在两次调用之间发现静默断链。',
      fieldReportBudget: '页面探测预算（毫秒）',
      fieldReportBudgetHint: '页面加载时等待就绪报告的上限；超时则只显示连接状态。',
      groupSource: '配置来源',
      sourceText: '工作节点由本页管理并写入 {file}；该文件存在时，profile 补丁中的同名配置不再生效。',
    }

    const en = {
      nav: 'Remote workers',
      title: 'Remote workers',
      description: 'Send GUI automation to paired workers instead of taking over this machine\u2019s mouse and keyboard. Availability, diagnostics and the emergency stop live here.',
      groupRole: 'This machine\u2019s role',
      roleMaster: 'Master',
      roleNote: 'This machine dispatches to workers. Switching it into worker mode (symmetric pairing) is not implemented yet.',
      groupWorkers: 'Workers',
      loading: 'Reading worker state\u2026',
      noWorkers: 'No workers configured. Add one to the profile patch and restart.',
      reportPending: 'The readiness report did not arrive in time \u2014 the worker is probably unreachable. Link state below.',
      verdictReady: 'ready',
      verdictBlocked: 'unavailable',
      verdictUnknown: 'unknown',
      linkConnected: 'connected',
      linkDown: 'disconnected',
      labelCwd: 'Working directory',
      labelSession: 'Interactive session',
      labelCounts: 'Checks',
      labelActive: 'Active tasks',
      labelLink: 'Link',
      countsText: 'blocking {b} \u00b7 warning {w} \u00b7 unchecked {u}',
      reconnects: '{n} reconnects',
      approvals: '{n} approvals',
      heartbeatFailures: '{n} heartbeat failures',
      generatedAt: 'Reported at',
      cachedAge: 'cached {n} ms',
      btnSelfcheck: 'Re-check now',
      btnScreenshot: 'Screenshot',
      btnPing: 'Test link',
      btnAll: 'Re-check all',
      showChecks: 'Show all checks ({n})',
      hideChecks: 'Hide checks',
      colId: 'ID',
      colName: 'Check',
      colStatus: 'Result',
      colActual: 'Observed',
      colFix: 'How to fix',
      statusPass: 'pass',
      statusFail: 'fail',
      statusWarn: 'warn',
      statusUnchecked: 'unchecked',
      statusSkip: 'skipped',
      groupTasks: 'Tasks',
      noTasks: 'No tasks recorded yet.',
      colTask: 'Task',
      colWorker: 'Worker',
      colState: 'State',
      colTools: 'Tools',
      colStarted: 'Started',
      waiting: 'waiting for approval',
      groupDanger: 'Emergency stop',
      dangerNote: 'Stops every in-flight task on every worker. Cancellation is cooperative: a task settles as aborted only once the worker reaches a quiescent point.',
      btnStopAll: 'Stop all',
      stopping: 'Stopping\u2026',
      stopped: 'Cancellation requested for {n} task(s)',
      nothingToStop: 'Nothing to stop',
      loadFailed: 'Cannot reach the plugin data route',
      retry: 'Retry',
      shotDone: 'Screenshot saved: {p}',
      busy: 'Working\u2026',
      screenshotHint: 'Screenshots land in the host temp directory; reference that path from the session.',
      // --- approvals ---
      groupApprovals: 'Approvals waiting on you',
      approvalsNone: 'Nothing is waiting for approval.',
      approvalsUnavailable: 'This build has no approval queue, so a request the engine cannot justify is refused outright.',
      approvalsNote: 'The review engine refuses anything it cannot justify on its own. Those requests wait here instead of failing, until the budget expires \u2014 and expiry is a refusal, so allowing one is always an explicit act.',
      approvalsBudget: 'Each waits up to {s}s',
      colTool: 'Tool',
      colTier: 'Required',
      colWaited: 'Waited',
      colArgs: 'Arguments',
      btnAllow: 'Allow once',
      btnDeny: 'Refuse',
      approving: 'Sending\u2026',
      approvalAllowed: 'Allowed once',
      approvalDenied: 'Refused',
      groupAudit: 'Recent decisions',
      auditNone: 'No decisions recorded yet.',
      auditNote: 'Append-only, at {p}',
      auditByEngine: 'engine',
      auditByHuman: 'you',
      auditByTimeout: 'expired unanswered',
      auditByNoAnswerer: 'nobody to ask',
      auditByDisposed: 'plugin unloaded',
      // --- pairing ---
      btnAdd: 'Add worker',
      btnEdit: 'Edit',
      btnDelete: 'Delete',
      btnSave: 'Save',
      btnCancel: 'Cancel',
      btnRecheck: 'Re-check',
      confirmDelete: 'Delete worker {id}? This disconnects it immediately and writes the settings file.',
      formAddTitle: 'Add a worker',
      formEditTitle: 'Edit worker {id}',
      fieldId: 'Identifier (id)',
      fieldIdHint: 'Used internally and as the profile-patch key; best left alone once saved.',
      fieldName: 'Display name',
      fieldUrl: 'Relay address',
      fieldUrlHint: 'The worker relay\u2019s WebSocket address, e.g. ws://192.168.1.101:7331.',
      fieldToken: 'Access token',
      fieldTokenHint: 'Leave blank to keep the stored token. It is written on the host only and never returned to this page.',
      fieldTokenNew: 'Access token (required)',
      fieldCwd: 'Working directory',
      fieldCwdHint: 'Absolute path on the worker; also the scope its sandbox allows writes to.',
      fieldEnabled: 'Enabled',
      fieldSerial: 'Concurrent tasks',
      fieldSerialHint: 'The GUI is an exclusive resource on a worker; usually 1.',
      tokenStored: 'stored ({hint})',
      tokenMissing: 'not set',
      savedApplied: 'Saved and applied: {a} added \u00b7 {r} removed \u00b7 {c} rebuilt',
      savedRebuilt: 'Saved. The approval policy changed, so every worker was rebuilt.',
      savedNoChange: 'Saved; nothing needed to change.',
      groupAdvanced: 'Approval and connection',
      fieldTier: 'Default tier',
      fieldTierHint: 'A worker asking for more than this is refused by the host\u2019s review engine.',
      fieldApprovalTimeout: 'Approval timeout (ms)',
      fieldApprovalTimeoutHint: 'A timeout counts as a refusal.',
      fieldHeartbeat: 'Heartbeat interval (ms)',
      fieldHeartbeatHint: '0 disables it. Detects a silently dead link between calls.',
      fieldReportBudget: 'Page probe budget (ms)',
      fieldReportBudgetHint: 'How long a page load waits for a readiness report before showing link state alone.',
      groupSource: 'Configuration source',
      sourceText: 'Workers are managed here and written to {file}. Once that file exists, same-named keys in the profile patch no longer apply.',
    }

    const CSS = [
      '.ru-page{display:flex;flex-direction:column;gap:22px;max-width:760px;font-size:13px;line-height:1.5}',
      '.ru-head{display:flex;flex-direction:column;gap:4px}',
      '.ru-head-row{display:flex;align-items:center;gap:9px}',
      // `currentColor` so the mark follows the theme and the section's active state.
      '.ru-mark{color:var(--dsw-alias-brand-primary);flex:none}',
      '.ru-title{margin:0;font-size:16px;font-weight:500;line-height:1.4}',
      '.ru-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.ru-group{display:flex;flex-direction:column;border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:14px}',
      '.ru-group-title{margin:0 0 8px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.ru-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.ru-note.warn{color:var(--dsw-alias-state-error-primary)}',
      '.ru-note.dim{font-size:11px}',
      '.ru-dim{color:var(--dsw-alias-label-tertiary)}',
      // A pending approval is the one thing on this page that is BLOCKING a worker, so it is
      // outlined in the business colour rather than reading as another informational card.
      '.ru-approvals{display:flex;flex-direction:column;gap:10px}',
      '.ru-approval{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border:0.5px solid var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-sm)}',
      '.ru-approval-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}',
      '.ru-approval-why{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.ru-approval-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ru-args{margin:0;padding:6px 8px;max-height:96px;overflow:auto;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}',
      '.ru-role{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ru-card{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.ru-card + .ru-card{margin-top:10px}',
      '.ru-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ru-name{font-weight:500;font-size:13px}',
      '.ru-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:0.5px solid transparent;white-space:nowrap}',
      '.ru-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.ru-badge.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.ru-badge.warn{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.ru-badge.mute{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2)}',
      '.ru-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12px}',
      '.ru-k{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.ru-v{color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.ru-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.ru-btn{font:inherit;font-size:12px;padding:4px 11px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.ru-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.ru-btn:disabled{opacity:.5;cursor:default}',
      '.ru-btn.primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}',
      '.ru-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.ru-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}',
      '.ru-msg{font-size:12px;padding:6px 9px;border-radius:var(--dsw-radius-sm)}',
      '.ru-msg.err{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.ru-msg.ok{color:var(--dsw-alias-state-success-primary)}',
      '.ru-msg.mute{color:var(--dsw-alias-label-tertiary)}',
      '.ru-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.ru-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:4px 8px 4px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}',
      '.ru-table td{padding:5px 8px 5px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);vertical-align:top}',
      '.ru-table td.mono{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary)}',
      '.ru-mono{font-family:ui-monospace,Consolas,monospace}',
      '.ru-scroll{overflow-x:auto}',
      '.ru-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}',
      '.ru-dot.pass{background:var(--dsw-alias-state-success-primary)}',
      '.ru-dot.fail{background:var(--dsw-alias-state-error-primary)}',
      '.ru-dot.warning,.ru-dot.warn{background:var(--dsw-alias-state-business-primary)}',
      '.ru-dot.unchecked,.ru-dot.skip,.ru-dot.unknown{background:var(--dsw-alias-label-tertiary)}',
      '.ru-form{gap:2px}',
      '.ru-field{display:flex;flex-direction:column;gap:4px;padding:8px 0}',
      '.ru-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ru-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
      '.ru-inline{flex-direction:row;align-items:center;gap:7px}',
      '.ru-input{font:inherit;font-size:12px;padding:5px 8px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);width:100%}',
      '.ru-input:disabled{opacity:.6}',
      '.ru-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}',
      '.ru-source{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.6;word-break:break-all}',
    ].join('')

    /** Fill `{name}` placeholders. Kept local so the page does not depend on a t() option API. */
    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
      ))
    }

    /**
     * An audit row's timestamp as local wall-clock time, seconds precision.
     *
     * The trail is the only place the page shows absolute time, and an ISO string with
     * milliseconds is unreadable when the question is "did I approve that, and when".
     * An unparsable value is shown verbatim rather than as "Invalid Date".
     */
    function formatTime(value) {
      const date = new Date(String(value ?? ''))
      if (Number.isNaN(date.getTime())) return String(value ?? '')
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /**
     * The verdict drives every colour on the page, so map it once rather than testing the
     * string at each use site.
     */
    function verdictClass(verdict) {
      if (verdict === 'ready') return 'ok'
      if (verdict === 'blocked' || verdict === 'unavailable') return 'bad'
      return 'mute'
    }

    /** A check row's status as a CSS class; DSH reports `warn`, the stylesheet also allows `warning`. */
    function checkClass(status) {
      if (status === 'pass') return 'pass'
      if (status === 'fail') return 'fail'
      if (status === 'warn' || status === 'warning') return 'warning'
      return 'unchecked'
    }

    const TERMINAL_STATES = ['completed', 'error', 'aborted', 'cancelled']

    function WorkerCard(props) {
      const { t, row, busy, onAction, onEdit, onDelete } = props
      const [showChecks, setShowChecks] = React.useState(false)
      const report = row.report
      const conn = row.connection
      const verdict = report === null || report === undefined ? 'unknown' : String(report.verdict ?? 'unknown')
      const checks = Array.isArray(report?.checks) ? report.checks : []
      // Failures are why the operator opened this page, so surface them without a click.
      const interesting = checks.filter((c) => c.status !== 'pass')
      const listed = showChecks ? checks : interesting

      const linkText = conn?.connected === true ? t('linkConnected') : t('linkDown')
      const linkBits = []
      if (typeof conn?.connects === 'number' && conn.connects > 0) linkBits.push(fmt(t('reconnects'), { n: conn.connects }))
      if (typeof conn?.bridge?.approvals === 'number' && conn.bridge.approvals > 0) linkBits.push(fmt(t('approvals'), { n: conn.bridge.approvals }))
      if (typeof conn?.heartbeatFailures === 'number' && conn.heartbeatFailures > 0) linkBits.push(fmt(t('heartbeatFailures'), { n: conn.heartbeatFailures }))

      const kv = []
      kv.push(h('span', { key: 'k-cwd', className: 'ru-k' }, t('labelCwd')))
      kv.push(h('span', { key: 'v-cwd', className: 'ru-v ru-mono' }, String(row.cwd ?? '')))
      kv.push(h('span', { key: 'k-session', className: 'ru-k' }, t('labelSession')))
      kv.push(h('span', { key: 'v-session', className: 'ru-v' },
        report === null || report === undefined
          ? '\u2014'
          : `${String(report.worker ?? '')} \u00b7 ${String(report.sessionSegment ?? 'unknown')}`))
      kv.push(h('span', { key: 'k-link', className: 'ru-k' }, t('labelLink')))
      kv.push(h('span', { key: 'v-link', className: 'ru-v' },
        linkBits.length === 0 ? linkText : `${linkText} \u00b7 ${linkBits.join(' \u00b7 ')}`))
      kv.push(h('span', { key: 'k-counts', className: 'ru-k' }, t('labelCounts')))
      kv.push(h('span', { key: 'v-counts', className: 'ru-v' },
        report === null || report === undefined
          ? '\u2014'
          : fmt(t('countsText'), {
            b: report.blockingFailures ?? 0,
            w: report.warnings ?? 0,
            u: report.unchecked ?? 0,
          })))
      kv.push(h('span', { key: 'k-active', className: 'ru-k' }, t('labelActive')))
      kv.push(h('span', { key: 'v-active', className: 'ru-v' }, String(row.activeTasks ?? 0)))

      const head = [
        h('span', { key: 'name', className: 'ru-name' }, String(row.name ?? row.peerId ?? '')),
        h('span', { key: 'id', className: 'ru-badge mute ru-mono' }, String(row.peerId ?? '')),
        h('span', { key: 'verdict', className: `ru-badge ${verdictClass(verdict)}` },
          verdict === 'ready' ? t('verdictReady') : verdict === 'unknown' ? t('verdictUnknown') : t('verdictBlocked')),
      ]
      if (report?.cachedAgeMs !== undefined && report?.cachedAgeMs !== null) {
        head.push(h('span', { key: 'age', className: 'ru-note' }, fmt(t('cachedAge'), { n: report.cachedAgeMs })))
      }

      const actions = h('div', { className: 'ru-actions' },
        h('button', {
          type: 'button', className: 'ru-btn', disabled: busy !== '',
          onClick: () => onAction('selfcheck', row.peerId),
        }, busy === 'selfcheck' ? t('busy') : t('btnSelfcheck')),
        h('button', {
          type: 'button', className: 'ru-btn', disabled: busy !== '',
          onClick: () => onAction('screenshot', row.peerId),
        }, busy === 'screenshot' ? t('busy') : t('btnScreenshot')),
        h('button', {
          type: 'button', className: 'ru-btn', disabled: busy !== '',
          onClick: () => onAction('ping', row.peerId),
        }, busy === 'ping' ? t('busy') : t('btnPing')),
        h('button', {
          type: 'button', className: 'ru-btn', disabled: busy !== '',
          onClick: () => onEdit(row),
        }, t('btnEdit')),
        h('button', {
          type: 'button', className: 'ru-btn danger', disabled: busy !== '',
          onClick: () => onDelete(row),
        }, t('btnDelete')),
        h('span', { key: 'hint', className: 'ru-note' }, t('screenshotHint')),
      )

      return h('div', { className: 'ru-card' },
        h('div', { className: 'ru-card-head' }, head),
        h('div', { className: 'ru-kv' }, kv),
        // A missing report is stated as its own fact. The previous revision let it fall
        // through to a generic empty state, which reads as "nothing here" rather than
        // "the probe did not complete".
        report === null || report === undefined
          ? h('div', { className: 'ru-msg mute' }, t('reportPending'))
          : null,
        row.error !== undefined && row.error !== '' ? h('div', { className: 'ru-msg err' }, String(row.error)) : null,
        actions,
        checks.length === 0 ? null : h('div', {},
          h('button', {
            type: 'button', className: 'ru-btn',
            onClick: () => setShowChecks((v) => !v),
          }, showChecks ? t('hideChecks') : fmt(t('showChecks'), { n: checks.length })),
        ),
        listed.length === 0 ? null : h('div', { className: 'ru-scroll' },
          h('table', { className: 'ru-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('colId')),
              h('th', null, t('colName')),
              h('th', null, t('colStatus')),
              h('th', null, t('colActual')),
              h('th', null, t('colFix')))),
            h('tbody', null, listed.map((c) => h('tr', { key: String(c.id) },
              h('td', { className: 'mono' }, String(c.id)),
              h('td', null, String(c.name ?? '')),
              h('td', null,
                h('span', { className: `ru-dot ${checkClass(String(c.status))}` }),
                String(c.status ?? '')),
              h('td', { className: 'mono' }, String(c.actual ?? '')),
              h('td', null, String(c.fix ?? ''))))))),
      )
    }

    /**
     * Add/edit form for one worker.
     *
     * The token field starts EMPTY even when one is stored: the host never sends a token to
     * the browser, so the field can only mean "replace it". Blank therefore reads as "keep
     * the stored one", which is what makes renaming a worker possible without re-entering a
     * credential the operator may not have to hand.
     */
    function WorkerForm(props) {
      const { t, draft, onSave, onCancel, busy, isNew } = props
      const [form, setForm] = React.useState({
        id: draft.id ?? '',
        name: draft.name ?? '',
        url: draft.url ?? '',
        token: '',
        cwd: draft.cwd ?? '',
        enabled: draft.enabled !== false,
        serialQueue: draft.serialQueue ?? 1,
      })
      const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }))

      const idOk = form.id.trim() !== ''
      const urlOk = form.url.trim() !== ''
      // A new worker with no token would be created and then fail at dispatch; refuse here.
      const tokenOk = !isNew || form.token.trim() !== ''
      const valid = idOk && urlOk && tokenOk

      const field = (key, labelKey, hintKey, opts = {}) => h('label', { className: 'ru-field' },
        h('span', { className: 'ru-field-label' }, t(labelKey)),
        h('input', {
          className: 'ru-input',
          type: opts.type ?? 'text',
          value: form[key],
          // The id is the identity the rest of the plugin keys on, so it is fixed after
          // creation rather than silently renaming an existing worker.
          disabled: opts.disabled === true,
          placeholder: opts.placeholder ?? '',
          onChange: set(key),
        }),
        hintKey === undefined ? null : h('span', { className: 'ru-field-hint' }, t(hintKey)))

      const tokenHint = draft.tokenSet === true
        ? `${t('fieldTokenHint')} \u2014 ${fmt(t('tokenStored'), { hint: draft.tokenHint ?? '' })}`
        : `${t('fieldTokenHint')} \u2014 ${t('tokenMissing')}`

      return h('div', { className: 'ru-card ru-form' },
        h('div', { className: 'ru-card-head' },
          h('span', { className: 'ru-name' }, isNew ? t('formAddTitle') : fmt(t('formEditTitle'), { id: draft.id ?? '' }))),

        field('id', 'fieldId', 'fieldIdHint', { disabled: !isNew }),
        field('name', 'fieldName'),
        field('url', 'fieldUrl', 'fieldUrlHint'),
        h('label', { className: 'ru-field' },
          h('span', { className: 'ru-field-label' }, isNew ? t('fieldTokenNew') : t('fieldToken')),
          h('input', { className: 'ru-input', type: 'password', value: form.token, autocomplete: 'new-password', onChange: set('token') }),
          h('span', { className: 'ru-field-hint' }, tokenHint)),
        field('cwd', 'fieldCwd', 'fieldCwdHint'),

        h('label', { className: 'ru-field ru-inline' },
          h('input', { type: 'checkbox', checked: form.enabled, onChange: (e) => setForm((f) => ({ ...f, enabled: e.target.checked })) }),
          h('span', null, t('fieldEnabled'))),
        h('label', { className: 'ru-field' },
          h('span', { className: 'ru-field-label' }, t('fieldSerial')),
          h('input', { className: 'ru-input', type: 'number', min: '1', value: form.serialQueue, onChange: set('serialQueue') }),
          h('span', { className: 'ru-field-hint' }, t('fieldSerialHint'))),

        h('div', { className: 'ru-actions' },
          h('button', {
            type: 'button', className: 'ru-btn primary', disabled: !valid || busy !== '',
            onClick: () => onSave({
              id: form.id.trim(),
              name: form.name.trim() === '' ? form.id.trim() : form.name.trim(),
              url: form.url.trim(),
              cwd: form.cwd.trim(),
              enabled: form.enabled,
              serialQueue: Number(form.serialQueue) || 1,
              // Omit entirely when blank so the host keeps the stored token.
              ...(form.token === '' ? {} : { token: form.token }),
            }),
          }, busy === 'save' ? t('busy') : t('btnSave')),
          h('button', { type: 'button', className: 'ru-btn', disabled: busy !== '', onClick: onCancel }, t('btnCancel'))),
      )
    }

    /**
     * Approval policy and connection tuning: the settings that apply to every worker.
     *
     * Changing the tier or the timeout rebuilds every worker on the Host, because a running
     * approval decider captured the old policy. That is deliberate -- a decision remembered
     * under one policy must not carry into another.
     */
    function AdvancedSettings(props) {
      const { t, settings, busy, onSave } = props
      const [form, setForm] = React.useState({
        requiredTier: settings.requiredTier ?? 'workspace-write',
        approvalTimeoutMs: settings.approvalTimeoutMs ?? 90000,
        heartbeatMs: settings.heartbeatMs ?? 15000,
      })
      const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }))
      const number = (key, labelKey, hintKey, min) => h('label', { className: 'ru-field' },
        h('span', { className: 'ru-field-label' }, t(labelKey)),
        h('input', { className: 'ru-input', type: 'number', min: String(min), value: form[key], onChange: set(key) }),
        h('span', { className: 'ru-field-hint' }, t(hintKey)))

      return h('div', { className: 'ru-group' },
        h('h3', { className: 'ru-group-title' }, t('groupAdvanced')),
        h('label', { className: 'ru-field' },
          h('span', { className: 'ru-field-label' }, t('fieldTier')),
          h('select', { className: 'ru-input', value: form.requiredTier, onChange: set('requiredTier') },
            // Only the tiers the review engine actually understands.
            ...[['read-only', 'read-only'], ['workspace-write', 'workspace-write'], ['danger-full-access', 'danger-full-access']]
              .map(([value, label]) => h('option', { key: value, value }, label))),
          h('span', { className: 'ru-field-hint' }, t('fieldTierHint'))),
        number('approvalTimeoutMs', 'fieldApprovalTimeout', 'fieldApprovalTimeoutHint', 1000),
        number('heartbeatMs', 'fieldHeartbeat', 'fieldHeartbeatHint', 0),
        h('div', { className: 'ru-actions', style: { marginTop: '8px' } },
          h('button', {
            type: 'button', className: 'ru-btn', disabled: busy !== '',
            onClick: () => onSave({
              requiredTier: form.requiredTier,
              approvalTimeoutMs: Number(form.approvalTimeoutMs) || 90000,
              heartbeatMs: Number(form.heartbeatMs) || 0,
            }),
          }, busy === 'policy' ? t('busy') : t('btnSave'))),
      )
    }

    /**
     * The plugin's mark, inline.
     *
     * WHY IT IS INLINED RATHER THAN READ FROM `assets/icon.svg`: this page is a browser
     * module with no build step and no access to the package's files, and the entity has to
     * be self-contained anyway. When the manifest icon changes, this must change with it --
     * `test/settings-page.test.js` asserts the two stay in step.
     *
     * WHY IT IS HERE AT ALL: the Settings NAV icon is not plugin-supplied. DSH's
     * `navIcon(id)` in dsh-client-ui-settings-general is a hardcoded id -> built-in icon map
     * with a gear fallback, and a `settings.section` row carries only {id, order, label}.
     * So a third-party plugin cannot change its nav glyph; the page header is where its own
     * mark can actually appear.
     */
    function RemoteUseIcon(props) {
      const size = props?.size ?? 20
      const title = props?.title ?? 'Remote workers'
      return h('svg', {
        className: 'ru-mark', width: size, height: size, viewBox: '0 0 64 64',
        role: 'img', 'aria-label': title, focusable: 'false',
      },
      h('g', {
        fill: 'none', stroke: 'currentColor', strokeWidth: 4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('path', { d: 'M42 30H54V10H28V22' }),
      h('path', { d: 'M48 30v5' }),
      h('path', { d: 'M43 35h10' }),
      h('path', { d: 'M10 22h32v24H10Z' }),
      h('path', { d: 'M26 46v6' }),
      h('path', { d: 'M18 52h16' })))
    }

    function RemoteUseSection(props) {
      const { t } = props
      const [snapshot, setSnapshot] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [status, setStatus] = React.useState({ kind: 'idle', text: '' })
      /** null = no form; `{ draft, isNew }` = the add/edit form is open. */
      const [editing, setEditing] = React.useState(null)

      const call = React.useCallback(async (action, payload) => {
        const response = await fetch(ROUTE, {
          method: action === 'get' ? 'GET' : 'POST',
          credentials: 'same-origin',
          headers: action === 'get' ? undefined : { 'content-type': 'application/json' },
          body: action === 'get' ? undefined : JSON.stringify({ action, ...(payload ?? {}) }),
        })
        const data = await response.json().catch(() => null)
        if (data === null) throw new Error(`HTTP ${response.status}`)
        if (data.ok !== true) throw new Error(typeof data.error === 'string' && data.error !== '' ? data.error : `HTTP ${response.status}`)
        return data
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          const data = await call('get')
          setSnapshot(data)
          setLoadError('')
          return data
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
          return null
        }
      }, [call])

      React.useEffect(() => { void refresh() }, [refresh])

      /** Describe what a save actually did, so "nothing seemed to happen" is impossible. */
      const describeApply = React.useCallback((applied, settings) => {
        const a = Array.isArray(applied?.added) ? applied.added.length : 0
        const r = Array.isArray(applied?.removed) ? applied.removed.length : 0
        const c = Array.isArray(applied?.changed) ? applied.changed.length : 0
        if (applied?.rebuilt === true) return t('savedRebuilt')
        if (a === 0 && r === 0 && c === 0) return t('savedNoChange')
        return fmt(t('savedApplied'), { a, r, c })
      }, [t])

      const saveWorker = React.useCallback(async (draft) => {
        setBusy('save')
        setStatus({ kind: 'idle', text: '' })
        try {
          const data = await call('worker.save', { worker: draft })
          setEditing(null)
          setStatus({ kind: 'ok', text: describeApply(data.applied, data.settings) })
          await refresh()
        } catch (error) {
          setStatus({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }, [call, refresh, describeApply])

      const deleteWorker = React.useCallback(async (row) => {
        // Deleting a worker is a live disconnect, so ask once with the id in the prompt.
        const ok = typeof window === 'undefined' || typeof window.confirm !== 'function'
          ? true
          : window.confirm(fmt(t('confirmDelete'), { id: row.peerId }))
        if (!ok) return
        setBusy('delete')
        setStatus({ kind: 'idle', text: '' })
        try {
          const data = await call('worker.remove', { peerId: row.peerId })
          setEditing(null)
          setStatus({ kind: 'ok', text: describeApply(data.applied, data.settings) })
          await refresh()
        } catch (error) {
          setStatus({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }, [call, refresh, describeApply, t])

      const savePolicy = React.useCallback(async (next) => {
        setBusy('policy')
        setStatus({ kind: 'idle', text: '' })
        try {
          const data = await call('settings.save', { settings: next })
          setStatus({ kind: 'ok', text: describeApply(data.applied, data.settings) })
          await refresh()
        } catch (error) {
          setStatus({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }, [call, refresh, describeApply])

      const onDecide = React.useCallback(async (id, decision) => {
        setBusy(`approval:${id}`)
        setStatus({ kind: 'idle', text: '' })
        try {
          const data = await call('approvals.decide', { id, decision })
          setStatus({
            kind: 'ok',
            text: data.optionId === 'allow-once' ? t('approvalAllowed') : t('approvalDenied'),
          })
          // Re-read: the request may have expired between render and click, and the audit
          // trail gained a row either way.
          await refresh()
        } catch (error) {
          // A 409 here means the row was stale -- say so rather than looking like a crash.
          setStatus({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
          await refresh()
        } finally {
          setBusy('')
        }
      }, [call, refresh, t])

      /** Turn a `by` value from the audit trail into words. */
      const describeBy = React.useCallback((by) => {
        if (by === 'engine') return t('auditByEngine')
        if (by === 'human') return t('auditByHuman')
        if (by === 'timeout') return t('auditByTimeout')
        if (by === 'no-answerer') return t('auditByNoAnswerer')
        if (by === 'disposed') return t('auditByDisposed')
        return String(by ?? '')
      }, [t])

      const onAction = React.useCallback(async (action, peerId) => {
        setBusy(action)
        setStatus({ kind: 'idle', text: '' })
        try {
          const data = await call(action, peerId === undefined ? {} : { peerId })
          if (action === 'screenshot') {
            setStatus({ kind: 'ok', text: fmt(t('shotDone'), { p: String(data.screenshot?.localPath ?? '') }) })
          } else if (action === 'ping') {
            setStatus({ kind: data.connected ? 'ok' : 'err', text: `${peerId}: ${data.connected ? t('linkConnected') : t('linkDown')}` })
          }
          // Re-read rather than patching locally: the worker is the source of truth for
          // readiness, and a fresh self-check changes many fields at once.
          await refresh()
        } catch (error) {
          setStatus({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }, [call, refresh, t])

      const onStopAll = React.useCallback(async () => {        setBusy('stop')
        setStatus({ kind: 'idle', text: '' })
        try {
          const data = await call('interrupt', {})
          const n = Array.isArray(data.cancelled) ? data.cancelled.length : 0
          const failed = Array.isArray(data.failures) ? data.failures : []
          if (n === 0 && failed.length === 0) setStatus({ kind: 'mute', text: t('nothingToStop') })
          else if (failed.length > 0) setStatus({ kind: 'err', text: `${fmt(t('stopped'), { n })}; ${failed.length} failed` })
          else setStatus({ kind: 'ok', text: fmt(t('stopped'), { n }) })
          await refresh()
        } catch (error) {
          setStatus({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }, [call, refresh, t])

      const workers = Array.isArray(snapshot?.workers) ? snapshot.workers : []
      const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
      const anyBusy = busy !== ''

      // The route returns TWO arrays and they are NOT interchangeable:
      //   workers[]           the live snapshot -- peerId, name, cwd, report, connection
      //   settings.workers[]  the saved config  -- id, name, url, cwd, enabled, serialQueue,
      //                                            tokenSet, tokenHint
      // The card renders the snapshot, because only it carries the readiness report. The FORM
      // must be seeded from the configuration. Seeding it from the snapshot left id, url and
      // the token state undefined, so Edit opened an EMPTY form for a worker that was
      // demonstrably connected and ready.
      const configWorkers = Array.isArray(snapshot?.settings?.workers) ? snapshot.settings.workers : []
      const configFor = (peerId) => configWorkers.find((w) => w.id === peerId)

      // Approvals waiting on the operator, and the trail of what was decided. `available` is
      // distinct from an empty list on purpose: "nothing is waiting" and "this build cannot
      // ask" are different facts and the page must not conflate them.
      const approvals = snapshot?.approvals ?? { available: false, pending: [], recent: [], timeoutMs: 0 }
      const pending = Array.isArray(approvals.pending) ? approvals.pending : []
      const audit = snapshot?.audit ?? { available: false, path: '', error: '', recent: [] }
      const recentAudit = Array.isArray(audit.recent) ? audit.recent : []

      return h('div', { className: 'ru-page' },
        h('style', null, CSS),
        h('div', { className: 'ru-head' },
          h('div', { className: 'ru-head-row' },
            h(RemoteUseIcon, { size: 22 }),
            h('h2', { className: 'ru-title' }, t('title'))),
          h('p', { className: 'ru-desc' }, t('description'))),

        loadError === '' ? null : h('div', { className: 'ru-msg err' },
          `${t('loadFailed')}: ${loadError} `,
          h('button', { type: 'button', className: 'ru-btn', onClick: () => void refresh() }, t('retry'))),

        h('div', { className: 'ru-group' },
          h('h3', { className: 'ru-group-title' }, t('groupRole')),
          h('div', { className: 'ru-role' },
            h('span', { className: 'ru-badge ok' }, t('roleMaster')),
            h('span', { className: 'ru-note' }, t('roleNote')))),

        h('div', { className: 'ru-group' },
          h('h3', { className: 'ru-group-title' }, t('groupWorkers')),
          // Three distinct states, because conflating them is how a page tells the operator
          // "nothing is configured" while a slow request is still in flight. The first load
          // can legitimately take seconds: the Host attempts a readiness probe, and an
          // unreachable worker costs a full TCP connect timeout.
          snapshot === null
            ? h('p', { className: 'ru-note' }, t('loading'))
            : workers.length === 0
              ? h('p', { className: 'ru-note' }, t('noWorkers'))
              : h('div', {}, workers.map((row) => h(WorkerCard, {
                key: String(row.peerId),
                t,
                row,
                busy: busy === 'stop' ? 'stop' : (busy !== '' && busy !== 'stop' ? busy : ''),
                onAction: (action, peerId) => void onAction(action, peerId),
                onEdit: (r) => setEditing({
                  // Seed from the CONFIGURATION. The snapshot row it was seeded from before
                  // has no `id`, `url` or token state, so the form came up blank.
                  draft: configFor(r.peerId) ?? {
                    id: r.peerId, name: r.name, url: '', cwd: r.cwd, enabled: true, serialQueue: 1,
                  },
                  isNew: false,
                }),
                onDelete: (r) => void deleteWorker(r),
              }))),

          // The add/edit form sits with the list it edits, so there is no second place to
          // look and no modal state to lose.
          editing === null ? null : h(WorkerForm, {
            t,
            draft: editing.draft,
            isNew: editing.isNew,
            busy,
            onSave: (draft) => void saveWorker(draft),
            onCancel: () => setEditing(null),
          }),

          snapshot === null ? null : h('div', { className: 'ru-actions', style: { marginTop: '10px' } },
            h('button', {
              type: 'button', className: 'ru-btn primary', disabled: anyBusy || editing !== null,
              onClick: () => setEditing({ draft: { enabled: true, serialQueue: 1 }, isNew: true }),
            }, t('btnAdd')),
            h('button', {
              type: 'button', className: 'ru-btn', disabled: anyBusy || workers.length === 0,
              onClick: async () => {
                setBusy('all')
                setStatus({ kind: 'idle', text: '' })
                try {
                  for (const row of workers) await call('selfcheck', { peerId: row.peerId })
                  await refresh()
                } catch (error) {
                  setStatus({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
                } finally {
                  setBusy('')
                }
              },
            }, busy === 'all' ? t('busy') : t('btnAll')))),

        status.text === '' ? null : h('div', { className: `ru-msg ${status.kind === 'err' ? 'err' : status.kind === 'ok' ? 'ok' : 'mute'}` }, status.text),

        // Approval policy and connection tuning. Separate from the worker list because these
        // apply to every worker, and changing them is what forces a full rebuild.
        snapshot === null || snapshot.settings === undefined ? null : h(AdvancedSettings, {
          t,
          settings: snapshot.settings,
          busy,
          onSave: (next) => void savePolicy(next),
        }),

        snapshot === null || typeof snapshot.settingsFile !== 'string' || snapshot.settingsFile === ''
          ? null
          : h('div', { className: 'ru-group' },
            h('h3', { className: 'ru-group-title' }, t('groupSource')),
            h('p', { className: 'ru-source' }, fmt(t('sourceText'), { file: snapshot.settingsFile }))),

        h('div', { className: 'ru-group' },
          h('h3', { className: 'ru-group-title' }, t('groupApprovals')),
          approvals.available !== true
            ? h('p', { className: 'ru-note warn' }, t('approvalsUnavailable'))
            : h('div', null,
              h('p', { className: 'ru-note' }, t('approvalsNote')),
              h('p', { className: 'ru-note dim' }, fmt(t('approvalsBudget'), {
                s: Math.round(Number(approvals.timeoutMs ?? 0) / 1000),
              })),
              pending.length === 0
                ? h('p', { className: 'ru-note' }, t('approvalsNone'))
                : h('div', { className: 'ru-approvals' }, pending.map((row) => {
                  const id = String(row.id ?? '')
                  const rowBusy = busy === `approval:${id}`
                  return h('div', { className: 'ru-approval', key: id },
                    h('div', { className: 'ru-approval-head' },
                      h('strong', { className: 'ru-mono' }, String(row.toolName ?? '?')),
                      h('span', { className: 'ru-badge warn' }, String(row.requiredTier ?? '?')),
                      h('span', { className: 'ru-dim' }, `${String(row.peerId ?? '')} \u00b7 ${String(row.taskId ?? '')}`)),
                    h('div', { className: 'ru-approval-why' }, String(row.reason ?? '')),
                    row.rawInput === '' ? null : h('pre', { className: 'ru-args' }, String(row.rawInput)),
                    h('div', { className: 'ru-approval-actions' },
                      h('button', {
                        type: 'button',
                        className: 'ru-btn primary',
                        disabled: anyBusy,
                        onClick: () => void onDecide(id, 'allow'),
                      }, rowBusy ? t('approving') : t('btnAllow')),
                      h('button', {
                        type: 'button',
                        className: 'ru-btn',
                        disabled: anyBusy,
                        onClick: () => void onDecide(id, 'deny'),
                      }, t('btnDeny')),
                      h('span', { className: 'ru-dim' }, `${t('colWaited')} ${Math.round(Number(row.ageMs ?? 0) / 1000)}s`)))
                })))),

        h('div', { className: 'ru-group' },
          h('h3', { className: 'ru-group-title' }, t('groupAudit')),
          audit.available !== true
            ? h('p', { className: 'ru-note dim' }, t('auditNote', { p: '\u2014' }))
            : h('div', null,
              h('p', { className: 'ru-note dim' }, fmt(t('auditNote'), { p: String(audit.path ?? '') })),
              audit.error === '' ? null : h('p', { className: 'ru-note warn' }, String(audit.error)),
              recentAudit.length === 0
                ? h('p', { className: 'ru-note' }, t('auditNone'))
                : h('div', { className: 'ru-scroll' },
                  h('table', { className: 'ru-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, t('colStarted')),
                      h('th', null, t('colTool')),
                      h('th', null, t('colTier')),
                      h('th', null, t('colState')),
                      h('th', null, t('colWorker')))),
                    h('tbody', null, recentAudit.map((row, index) => h('tr', { key: `${String(row.at)}-${index}` },
                      h('td', { className: 'ru-mono ru-dim' }, formatTime(row.at)),
                      h('td', { className: 'ru-mono' }, String(row.toolName ?? '\u2014')),
                      h('td', null, String(row.requiredTier ?? '\u2014')),
                      h('td', null,
                        h('span', {
                          className: row.optionId === 'allow-once' ? 'ru-badge ok' : 'ru-badge',
                        }, String(row.optionId ?? '')),
                        ' ',
                        h('span', { className: 'ru-dim' }, fmt(t('auditBy'), { by: describeBy(row.by) }))),
                      h('td', null, String(row.peerId ?? ''))))))))),

        h('div', { className: 'ru-group' },
          h('h3', { className: 'ru-group-title' }, t('groupTasks')),
          tasks.length === 0
            ? h('p', { className: 'ru-note' }, t('noTasks'))
            : h('div', { className: 'ru-scroll' },
              h('table', { className: 'ru-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('colTask')),
                  h('th', null, t('colWorker')),
                  h('th', null, t('colState')),
                  h('th', null, t('colTools')),
                  h('th', null, t('colStarted')))),
                h('tbody', null, tasks.map((task) => {
                  const state = String(task.state ?? '')
                  const active = !TERMINAL_STATES.includes(state)
                  return h('tr', { key: String(task.taskId) },
                    h('td', { className: 'mono' }, String(task.taskId)),
                    h('td', null, String(task.peerId ?? '')),
                    h('td', null,
                      h('span', { className: `ru-dot ${active ? 'warn' : 'pass'}` }),
                      state,
                      task.waitingForApproval === true ? ` (${t('waiting')})` : ''),
                    h('td', null, Array.isArray(task.recentTools) && task.recentTools.length > 0
                      ? `${task.toolCallCount ?? 0} (${task.recentTools.join(', ')})`
                      : String(task.toolCallCount ?? 0)),
                    h('td', null, task.startedAt === undefined ? '' : new Date(task.startedAt).toLocaleTimeString()))
                }))))),

        h('div', { className: 'ru-group' },
          h('h3', { className: 'ru-group-title' }, t('groupDanger')),
          h('p', { className: 'ru-note' }, t('dangerNote')),
          h('div', { className: 'ru-actions', style: { marginTop: '8px' } },
            h('button', {
              type: 'button', className: 'ru-btn danger', disabled: anyBusy,
              onClick: () => void onStopAll(),
            }, busy === 'stop' ? t('stopping') : t('btnStopAll')))),
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-remote-use: dictionaries')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-plugin-remote-use',
        // After the notification plugin's 40, so operator surfaces stay grouped together.
        order: 45,
        label: () => t('nav'),
        locale: NS,
      }, RemoteUseSection))
    }

    return { inject, apply }
  },
})
