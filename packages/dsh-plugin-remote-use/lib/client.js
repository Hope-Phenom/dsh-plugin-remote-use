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
  // MUST equal the package name. The loader keys its graph rows -- and therefore its "already
  // loaded" bookkeeping -- by the PACKAGE name, while this id is what the bundle registers itself
  // under. When they disagreed (this said the pre-rename `dsh-plugin-remote-use`), the loader did
  // not recognise its own registration, executed the bundle a second time, and dsh-client-modules
  // threw: `duplicate factory registration for "dsh-plugin-remote-use"`, which surfaced as
  // "web boot: 1 entry did not activate" and left the whole Web UI unable to boot.
  id: '@hope_phenom/dsh-plugin-remote-use',
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
      // 这条曾经写「切换为工作节点（对称配对）尚未实现」—— 而它下面就是完整的布防面板。
      // 界面上说「没做」而实际做了，与文档里那类过期声明是同一个问题。
      roleNote: '本机作为主机向工作节点派单；也可以布防为工作节点（对称配对），见下方。',
      groupWorkers: '工作节点',
      loading: '正在读取工作节点状态…',
      // Points at the step that is actually missing, which is NOT where a worker is configured.
      //
      // This string used to send the operator to the profile patch for a per-worker tool row, and
      // that was WRONG as of 0.2.0: the plugin registers its own delegation tool through `ctx.tools`,
      // so adding a worker here is the whole job (PITFALLS F11 -- a Web session's tool catalog comes
      // from the agent preset, so a patch row would not have reached the model anyway). Nothing
      // else in the UI was telling operators to edit a patch; this one line was.
      noWorkers: '尚未配置工作节点。在上方添加，或粘贴配对串即可 —— 工具会随之出现，不需要改 profile 补丁，也不需要重启。',
      reportPending: '就绪报告未在限时内取得 —— 工作节点可能不可达。连接状态见下。',
      verdictReady: '就绪',
      // 有警告但**阻断项全过** —— 产品的派单门禁只看 status==='fail'，所以这个节点是可用的。
      verdictWarn: '可用（有警告）',
      verdictPartial: '检查不完整',
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
      labelSessionMode: '会话档位',
      // 三个值都不翻译成中文：它们是 DSH 的闭集取值，翻成中文就对不上 profile 与日志里写的了。
      sessionModeUnset: '未设置（DSH 默认 workspace-write）',
      sessionModeNeedsFull: 'GUI 自动化需要 danger-full-access',
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
      fieldSessions: '本机会话状态',
      fieldKeepShots: '每个工作节点保留的截图数',
      fieldKeepShotsHint: '保留最新的若干张。全分辨率截图约 9.5 MB，这一项决定了长时间 GUI 验证会占用多少磁盘。填负数表示全部保留。',
      fieldWorkerSessionMode: '本机远程会话的沙箱档位',
      fieldWorkerSessionModeHint: '布防时写进启动规格：之后由本机接的远程会话都从这一档开始。GUI 自动化需要 danger-full-access —— GUI 在受限令牌下的失败是静默的（命令返回成功、只留一个桌面对话框），所以它不能被逐次审批掉。',
      fieldAuditMaxBytes: '审计文件轮转阈值（字节）',
      fieldAuditMaxBytesHint: '审计是追加式文件，本身没有停止点。达到该大小就改名归档并另起一个，绝不截断正在写的文件。填 0 或负数表示不轮转（无限增长）。',
      fieldAuditKeepFiles: '保留的审计归档数',
      fieldAuditKeepFilesHint: '超出这个数量的最旧归档会被删除 —— 这是本项目里唯一会删掉审计记录的动作。填负数表示全部保留。',
      auditUsage: '当前 {size}；单文件上限 {max}；保留归档 {keep} 个（现有 {n} 个）',
      auditUnbounded: '不限',
      fieldPolicy: '委派策略文案',
      fieldPolicyHint: '在会话启用远程工作期间注入，用来告诉模型何时该把工作交给工作节点。清空表示不注入；无论哪种情况工具仍然受开关约束。',
      sessionsOn: '当前有 {n} 个会话启用了远程工作',
      sessionsNone: '当前没有会话启用远程工作',
      switchHint: '按会话生效且不持久化：在需要使用工作节点的会话里输入 {cmd}。',
      // --- approvals ---
      groupApprovals: '等待你批准的请求',
      approvalsNone: '当前没有等待批准的请求。',
      approvalsUnavailable: '此构建没有审批队列，引擎无法自行裁定的请求会被直接拒绝。',
      approvalsNote: '审阅引擎无法自行裁定的请求会停在这里等待，而不是直接失败；超过下面的时限仍未处理则按拒绝处理 —— 所以"放行"永远是一个明确的动作。',
      approvalsBudget: '每个请求最多等待 {s} 秒',
      approvalsMissed: '有 {n} 件请求因无人应答被拒',
      approvalsMissedNote: '这些请求等过、但没人来得及处理，于是按拒绝处理了。列在这里是为了让"错过"事后也看得见 —— 要收起这个列表请用下面的清空；文件里的记录不会消失。',
      colSettled: '处理时间',
      // 工作现场里的三处审批面（会话头按钮 / 输入框上方 / 右侧面板）
      approvalsPanel: '审批',
      approvalsDockWaiting: '有 {n} 件远程任务在等你批准',
      approvalsDockHint: '每个请求最多等 {s} 秒，超时按拒绝处理',
      approvalsHeaderPending: '审批 {n}',
      approvalsHeaderMissed: '错过 {n} 件',
      approvalsOpenPanel: '打开审批面板',
      approvalsPanelPending: '等待批准（{n}）',
      approvalsPanelEmpty: '当前没有等待批准的请求。',
      approvalsPanelMissed: '无人应答而被拒（{n}）',
      approvalsPanelNoMissed: '没有错过的请求。',
      approvalsPanelAlso: '记录同时写在 {p}',
      btnClearMissed: '清空错过记录',
      btnClearing: '正在清空…',
      clearedMissed: '已清空 {n} 件',
      clearMissedNote: '只清空这里的显示；记录文件是追加写入的，原始条目仍在，并会多出一条「已清空」。',
      approvalsLeft: '剩 {s} 秒',
      approvalsPanelPendingTitle: '等你批准',
      approvalsPanelMissedTitle: '无人应答而被拒',
      btnAllowShort: '允许',
      btnDenyShort: '拒绝',
      colTool: '工具',
      colTier: '所需档位',
      colWaited: '已等待',
      colArgs: '参数',
      btnAllow: '允许一次',
      btnDeny: '拒绝',
      approving: '正在提交…',
      approvalAllowed: '已允许一次',
      approvalDenied: '已拒绝',
      roleArmed: '本机正在接受远程驱动',
      roleDisarmed: '未接受远程驱动',
      roleDisarmedNote: '当前没有监听任何端口。布防会开一个端口，让已配对的主机在本机执行命令。',
      roleUptime: '已运行',
      roleToken: '凭据',
      roleSandbox: '约束状态',
      roleSandboxOk: '沙箱已验证',
      roleSandboxUnknown: '尚未验证',
      roleBind: '监听地址',
      roleBindHint: '指定某个局域网接口。不提供"所有接口"的选项；虚拟网卡会列出来，只是为了让你看到它为何不被选中。',
      roleVirtual: '虚拟网卡',
      roleNotOffered: '不提供',
      rolePort: '端口',
      rolePortHint: '主机拨这个端口。7331 与参考从机一致。',
      roleTaskDir: '任务目录',
      roleTaskDirHint: '本机上一个绝对路径，远程任务在这里运行，也是沙箱允许它写入的范围。它会写进配对串，主机就不必再猜。留空的话，主机必须自己填一个。',
      roleCheck: '先检查',
      roleArm: '布防为工作节点',
      roleCheckOk: '沙箱能约束本机，地址可用，可以布防。',
      roleCheckFailed: '暂时不能布防：',
      roleIssuedOnce: '只显示这一次。之后不再展示 —— 重新签发意味着先停止布防再重新布防。',
      rolePairing: '配对串',
      rolePairingHint: '把它粘贴到主机的设置页。它携带凭据，请当作密码对待。',
      roleTokenLabel: '凭据',
      roleTokenHint: '同一个密钥的原始形式，供直接索要凭据的主机使用。',
      roleIssuedDone: '我已保存',
      roleStop: '立即停止',
      roleStopForget: '停止并作废凭据',
      roleStopHint: '立即生效，且不会联系主机。',
      groupAudit: '最近的裁定',
      auditNone: '尚无裁定记录。',
      groupTransfers: '文件传输',
      noTransfers: '尚无文件传输记录。',
      colDirection: '方向',
      colPath: '路径',
      colSize: '大小',
      transferSent: '上传到节点',
      transferFetched: '从节点取回',
      auditNote: '追加写入，位置：{p}',
      auditByEngine: '引擎',
      auditByPage: '你在设置页点的',
      auditByApi: '程序调用（脚本/API）',
      auditByHuman: '人（旧记录：来源未区分）',
      auditByTimeout: '超时未处理',
      auditByNoAnswerer: '无人可问',
      auditByDisposed: '插件已卸载',
      // --- pairing ---
      btnAdd: '添加工作节点',
      btnPair: '粘贴配对串',
      btnPairSave: '配对',
      pairDone: '配对完成，工作节点已配置并连接。',
      fieldPairing: '配对串',
      fieldPairingHint: '由工作节点生成（relay 的 --print-pairing，或 relay 旁边的 pairing.txt）。它包含工作节点令牌，请当作密码对待：用掉后本框即清空，且绝不会回传到浏览器。',
      fieldPairingCwd: '任务目录（配对串没带时才需要填）',
      fieldPairingCwdHint: '从机上的绝对路径。较新的从机会把它放进配对串，这里留空即可。留空且配对串也没带，配对会被拒绝 —— 没有任务目录的工作节点无法接单。',
      fieldPairingPlaceholder: 'dshpair1.…',
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
      // Recommends a HOSTNAME, not an IP.
      //
      // It used to show a hardcoded address -- one particular machine's, from DHCP.
      // An operator following that hint writes an address that rots the next time the worker
      // reboots and gets a different lease, and the symptom is "the worker is unreachable", which
      // looks exactly like the worker being powered off. A name survives that, as long as the
      // master can resolve it (measured: this works end to end over LLMNR).
      //
      // Note the asymmetry with the pairing string, which always carries an IP because the relay
      // advertises its own address -- a pasted pairing string does NOT survive the worker moving.
      fieldUrlHint: '从机中继的 WebSocket 地址。建议用主机名（例如 ws://worker-pc:7331），这样从机换 IP 后仍然可用；用 IP 的话每次换地址都要改。',
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
      // --- 截图缓存 ---
      groupCache: '截图缓存',
      cacheLimitText: '上限 {size}',
      cacheNoLimit: '未设上限（仅受张数限制）',
      labelCacheHost: '主机缓存',
      labelCacheWorker: '从机缓存',
      cacheNone: '暂无',
      cacheUnsupported: '该从机的 relay 不支持缓存上报',
      cacheUnreachable: '从机离线，无法读取',
      cacheFiles: '{n} 张',
      cacheOver: '超出 {size}',
      fieldShotCache: '截图缓存上限',
      fieldShotCacheHint: '留空或 0 表示不设上限。可写 512MB、1.5GB 或字节数。超限时自动删除最旧的；最新一张始终保留——主机正在读取的那张若被删掉，截图工具就会"报成功但没有文件"。',
      btnCacheApply: '应用上限',
      btnCacheClear: '清空缓存',
      cacheSaveFailed: '上限无法识别：请填 512MB、1.5GB 这样的值，或 0 表示不设上限。',
      cacheCleared: '已清空 {scope}：删除 {n} 个文件，释放 {size}',
      cacheClearNothing: '{scope} 没有可清理的文件',
      cachePruned: '{scope} 已按上限清理：删除 {n} 个，释放 {size}',
      cacheWithinBudget: '{scope} 在限额内，无需清理',
      cacheFilesCleared: '{n} 个文件',
    }

    const en = {
      nav: 'Remote workers',
      title: 'Remote workers',
      description: 'Send GUI automation to paired workers instead of taking over this machine\u2019s mouse and keyboard. Availability, diagnostics and the emergency stop live here.',
      groupRole: 'This machine\u2019s role',
      roleMaster: 'Master',
      roleNote: 'This machine dispatches to workers. It can also be armed as a worker itself (symmetric pairing) -- see below.',
      groupWorkers: 'Workers',
      loading: 'Reading worker state\u2026',
      noWorkers: 'No workers yet. Add one above, or paste a pairing string \u2014 the model\u2019s tools come with it, with no profile-patch edit and no restart.',
      reportPending: 'The readiness report did not arrive in time \u2014 the worker is probably unreachable. Link state below.',
      verdictReady: 'ready',
      verdictWarn: 'usable (warnings)',
      verdictPartial: 'not fully checked',
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
      labelSessionMode: 'Session mode',
      // The values themselves stay untranslated: they are DSH's closed vocabulary, and a translated
      // one would no longer match what the profile and the logs say.
      sessionModeUnset: 'not set (DSH defaults to workspace-write)',
      sessionModeNeedsFull: 'GUI automation needs danger-full-access',
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
      fieldSessions: 'Local sessions',
      fieldKeepShots: 'Screenshots kept per worker',
      fieldKeepShotsHint: 'Newest first. A full-resolution capture is roughly 9.5 MB, so this bounds what a long GUI run costs on disk. Negative keeps everything.',
      fieldWorkerSessionMode: 'Sandbox mode for this machine\'s remote sessions',
      fieldWorkerSessionModeHint: 'Written into the launch spec when arming: remote sessions this machine accepts start at this level. GUI automation needs danger-full-access -- a GUI process failing under a restricted token does so SILENTLY (the command returns success; only a desktop dialog is left), so it cannot be surfaced as a per-call approval.',
      fieldAuditMaxBytes: 'Audit rotation threshold (bytes)',
      fieldAuditMaxBytesHint: 'The trail is append-only, so it has no stopping point of its own. At this size it is renamed to an archive and a fresh file starts -- the live file is never truncated. 0 or negative disables rotation (unbounded growth).',
      fieldAuditKeepFiles: 'Audit archives kept',
      fieldAuditKeepFilesHint: 'The oldest archives beyond this are deleted -- the only action in this project that removes audit records. Negative keeps every archive.',
      auditUsage: 'Now {size}; {max} per file; keeping {keep} archive(s), {n} present',
      auditUnbounded: 'unbounded',
      fieldPolicy: 'Delegation policy',
      fieldPolicyHint: 'Injected while a session has remote work switched on. It is what tells the model when to hand work to a worker. Clear it to inject nothing; the tools stay gated either way.',
      sessionsOn: '{n} session(s) have remote work on',
      sessionsNone: 'No session has remote work on right now',
      switchHint: 'Per session, and not persisted: type {cmd} in the session that should use a worker.',
      // --- approvals ---
      groupApprovals: 'Approvals waiting on you',
      approvalsNone: 'Nothing is waiting for approval.',
      approvalsUnavailable: 'This build has no approval queue, so a request the engine cannot justify is refused outright.',
      approvalsNote: 'The review engine refuses anything it cannot justify on its own. Those requests wait here instead of failing, until the budget expires \u2014 and expiry is a refusal, so allowing one is always an explicit act.',
      approvalsBudget: 'Each waits up to {s}s',
      approvalsMissed: '{n} request(s) were refused because nobody answered',
      approvalsMissedNote: 'These waited and nobody got to them, so they were refused. Listed so a miss stays visible after the fact; Clear below hides the list, and the record in the file stays.',
      colSettled: 'Settled',
      // The three approval surfaces that live where the work happens.
      approvalsPanel: 'Approvals',
      approvalsDockWaiting: '{n} remote task(s) are waiting for your approval',
      approvalsDockHint: 'each waits up to {s}s, then it is refused',
      approvalsHeaderPending: 'Approvals {n}',
      approvalsHeaderMissed: '{n} missed',
      approvalsOpenPanel: 'Open the approvals panel',
      approvalsPanelPending: 'Waiting for you ({n})',
      approvalsPanelEmpty: 'Nothing is waiting for approval.',
      approvalsPanelMissed: 'Refused because nobody answered ({n})',
      approvalsPanelNoMissed: 'Nothing was missed.',
      approvalsPanelAlso: 'The record is also written to {p}',
      btnClearMissed: 'Clear missed',
      btnClearing: 'Clearing\u2026',
      clearedMissed: 'Cleared {n}',
      clearMissedNote: 'Hides this list only. The file is append-only: the rows stay, and a "cleared" entry is added.',
      approvalsLeft: '{s}s left',
      approvalsPanelPendingTitle: 'Waiting for you',
      approvalsPanelMissedTitle: 'Refused unanswered',
      btnAllowShort: 'Allow',
      btnDenyShort: 'Deny',
      colTool: 'Tool',
      colTier: 'Required',
      colWaited: 'Waited',
      colArgs: 'Arguments',
      btnAllow: 'Allow once',
      btnDeny: 'Refuse',
      approving: 'Sending\u2026',
      approvalAllowed: 'Allowed once',
      approvalDenied: 'Refused',
      roleArmed: 'This machine is accepting remote driving',
      roleDisarmed: 'Not accepting remote driving',
      roleDisarmedNote: 'Nothing is listening. Arming opens a port and lets a paired master run commands here.',
      roleUptime: 'up',
      roleToken: 'credential',
      roleSandbox: 'Confinement',
      roleSandboxOk: 'sandbox verified',
      roleSandboxUnknown: 'not verified yet',
      roleBind: 'Listen on',
      roleBindHint: 'A specific LAN interface. Binding every interface is not offered, and virtual adapters are listed only so you can see why they are not chosen.',
      roleVirtual: 'virtual adapter',
      roleNotOffered: 'not offered',
      rolePort: 'Port',
      rolePortHint: 'The master dials this port. 7331 matches the reference worker.',
      roleTaskDir: 'Task directory',
      roleTaskDirHint: 'An absolute path on THIS machine where remote tasks run, and the scope their sandbox may write to. It goes into the pairing string so the master does not have to guess. Left blank, the master must supply one itself.',
      roleCheck: 'Check first',
      roleArm: 'Arm as a worker',
      roleCheckOk: 'The sandbox contains this machine and the address is usable. Safe to arm.',
      roleCheckFailed: 'Cannot arm yet:',
      roleIssuedOnce: 'Shown ONCE. It will not be displayed again \u2014 re-issuing means stopping the worker role and arming again.',
      rolePairing: 'Pairing string',
      rolePairingHint: 'Paste this into the master\u2019s settings page. It carries the credential, so treat it like a password.',
      roleTokenLabel: 'Credential',
      roleTokenHint: 'The same secret in raw form, for a master that asks for it directly.',
      roleIssuedDone: 'I have saved it',
      roleStop: 'Stop now',
      roleStopForget: 'Stop and discard the credential',
      roleStopHint: 'Take effect immediately and never contact the master.',
      groupAudit: 'Recent decisions',
      auditNone: 'No decisions recorded yet.',
      groupTransfers: 'File transfers',
      noTransfers: 'No file transfers recorded yet.',
      colDirection: 'Direction',
      colPath: 'Path',
      colSize: 'Size',
      transferSent: 'sent to node',
      transferFetched: 'fetched from node',
      auditNote: 'Append-only, at {p}',
      auditByEngine: 'engine',
      auditByPage: 'you, on the settings page',
      auditByApi: 'a script/API call',
      auditByHuman: 'a person (legacy row: source not distinguished)',
      auditByTimeout: 'expired unanswered',
      auditByNoAnswerer: 'nobody to ask',
      auditByDisposed: 'plugin unloaded',
      // --- pairing ---
      btnAdd: 'Add worker',
      btnPair: 'Paste a pairing string',
      btnPairSave: 'Pair',
      pairDone: 'Paired. The worker is configured and connected.',
      fieldPairing: 'Pairing string',
      fieldPairingHint: 'Produced by the worker (relay --print-pairing, or pairing.txt beside the relay). It contains the worker token, so treat it like a password: it is cleared from this box once used, and never sent back to the browser.',
      fieldPairingCwd: 'Task directory (only needed if the string does not carry one)',
      fieldPairingCwdHint: 'An absolute path on the worker. A current worker puts it in the pairing string, so this can stay blank; if neither supplies one the pairing is refused, because a worker without a task directory cannot accept a task.',
      fieldPairingPlaceholder: 'dshpair1.\u2026',
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
      fieldUrlHint: 'The worker relay\u2019s WebSocket address. Prefer a HOSTNAME (e.g. ws://worker-pc:7331): it survives the worker getting a new IP from DHCP, whereas an address literal has to be edited every time the lease changes.',
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
      // --- screenshot cache ---
      groupCache: 'Screenshot cache',
      cacheLimitText: 'limit {size}',
      cacheNoLimit: 'no byte limit (count only)',
      labelCacheHost: 'Host cache',
      labelCacheWorker: 'Worker cache',
      cacheNone: 'nothing yet',
      cacheUnsupported: 'this worker\'s relay does not report its cache',
      cacheUnreachable: 'worker offline, cannot read',
      cacheFiles: '{n} file(s)',
      cacheOver: 'over by {size}',
      fieldShotCache: 'Screenshot cache limit',
      fieldShotCacheHint: 'Blank or 0 means no limit. Accepts 512MB, 1.5GB, or a byte count. Past the limit the oldest are deleted automatically; the newest is always kept \u2014 deleting the capture the host is reading would leave the screenshot tool reporting success with no file to show.',
      btnCacheApply: 'Apply limit',
      btnCacheClear: 'Clear cache',
      cacheSaveFailed: 'That limit is not readable \u2014 use a value like 512MB, 1.5GB, or 0 for no limit.',
      cacheCleared: 'Cleared {scope}: {n} file(s), {size} freed',
      cacheClearNothing: '{scope} had nothing to clear',
      cachePruned: '{scope} pruned to the limit: {n} file(s), {size} freed',
      cacheWithinBudget: '{scope} is within the limit; nothing to prune',
      cacheFilesCleared: '{n} file(s)',
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
      // A session level that cannot run GUI automation is not an error, so it is not red: it is the
      // one value in this row that a reader may need to act on, and colour is how that reads.
      '.ru-mode-warn{color:var(--dsw-alias-state-business-primary)}',
      '.ru-dim{color:var(--dsw-alias-label-tertiary)}',
      // A pending approval is the one thing on this page that is BLOCKING a worker, so it is
      // outlined in the business colour rather than reading as another informational card.
      '.ru-approvals{display:flex;flex-direction:column;gap:10px}',
      '.ru-approval{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border:0.5px solid var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-sm)}',
      '.ru-approval-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}',
      '.ru-approval-why{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.ru-approval-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ru-missed{display:flex;flex-direction:column;gap:6px;padding:9px 11px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}',
      // --- the three approval surfaces that live where the work happens -------------------
      //
      // DESIGN DIRECTION: these sit INSIDE DSH's own chrome (session header, composer, right pane),
      // so the job is not to invent an identity -- it is to inherit the host's tokens and then spend
      // the ONE loud element on the thing that is actually blocking a worker. Every colour below is
      // a `--dsw-alias-*` token, so a skin swap restyles this with everything else, and a saturated
      // accent appears only while something waits.
      // The strip above the input bar: full width of the composer, so it is a column, and the only
      // outer spacing it needs is a gap before the input box below it (F28).
      '.ru-dock{display:flex;flex-direction:column;gap:8px;margin:0 0 8px}',
      '.ru-dock-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 14px;padding:10px 12px 10px 15px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);animation:ru-in 140ms ease-out}',
      '.ru-dock-row::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}',
      '.ru-dock-main{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}',
      '.ru-dock-who{font-size:11px;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}',
      '.ru-dock-actions{grid-column:1 / -1;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}',
      '.ru-tier{display:inline-flex;align-items:center;flex:0 0 auto;padding:1px 7px;border-radius:999px;font-size:11px;font-family:ui-monospace,Consolas,monospace;white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}',
      '.ru-count{font-size:11px;font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary)}',
      '.ru-clear{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:8px 0 2px}',
      '.ru-tool{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace}',
      '.ru-hdrbtn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;cursor:pointer}',
      '.ru-hdrbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ru-hdrbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.ru-hdrbtn.pending{color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '.ru-beacon{width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.ru-panel{display:flex;flex-direction:column;gap:4px;padding:14px 16px 20px;height:100%;overflow:auto}',
      '.ru-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:6px 0 2px}',
      '.ru-panel-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.ru-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 14px;padding:11px 0;border-top:0.5px solid var(--dsw-alias-border-l1)}',
      '.ru-row:first-of-type{border-top:0}',
      '.ru-row-main{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}',
      '.ru-row-actions{grid-column:1 / -1;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}',
      '.ru-empty{margin:0;padding:14px 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.ru-why{grid-column:1 / -1;margin:0;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}',
      // The facts above sit in two columns; everything below them spans both, or a paragraph lands in
      // the auto-width column and renders one word per line (measured 2026-10-15, on screen).
      '.ru-row .ru-args{grid-column:1 / -1;max-width:100%}',
      '.ru-record{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 14px;padding:7px 0;border-top:0.5px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ru-record:first-of-type{border-top:0}',
      '.ru-record-when{font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);text-align:right}',
      '@keyframes ru-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion: reduce){.ru-dock-row{animation:none}}',
      '.ru-args{margin:0;padding:6px 8px;max-height:96px;overflow:auto;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}',
      '\.ru-role{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ru-role-banner{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:9px 11px;margin:8px 0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font-size:12px}',
      // An open listener is the one state on this page that has to be visible from across the room.
      '.ru-role-banner.armed{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
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
      '.ru-textarea{font-family:ui-monospace,Consolas,monospace;line-height:1.5;resize:vertical}',
      '.ru-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}',
      '.ru-source{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.6;word-break:break-all}',
      // The screenshot-cache block on a worker card. A separate bordered area rather than more
      // rows in the card's key/value grid: those rows describe the LINK, and mixing "is it
      // reachable" with "how much disk is it using" made the cache numbers read as status.
      '.ru-cache{margin-top:10px;padding:10px;border:1px solid var(--dsw-alias-border-secondary);border-radius:6px}',
      '.ru-cache-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}',
      '.ru-cache-side{display:flex;flex-direction:column;gap:1px}',
      '.ru-cache-side .ru-k{font-size:11px}',
    ].join('')

    /** Fill `{name}` placeholders. Kept local so the page does not depend on a t() option API. */
    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
      ))
    }

    /**
     * A byte count a person can read at a glance.
     *
     * Binary units on purpose: the caps are configured in bytes and the comparison the operator is
     * making is against those caps, so 8 MiB must not print as "8.4 MB" and look like it overran.
     */
    function formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return '0'
      const units = ['B', 'KiB', 'MiB', 'GiB']
      let n = bytes
      let unit = 0
      while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit += 1 }
      // One decimal only where it adds information: "0.4 KiB" is noise, "12.5 MiB" is not.
      return `${unit === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[unit]}`
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
     * The verdict drives every colour and the availability badge on the page, so map it once.
     *
     * WHY `warn` IS NOT "unavailable": the worker self-check produces four verdicts, and only two of
     * them mean the worker cannot be used.
     *
     *   ready    -- every check passed
     *   warn     -- every BLOCKING check passed; some advisory notes remain. The product's own
     *               dispatch gate (`remote-provider`) blocks on a check whose status is `fail` and
     *               ignores warnings entirely, so this worker works.
     *   partial  -- a check could not be evaluated at all
     *   blocked  -- a blocking check FAILED. This one is unusable.
     *
     * The page used to render anything that was not `ready`/`unknown` as "unavailable", so a worker
     * with zero blocking failures and one advisory note -- which is exactly what the reference
     * worker reports, and what the screenshot that prompted this showed -- was labelled unusable
     * while its own detail line said `blocking 0`. Two parts of the same card disagreed, and the
     * loud one was wrong. That is the same wrong rule the live harness had, fixed there first.
     */
    function verdictClass(verdict) {
      if (verdict === 'ready') return 'ok'
      // Advisory only: usable, with something worth reading.
      if (verdict === 'warn' || verdict === 'warning') return 'warn'
      // Not evaluated -- not a fault of the worker, but not a pass either.
      if (verdict === 'partial') return 'mute'
      if (verdict === 'blocked') return 'bad'
      return 'mute'
    }

    /** The badge text for a verdict. Kept next to `verdictClass` so the two cannot drift apart. */
    function verdictText(t, verdict) {
      if (verdict === 'ready') return t('verdictReady')
      if (verdict === 'warn' || verdict === 'warning') return t('verdictWarn')
      if (verdict === 'partial') return t('verdictPartial')
      if (verdict === 'blocked') return t('verdictBlocked')
      return t('verdictUnknown')
    }

    /** A check row's status as a CSS class; DSH reports `warn`, the stylesheet also allows `warning`. */
    function checkClass(status) {
      if (status === 'pass') return 'pass'
      if (status === 'fail') return 'fail'
      if (status === 'warn' || status === 'warning') return 'warning'
      return 'unchecked'
    }

    /**
     * Render a byte budget for the input field: whole MB when it lines up, bare bytes otherwise.
     *
     * WHY NOT ALWAYS BYTES: the field is a human's, and `2147483648` is not a number anyone
     * reasons about. WHY NOT ALWAYS MB: a budget of 0 (no ceiling) and a budget of 500 KB (an
     * odd but legal value, e.g. set for a test) must not both render as `0 MB`.
     */
    function budgetText(bytes) {
      const n = Math.floor(Number(bytes))
      if (!Number.isFinite(n) || n <= 0) return '0'
      return n % (1024 * 1024) === 0 ? `${n / (1024 * 1024)}MB` : String(n)
    }

    /**
     * Parse the operator's budget text into bytes. Accepts `512MB`, `1.5 GB`, `2048`, `0`.
     * @returns {number | undefined} undefined for anything unusable, so the field can refuse
     *   rather than silently applying a guess -- an off-by-a-million typo here either deletes
     *   nothing or deletes everything, and both look like the control being broken.
     */
    function parseBudgetText(text) {
      if (typeof text === 'number') return Number.isFinite(text) ? Math.floor(text) : undefined
      if (typeof text !== 'string') return undefined
      const raw = text.trim()
      if (raw === '') return undefined
      const m = /^(-?\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(raw)
      if (m === null) return undefined
      const value = Number(m[1])
      if (!Number.isFinite(value)) return undefined
      const unit = (m[2] ?? '').toLowerCase()
      const scale = unit === '' || unit === 'b' ? 1 : unit === 'kb' ? 1024 : unit === 'mb' ? 1024 * 1024 : 1024 * 1024 * 1024
      return Math.floor(value * scale)
    }

    const TERMINAL_STATES = ['completed', 'error', 'aborted', 'cancelled']

    /**
     * One worker's screenshot cache: what it occupies on each side, and the controls.
     *
     * WHY IT LIVES ON THE WORKER CARD rather than in the global settings: the accumulation is
     * PER WORKER on both sides -- the host keeps one directory of `<peerId>-<stamp>.png` per
     * worker, and each worker keeps its own -- so a single global "clear cache" button could not
     * say which worker it would empty. The threshold itself is global (one setting governs every
     * worker), which is why the input writes through to the settings route rather than being a
     * per-worker value; that split is stated in the hint so the control is not a surprise.
     *
     * BOTH SIDES ARE SHOWN because the operator's question is "where did my disk go", and either
     * side could be the answer. Showing only the host's would have made the 218 MB incident look
     * like a worker problem, and showing only the worker's would have hidden the larger half.
     */
    function CachePanel(props) {
      const { t, row, maxBytes, onCache } = props
      const host = row.hostCache ?? null
      const worker = row.workerCache ?? null
      const [budget, setBudget] = React.useState(budgetText(maxBytes))
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')

      // Follow the saved setting when it changes underneath us -- e.g. another tab saves, or the
      // snapshot lands after the first render. Without this the field would keep showing the
      // value the page first painted, and the next Apply would write that stale one back.
      React.useEffect(() => { setBudget(budgetText(maxBytes)) }, [maxBytes])

      const run = async (scope, op) => {
        const parsed = parseBudgetText(budget)
        // A blank field means "no limit", which is a real choice and not an error. Anything else
        // that does not parse is refused here, at the field, rather than being sent as a guess.
        const chosen = budget.trim() === '' ? 0 : parsed
        if (chosen === undefined) {
          setMsg(t('cacheSaveFailed'))
          return
        }
        setBusy(`${scope}:${op}`)
        setMsg('')
        try {
          // `maxBytes` doubles as "save this budget": the host writes it to the settings file when
          // it differs, so Apply and Clear are the same call with a different `op`.
          const data = await onCache(scope, op, chosen)
          setMsg(String(data?.message ?? ''))
        } catch (error) {
          setMsg(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy('')
        }
      }

      const side = (labelKey, info, unsupportedKey) => {
        const known = info !== null && info !== undefined
        const bytes = Number(info?.bytes ?? 0)
        const files = Number(info?.files ?? 0)
        const over = Number(info?.overBudgetBytes ?? 0)
        const detail = !known
          ? t(unsupportedKey)
          : `${formatBytes(bytes)} \u00b7 ${fmt(t('cacheFiles'), { n: files })}${over > 0 ? ` \u00b7 ${fmt(t('cacheOver'), { size: formatBytes(over) })}` : ''}`
        return h('div', { className: 'ru-cache-side', key: labelKey },
          h('span', { className: 'ru-k' }, t(labelKey)),
          h('span', {
            className: `ru-v${!known || over > 0 ? ' ru-dim' : ''}`,
            // The worker's own directory is shown with its full path in the title: two machines
            // both have a "shots" directory, and the path is what tells them apart.
          }, detail),
          known && info.dir !== undefined && info.dir !== '' ? h('span', { className: 'ru-note dim' }, String(info.dir)) : null)
      }

      return h('div', { className: 'ru-cache' },
        h('div', { className: 'ru-cache-head' },
          h('span', { className: 'ru-name' }, t('groupCache')),
          h('span', {
            className: 'ru-note',
          }, maxBytes > 0 ? fmt(t('cacheLimitText'), { size: formatBytes(maxBytes) }) : t('cacheNoLimit'))),
        h('div', { className: 'ru-kv' },
          side('labelCacheHost', host, 'cacheNone'),
          side('labelCacheWorker', worker?.supported === true ? worker : null,
            worker !== null && worker !== undefined && worker.error !== '' ? 'cacheUnreachable' : 'cacheUnsupported')),
        h('label', { className: 'ru-field' },
          h('span', { className: 'ru-field-label' }, t('fieldShotCache')),
          h('input', {
            className: 'ru-input',
            type: 'text',
            value: budget,
            placeholder: '512MB',
            onChange: (event) => setBudget(event.target.value),
          }),
          h('span', { className: 'ru-field-hint' }, t('fieldShotCacheHint'))),
        h('div', { className: 'ru-actions' },
          h('button', {
            type: 'button', className: 'ru-btn', disabled: busy !== '',
            onClick: () => void run('host', 'prune'),
          }, busy === 'host:prune' ? t('busy') : fmt(t('btnCacheApply'), { scope: t('labelCacheHost') })),
          h('button', {
            type: 'button', className: 'ru-btn', disabled: busy !== '',
            onClick: () => void run('host', 'clear'),
          }, busy === 'host:clear' ? t('busy') : fmt(t('btnCacheClear'), { scope: t('labelCacheHost') })),
          // The worker buttons are offered even when the relay cannot report: a relay that cannot
          // report also cannot prune, so the buttons would fail -- but they fail with a message
          // that says so, which is more useful than a disabled button with no explanation.
          h('button', {
            type: 'button', className: 'ru-btn', disabled: busy !== '',
            onClick: () => void run('worker', 'prune'),
          }, busy === 'worker:prune' ? t('busy') : fmt(t('btnCacheApply'), { scope: t('labelCacheWorker') })),
          h('button', {
            type: 'button', className: 'ru-btn danger', disabled: busy !== '',
            onClick: () => void run('worker', 'clear'),
          }, busy === 'worker:clear' ? t('busy') : fmt(t('btnCacheClear'), { scope: t('labelCacheWorker') }))),
        msg === '' ? null : h('p', { className: 'ru-note' }, msg))
    }

    /**
     * How often the settings page re-reads the snapshot while it is visible.
     *
     * Sized against the approval budget, not against taste: a request may only be answerable for
     * the configured window (180s by default), so a row that takes much longer than a couple of
     * seconds to appear eats into the time a person has to react. `refresh()` touches only the
     * snapshot, so this cannot disturb a half-filled form or an in-flight action.
     */
    const APPROVAL_POLL_MS = 2500

    function WorkerCard(props) {
      const { t, row, busy, onAction, onEdit, onDelete, onCache, cacheMaxBytes } = props
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
      // What level this node's remote sessions ACTUALLY run at, as reported by the relay that spawns
      // them. Until this existed, the master could not tell a GUI-capable worker from a confined one:
      // "I set it to full access" and "the session runs workspace-write" were indistinguishable from
      // here (measured 2026-10-15 -- and they were both true at once, for hours).
      const mode = typeof report?.sessionMode === 'string' ? report.sessionMode : ''
      kv.push(h('span', { key: 'k-mode', className: 'ru-k' }, t('labelSessionMode')))
      kv.push(h('span', {
        key: 'v-mode',
        className: `ru-v ru-mono${mode !== '' && mode !== 'danger-full-access' ? ' ru-mode-warn' : ''}`,
      }, mode === ''
        ? t('sessionModeUnset')
        : (mode === 'danger-full-access' ? mode : `${mode} \u00b7 ${t('sessionModeNeedsFull')}`)))

      const head = [
        h('span', { key: 'name', className: 'ru-name' }, String(row.name ?? row.peerId ?? '')),
        h('span', { key: 'id', className: 'ru-badge mute ru-mono' }, String(row.peerId ?? '')),
        h('span', { key: 'verdict', className: `ru-badge ${verdictClass(verdict)}` },
          verdictText(t, verdict)),
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
        // The cache block sits directly under the facts about the worker and above the check
        // table: it is about this worker, and the check table is the long, rarely-needed part.
        h(CachePanel, { t, row, maxBytes: cacheMaxBytes, onCache }),
        // A missing report is stated as its own fact. The previous revision let it fall
        // through to a generic empty state, which reads as "nothing here" rather than
        // "the probe did not complete".
        report === null || report === undefined
          ? h('div', { className: 'ru-msg mute' }, t('reportPending'))
          : null,
        row.error !== undefined && row.error !== '' ? h('div', { className: 'ru-msg err' }, String(row.error)) : null,
        // Configuration, not connectivity: a worker whose task directory is unusable will be
        // refused at dispatch no matter how healthy the link is. Shown without a click, because
        // the whole failure mode was that it never announced itself until a delegation failed.
        row.configProblem !== undefined && row.configProblem !== '' ? h('div', { className: 'ru-msg err' }, String(row.configProblem)) : null,
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
        approvalTimeoutMs: settings.approvalTimeoutMs ?? 180000,
        heartbeatMs: settings.heartbeatMs ?? 15000,
        keepShots: settings.keepShots ?? 20,
        workerSessionMode: settings.workerSessionMode ?? 'danger-full-access',
        auditMaxBytes: settings.auditMaxBytes ?? 8388608,
        auditKeepFiles: settings.auditKeepFiles ?? 5,
        delegationPolicy: settings.delegationPolicy ?? '',
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
        // A screenshot is a full-resolution PNG (~9.5 MB measured), so this is the difference
        // between a session-long GUI run costing hundreds of megabytes and costing a bounded
        // amount. Negative disables pruning, for an operator who archives them elsewhere.
        number('keepShots', 'fieldKeepShots', 'fieldKeepShotsHint', -1),
        // The level this machine's own remote sessions run at, written into the launch spec when the
        // worker role is armed. It sits next to `requiredTier` on purpose, because they are easy to
        // confuse and are opposites: `requiredTier` is the ceiling the MASTER's review engine will
        // accept from a request, while this is the floor the WORKER's own sessions start at.
        h('label', { className: 'ru-field' },
          h('span', { className: 'ru-field-label' }, t('fieldWorkerSessionMode')),
          h('select', { className: 'ru-input', value: form.workerSessionMode, onChange: set('workerSessionMode') },
            ...[['danger-full-access', 'danger-full-access'], ['workspace-write', 'workspace-write'], ['read-only', 'read-only']]
              .map(([value, label]) => h('option', { key: value, value }, label))),
          h('span', { className: 'ru-field-hint' }, t('fieldWorkerSessionModeHint'))),
        // The audit trail is append-only, so it has no natural stopping point: without a cap it
        // grows for as long as the plugin is installed. These two are what bound it. Negative
        // disables the bound, for an operator who archives the trail elsewhere.
        number('auditMaxBytes', 'fieldAuditMaxBytes', 'fieldAuditMaxBytesHint', -1),
        number('auditKeepFiles', 'fieldAuditKeepFiles', 'fieldAuditKeepFilesHint', -1),
        h('label', { className: 'ru-field' },
          h('span', { className: 'ru-field-label' }, t('fieldPolicy')),
          h('textarea', {
            className: 'ru-input ru-textarea',
            rows: '7',
            value: form.delegationPolicy,
            onChange: set('delegationPolicy'),
          }),
          h('span', { className: 'ru-field-hint' }, t('fieldPolicyHint'))),
        h('div', { className: 'ru-actions', style: { marginTop: '8px' } },
          h('button', {
            type: 'button', className: 'ru-btn', disabled: busy !== '',
            onClick: () => onSave({
              requiredTier: form.requiredTier,
              approvalTimeoutMs: Number(form.approvalTimeoutMs) || 180000,
              heartbeatMs: Number(form.heartbeatMs) || 0,
              keepShots: Number.isFinite(Number(form.keepShots)) ? Number(form.keepShots) : 20,
              workerSessionMode: form.workerSessionMode,
              auditMaxBytes: Number.isFinite(Number(form.auditMaxBytes)) ? Number(form.auditMaxBytes) : 8388608,
              auditKeepFiles: Number.isFinite(Number(form.auditKeepFiles)) ? Number(form.auditKeepFiles) : 5,
              // An empty string is a real choice -- it switches the injected prompt off while
              // leaving the tools gated -- so it is sent as-is rather than coerced.
              delegationPolicy: String(form.delegationPolicy),
            }),
          }, busy === 'policy' ? t('busy') : t('btnSave'))),
      )
    }

    /**
     * The worker role: this machine accepting remote execution.
     *
     * Decision 6 says the page must show the port, the reachable range, the current confinement
     * state and how to close it BEFORE anything is opened. So the panel leads with the state and
     * the gate's verdict, and the arm button stays disabled until a check has actually passed --
     * rather than offering a button whose failure the operator discovers by clicking it.
     *
     * The credential is shown ONCE, immediately after arming, and the panel says so. Every later
     * render reads `tokenHint` from the status, which is a mask.
     */
    function WorkerRolePanel(props) {
      const { t, role, busy, onPreflight, onArm, onDisarm } = props
      const [bindAddress, setBindAddress] = React.useState('')
      const [port, setPort] = React.useState(7331)
      const [taskDir, setTaskDir] = React.useState(String(role?.taskCwd ?? ''))
      const [check, setCheck] = React.useState(null)
      const [issued, setIssued] = React.useState(null)

      const interfaces = Array.isArray(role?.interfaces) ? role.interfaces : []
      const best = interfaces.find((i) => i.score > 0)
      const chosen = bindAddress === '' ? (best?.address ?? '') : bindAddress
      const armed = role?.armed === true
      const checked = check !== null
      const blocked = checked && check.ok !== true

      const doCheck = async () => {
        const result = await onPreflight({ bindAddress: chosen, port: Number(port), taskCwd: taskDir })
        setCheck(result)
      }
      const doArm = async () => {
        const result = await onArm({ bindAddress: chosen, port: Number(port), taskCwd: taskDir })
        if (result?.ok === true) setIssued({ token: result.token, pairing: result.pairing })
        else setCheck({ ok: false, blockers: result?.blockers ?? [String(result?.error ?? '')] })
      }
      const doDisarm = async (forget) => {
        await onDisarm({ forget })
        setIssued(null)
        setCheck(null)
      }

      const uptime = (ms) => {
        const s = Math.max(0, Math.round(Number(ms ?? 0) / 1000))
        if (s < 60) return `${s}s`
        if (s < 3600) return `${Math.floor(s / 60)}m`
        return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
      }

      return h('div', null,
        // The state first, and loudly: an operator who cannot see whether a listener is open has
        // no way to tell whether they left one open.
        h('div', { className: armed ? 'ru-role-banner armed' : 'ru-role-banner' },
          h('span', { className: `ru-badge ${armed ? 'bad' : 'mute'}` }, armed ? t('roleArmed') : t('roleDisarmed')),
          armed
            ? h('span', { className: 'ru-dim' },
              `${String(role.bindAddress)}:${String(role.port)} \u00b7 ${t('roleUptime')} ${uptime(role.uptimeMs)} \u00b7 ${t('roleToken')} ${String(role.tokenHint ?? '')}`)
            : h('span', { className: 'ru-dim' }, t('roleDisarmedNote'))),

        role?.lastError ? h('p', { className: 'ru-note warn' }, String(role.lastError)) : null,

        // What confinement remote work would actually have.
        h('div', { className: 'ru-kv' },
          h('span', { className: 'ru-k' }, t('roleSandbox')),
          h('span', { className: 'ru-v' },
            role?.probe?.ok === true
              ? h('span', { className: 'ru-badge ok' }, t('roleSandboxOk'))
              : h('span', { className: 'ru-badge warn' }, t('roleSandboxUnknown')))),

        armed ? null : h('div', null,
          h('label', { className: 'ru-field' },
            h('span', { className: 'ru-field-label' }, t('roleBind')),
            h('select', {
              className: 'ru-input',
              value: chosen,
              onChange: (event) => { setBindAddress(event.target.value); setCheck(null) },
            },
            // Everything is listed, including the interfaces that must not be chosen, so the page
            // can explain rather than silently omit and leave the operator guessing.
            ...interfaces.map((iface) => h('option', {
              key: iface.address,
              value: iface.address,
              disabled: iface.score <= 0,
            }, `${iface.address}  \u2014  ${iface.name}${iface.virtual ? ` (${t('roleVirtual')})` : ''}${iface.score <= 0 ? ` (${t('roleNotOffered')})` : ''}`))),
            h('span', { className: 'ru-field-hint' }, t('roleBindHint'))),

          h('label', { className: 'ru-field' },
            h('span', { className: 'ru-field-label' }, t('rolePort')),
            h('input', {
              className: 'ru-input', type: 'number', min: '1', max: '65535',
              value: port,
              onChange: (event) => { setPort(event.target.value); setCheck(null) },
            }),
            h('span', { className: 'ru-field-hint' }, t('rolePortHint'))),

          // The directory the master will hand tasks. Asked for HERE, on the machine where the path
          // exists, and carried in the pairing string -- the master cannot know a path on this box,
          // and a worker paired without one cannot accept a task at all (PITFALLS F16).
          h('label', { className: 'ru-field' },
            h('span', { className: 'ru-field-label' }, t('roleTaskDir')),
            h('input', {
              className: 'ru-input ru-mono',
              value: taskDir,
              placeholder: 'C:\\dsh-remote\\work',
              onChange: (event) => { setTaskDir(event.target.value); setCheck(null) },
            }),
            h('span', { className: 'ru-field-hint' }, t('roleTaskDirHint'))),

          h('div', { className: 'ru-actions' },
            h('button', {
              type: 'button', className: 'ru-btn', disabled: busy !== '' || chosen === '',
              onClick: () => void doCheck(),
            }, busy === 'role-check' ? t('busy') : t('roleCheck')),
            h('button', {
              type: 'button', className: 'ru-btn danger',
              // Disabled until a check has passed. Decision 4 refuses arming when the sandbox
              // does not contain this machine, and offering a button that can only fail teaches
              // the operator to click through warnings.
              disabled: busy !== '' || blocked || !checked || chosen === '',
              onClick: () => void doArm(),
            }, busy === 'role-arm' ? t('busy') : t('roleArm'))),

          checked
            ? h('div', { className: check.ok === true ? 'ru-msg ok' : 'ru-msg err' },
              check.ok === true
                ? t('roleCheckOk')
                : h('div', null,
                  h('div', null, t('roleCheckFailed')),
                  ...(check.blockers ?? []).map((b, i) => h('div', { key: String(i) }, `\u00b7 ${String(b)}`))))
            : null),

        // Shown once, and labelled as such.
        issued === null ? null : h('div', { className: 'ru-card' },
          h('p', { className: 'ru-note warn' }, t('roleIssuedOnce')),
          h('label', { className: 'ru-field' },
            h('span', { className: 'ru-field-label' }, t('rolePairing')),
            h('textarea', { className: 'ru-input ru-textarea', rows: '3', readOnly: true, value: String(issued.pairing ?? '') }),
            h('span', { className: 'ru-field-hint' }, t('rolePairingHint'))),
          h('label', { className: 'ru-field' },
            h('span', { className: 'ru-field-label' }, t('roleTokenLabel')),
            h('input', { className: 'ru-input ru-mono', readOnly: true, value: String(issued.token ?? '') }),
            h('span', { className: 'ru-field-hint' }, t('roleTokenHint'))),
          h('div', { className: 'ru-actions' },
            h('button', { type: 'button', className: 'ru-btn', onClick: () => setIssued(null) }, t('roleIssuedDone')))),

        armed
          ? h('div', { className: 'ru-actions', style: { marginTop: '10px' } },
            h('button', {
              type: 'button', className: 'ru-btn danger', disabled: busy !== '',
              onClick: () => void doDisarm(false),
            }, t('roleStop')),
            h('button', {
              type: 'button', className: 'ru-btn', disabled: busy !== '',
              onClick: () => void doDisarm(true),
            }, t('roleStopForget')),
            h('span', { className: 'ru-dim' }, t('roleStopHint')))
          : null)
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
      /** The paste-a-pairing-string panel. Closed by default: it is the shortcut, not the path. */
      const [pairingOpen, setPairingOpen] = React.useState(false)
      const [pairingText, setPairingText] = React.useState('')
      const [pairingCwd, setPairingCwd] = React.useState('')

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

      const clearState = useClear(call, refresh)

      React.useEffect(() => { void refresh() }, [refresh])
      // THE PAGE NEVER USED TO REFRESH ITSELF. Measured 2026-10-14: six approval requests expired
      // unanswered and the operator had never seen a prompt -- the snapshot was read on mount and
      // after their own actions, so a request that arrived while this page sat open stayed
      // invisible unless they happened to reload inside a ~88 second window.
      //
      // Poll only while the page is VISIBLE: a background tab polling forever is a cost with no
      // reader, and the one thing that must be timely here is what a person is looking at.
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => {
          if (document.visibilityState !== 'visible') return
          void refresh()
        }, APPROVAL_POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

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
        // `page` and `api` replaced the single `human`, which a harness's own decision also got.
        // A row written before that split still says `human` and cannot be told apart any more.
        if (by === 'page') return t('auditByPage')
        if (by === 'api') return t('auditByApi')
        if (by === 'human') return t('auditByHuman')
        if (by === 'timeout') return t('auditByTimeout')
        if (by === 'no-answerer') return t('auditByNoAnswerer')
        if (by === 'disposed') return t('auditByDisposed')
        return String(by ?? '')
      }, [t])

      const onPair = React.useCallback(async () => {
        setBusy('pair')
        setStatus({ kind: 'idle', text: '' })
        try {
          // `cwd` is only consulted when the string does not already carry one; a worker that
          // advertises its task directory makes this field unnecessary. Sent only when filled, so
          // a blank box never overrides what the worker said about itself.
          const body = { pairing: pairingText }
          if (pairingCwd.trim() !== '') body.cwd = pairingCwd.trim()
          await call('worker.pair', body)
          // Clear the field on success: the string is a live credential and there is no reason
          // to leave it sitting in a form.
          setPairingText('')
          setPairingCwd('')
          setPairingOpen(false)
          setStatus({ kind: 'ok', text: t('pairDone') })
          await refresh()
        } catch (error) {
          setStatus({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }, [call, refresh, pairingText, pairingCwd, t])

      /**
       * Like `call`, but returns the body instead of throwing on a non-ok reply.
       *
       * The arming gate answers 409 with a LIST of blockers -- "the sandbox does not contain
       * this machine" plus "that address is not on this machine" -- and `call`'s throw would
       * reduce that to a single message, hiding the rest of what the operator has to fix.
       */
      const callRaw = React.useCallback(async (action, payload) => {
        const response = await fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...(payload ?? {}) }),
        })
        const data = await response.json().catch(() => null)
        if (data === null) return { ok: false, error: `HTTP ${response.status}` }
        return data
      }, [])

      const onRoleCheck = React.useCallback(async (request) => {
        setBusy('role-check')
        try {
          return await callRaw('worker.preflight', request)
        } finally {
          setBusy('')
        }
      }, [callRaw])

      const onRoleArm = React.useCallback(async (request) => {
        setBusy('role-arm')
        try {
          const result = await callRaw('worker.arm', request)
          // Re-read either way: a refusal updates the probe verdict, a success the state.
          await refresh()
          return result
        } finally {
          setBusy('')
        }
      }, [callRaw, refresh])

      const onRoleDisarm = React.useCallback(async (opts) => {
        setBusy('role-disarm')
        try {
          await callRaw('worker.disarm', opts ?? {})
          await refresh()
        } finally {
          setBusy('')
        }
      }, [callRaw, refresh])

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

      /**
       * Cache housekeeping for one worker, and the one place the cached byte budget can be set.
       *
       * WHY THIS WRITES THE SETTING FROM A PER-WORKER BUTTON: the threshold is global (one value
       * governs every worker, on both the host and the worker side) while the buttons are per
       * worker, because that is where the usage is shown. So an Apply from any card writes the
       * shared setting -- and the page says so in the field hint rather than leaving the operator
       * to discover that setting a limit on one worker changed all of them.
       *
       * The save is sent only when the value actually changed: an Apply that re-sends the same
       * number would rewrite the settings file and, worse, trip the policy stamp that rebuilds
       * every worker on every card.
       */
      const onCache = React.useCallback(async (peerId, scope, op, maxBytes) => {
        const saved = Number(snapshot?.settings?.shotCacheBytes ?? 0)
        const body = { peerId, scope, op, maxBytes }
        const data = await call('cache', body)
        let message = ''
        const written = Number.isFinite(data?.result?.removed) ? Number(data.result.removed) : 0
        const freed = formatBytes(Number(data?.result?.freedBytes ?? 0))
        const sideName = scope === 'worker' ? t('labelCacheWorker') : t('labelCacheHost')
        if (op === 'clear') {
          message = written === 0
            ? fmt(t('cacheClearNothing'), { scope: sideName })
            : fmt(t('cacheCleared'), { scope: sideName, n: written, size: freed })
        } else if (data?.supported === false) {
          message = t('cacheUnsupported')
        } else if (written === 0) {
          message = fmt(t('cacheWithinBudget'), { scope: sideName })
        } else {
          message = fmt(t('cachePruned'), { scope: sideName, n: written, size: freed })
        }
        // Persist the threshold when it is new. This reuses the settings route so the value lands
        // in the same file, with the same precedence, as every other setting.
        if (maxBytes !== saved) {
          await call('settings.save', { settings: { shotCacheBytes: maxBytes } })
        }
        await refresh()
        return { ...data, message }
      }, [call, refresh, snapshot, t])

      const onStopAll = React.useCallback(async () => {
        setBusy('stop')
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
      const approvals = snapshot?.approvals ?? { available: false, pending: [], recent: [], missed: [], missedCount: 0, timeoutMs: 0 }
      const pending = Array.isArray(approvals.pending) ? approvals.pending : []
      // Refusals nobody answered. Read from the HOST, which derives them from the append-only
      // trail, so they survive a restart; the queue's in-memory history would not.
      const missed = Array.isArray(approvals.missed) ? approvals.missed : []
      const missedCount = Number.isFinite(Number(approvals.missedCount)) ? Number(approvals.missedCount) : missed.length
      const audit = snapshot?.audit ?? { available: false, path: '', error: '', recent: [] }
      const recentAudit = Array.isArray(audit.recent) ? audit.recent : []
      // The trail is ONE append-only ledger of everything that happened, but the panel's table is
      // shaped for decisions (tier, option, who ruled). A transfer row has none of those fields, so
      // feeding it to that table renders a row of dashes under a "decisions" heading -- a silent
      // misreport of the kind this project keeps finding. Two kinds, two tables.
      const approvalRows = recentAudit.filter((row) => row?.kind !== 'transfer')
      const transferRows = recentAudit.filter((row) => row?.kind === 'transfer')

      // Refusals that were never seen. Kept in the SAME group as the live requests on purpose: the
      // operator's question after "why did that task fail?" is "was I asked?", and a list one group
      // further down with no heading of its own does not answer it.
      const missedBlock = missed.length === 0 ? null : h('div', { className: 'ru-missed' },
        h('p', { className: 'ru-note warn' }, fmt(t('approvalsMissed'), { n: missedCount })),
        h('p', { className: 'ru-note dim' }, t('approvalsMissedNote')),
        h('div', { className: 'ru-scroll' },
          h('table', { className: 'ru-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('colSettled')),
              h('th', null, t('colTool')),
              h('th', null, t('colTier')),
              h('th', null, t('colWaited')),
              h('th', null, t('colWorker')))),
            h('tbody', null, missed.map((row, index) => h('tr', { key: `${String(row.at)}-${index}` },
              h('td', { className: 'ru-mono ru-dim' }, formatTime(row.at)),
              h('td', { className: 'ru-mono' }, String(row.toolName ?? '\u2014')),
              h('td', null, shownTier(row)),
              h('td', null,
                `${Math.round(Number(row.waitedMs ?? 0) / 1000)}s `,
                h('span', { className: 'ru-dim' }, describeBy(row.by))),
              h('td', null, String(row.peerId ?? ''))))))))

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
            h('span', { className: 'ru-note' }, t('roleNote'))),
          // The switch itself is per session, and this page has no session identity -- so it
          // reports the state and names the real control rather than offering a toggle it
          // could not actually drive.
          snapshot === null
            ? null
            : h('div', { className: 'ru-kv', style: { marginTop: '6px' } },
              h('span', { className: 'ru-k' }, t('fieldSessions')),
              h('span', { className: 'ru-v' },
                Number(snapshot?.settings?.sessionsEnabled ?? 0) > 0
                  ? fmt(t('sessionsOn'), { n: Number(snapshot.settings.sessionsEnabled) })
                  : t('sessionsNone'))),
          snapshot === null
            ? null
            : h('p', { className: 'ru-note dim' },
              fmt(t('switchHint'), { cmd: String(snapshot?.settings?.enableCommand ?? '/remote-use on') })),

          // The worker role. Rendered only once a snapshot exists: showing "not accepting remote
          // driving" while the state is still unknown would be a claim the page cannot support.
          snapshot === null
            ? null
            : h(WorkerRolePanel, {
              t,
              role: snapshot?.settings?.workerRole ?? null,
              busy,
              onPreflight: onRoleCheck,
              onArm: onRoleArm,
              onDisarm: onRoleDisarm,
            })),

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
                onCache: (scope, op, maxBytes) => onCache(row.peerId, scope, op, maxBytes),
                // The saved ceiling, so the field opens on what is actually in force rather than
                // on the schema default. The snapshot's settings block is the post-merge truth.
                cacheMaxBytes: Number(snapshot?.settings?.shotCacheBytes ?? 0),
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
            // The shortcut past the form. It sits beside "add" because that is the same job:
            // one paste instead of a url and a bearer token typed off another machine's screen.
            h('button', {
              type: 'button', className: 'ru-btn', disabled: anyBusy || editing !== null,
              onClick: () => setPairingOpen((open) => !open),
            }, t('btnPair')),
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
            }, busy === 'all' ? t('busy') : t('btnAll'))),

          // The shortcut past the form: one paste instead of a url and a bearer token typed by
          // hand off another machine's screen.
          pairingOpen ? h('div', { className: 'ru-card', style: { marginTop: '10px' } },
            h('label', { className: 'ru-field' },
              h('span', { className: 'ru-field-label' }, t('fieldPairing')),
              h('textarea', {
                className: 'ru-input ru-textarea',
                rows: '3',
                placeholder: t('fieldPairingPlaceholder'),
                value: pairingText,
                onChange: (event) => setPairingText(event.target.value),
              }),
              h('span', { className: 'ru-field-hint' }, t('fieldPairingHint'))),
            // Inert in the normal case: a current worker puts its task directory in the string.
            // It exists so that a string WITHOUT one is not a dead end -- pairing is refused when
            // neither supplies a directory, and this is where the operator supplies it.
            h('label', { className: 'ru-field' },
              h('span', { className: 'ru-field-label' }, t('fieldPairingCwd')),
              h('input', {
                className: 'ru-input ru-mono',
                placeholder: 'C:\\dsh-remote\\work',
                value: pairingCwd,
                onChange: (event) => setPairingCwd(event.target.value),
              }),
              h('span', { className: 'ru-field-hint' }, t('fieldPairingCwdHint'))),
            h('div', { className: 'ru-actions' },
              h('button', {
                type: 'button', className: 'ru-btn primary',
                disabled: anyBusy || pairingText.trim() === '',
                onClick: () => void onPair(),
              }, busy === 'pair' ? t('busy') : t('btnPairSave')),
              h('button', {
                type: 'button', className: 'ru-btn',
                disabled: anyBusy,
                onClick: () => { setPairingOpen(false); setPairingText(''); setPairingCwd('') },
              }, t('btnCancel')))) : null),

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
                })),
              missedCount === 0 ? null : clearControls(t, clearState),
              missedBlock)),

        h('div', { className: 'ru-group' },
          h('h3', { className: 'ru-group-title' }, t('groupAudit')),
          audit.available !== true
            ? h('p', { className: 'ru-note dim' }, t('auditNote', { p: '\u2014' }))
            : h('div', null,
              h('p', { className: 'ru-note dim' }, fmt(t('auditNote'), { p: String(audit.path ?? '') })),
              // Where the trail stands against its cap. A limit the operator cannot see is
              // indistinguishable from no limit, which is how this one went unnoticed for so long.
              h('p', { className: 'ru-note dim' }, fmt(t('auditUsage'), {
                size: formatBytes(audit.bytes),
                max: Number(audit.maxBytes) > 0 ? formatBytes(audit.maxBytes) : t('auditUnbounded'),
                keep: Number(audit.keepFiles) < 0 ? t('auditUnbounded') : String(audit.keepFiles ?? 0),
                n: String(Array.isArray(audit.archives) ? audit.archives.length : 0),
              })),
              audit.error === '' ? null : h('p', { className: 'ru-note warn' }, String(audit.error)),
              approvalRows.length === 0
                ? h('p', { className: 'ru-note' }, t('auditNone'))
                : h('div', { className: 'ru-scroll' },
                  h('table', { className: 'ru-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, t('colStarted')),
                      h('th', null, t('colTool')),
                      h('th', null, t('colTier')),
                      h('th', null, t('colState')),
                      h('th', null, t('colWorker')))),
                    h('tbody', null, approvalRows.map((row, index) => h('tr', { key: `${String(row.at)}-${index}` },
                      h('td', { className: 'ru-mono ru-dim' }, formatTime(row.at)),
                      h('td', { className: 'ru-mono' }, String(row.toolName ?? '\u2014')),
                      h('td', null, shownTier(row)),
                      h('td', null,
                        h('span', {
                          className: row.optionId === 'allow-once' ? 'ru-badge ok' : 'ru-badge',
                        }, String(row.optionId ?? '')),
                        ' ',
                        h('span', { className: 'ru-dim' }, fmt(t('auditBy'), { by: describeBy(row.by) }))),
                      h('td', null, String(row.peerId ?? ''))))))))),

        // File movement is a durable write on another machine's disk, so it belongs in the ledger --
        // but it is not a decision, and it gets its own columns rather than being dressed as one.
        h('div', { className: 'ru-group' },
          h('h3', { className: 'ru-group-title' }, t('groupTransfers')),
          transferRows.length === 0
            ? h('p', { className: 'ru-note' }, t('noTransfers'))
            : h('div', { className: 'ru-scroll' },
              h('table', { className: 'ru-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('colStarted')),
                  h('th', null, t('colDirection')),
                  h('th', null, t('colPath')),
                  h('th', null, t('colSize')),
                  h('th', null, t('colWorker')))),
                h('tbody', null, transferRows.map((row, index) => h('tr', { key: `${String(row.at)}-t-${index}` },
                  h('td', { className: 'ru-mono ru-dim' }, formatTime(row.at)),
                  h('td', null, row.direction === 'send' ? t('transferSent') : t('transferFetched')),
                  h('td', { className: 'ru-mono' },
                    String(row.direction === 'send' ? (row.remotePath ?? '') : (row.localPath ?? ''))),
                  h('td', { className: 'ru-mono' }, formatBytes(Number(row.bytes ?? 0))),
                  h('td', null, String(row.peer ?? '')))))))),

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

    // ---- approval surfaces: session header, composer dock, right-pane tab --------------
    //
    // WHY NOT THE SETTINGS PAGE ALONE: it is closed by default, and opening it takes the operator
    // away from their work. Measured 2026-10-14: six approval requests expired unanswered and the
    // only sign of them was behind a gear icon nobody had a reason to open.
    //
    // WHY ONE FEED AND NOT THREE POLLERS: all three surfaces read the same snapshot, so three
    // timers would triple the traffic for one fact. `createApprovalFeed` polls once and pushes to
    // whoever subscribed; a surface stays dormant until it has a subscriber.
    //
    // SLOT CHOICE IS CONSTRAINED, NOT COSMETIC: `conversation.input.permission` and
    // `sidebar.toggle.badge` are both `kind: "single"` and already owned by DSH's own plugins (the
    // permission selector, the desktop-update badge), so registering there would DISPLACE
    // first-party UI. Every slot used below is `list` or `keyed`, where coexistence is the design.

    /** The shared poller behind every approval surface. @param {{ get: Function }} io */
    function createApprovalFeed(io, intervalMs = 2500) {
      let state = { ready: false, available: false, pending: [], missed: [], missedCount: 0, timeoutMs: 0, auditPath: '', error: '' }
      const listeners = new Set()
      let timer
      const publish = () => { for (const listener of [...listeners]) listener(state) }
      const refresh = async () => {
        try {
          const data = await io.get()
          const approvals = data?.approvals ?? {}
          state = {
            ready: true,
            available: approvals.available === true,
            pending: Array.isArray(approvals.pending) ? approvals.pending : [],
            missed: Array.isArray(approvals.missed) ? approvals.missed : [],
            missedCount: Number(approvals.missedCount ?? 0),
            timeoutMs: Number(approvals.timeoutMs ?? 0),
            // Read from the SAME snapshot the counts come from. The pane used to take this as an
            // owner prop, and the framework never passed one, so "the record is also at <path>"
            // was dead text on the one surface that shows it (F30).
            auditPath: typeof data?.audit?.path === 'string' ? data.audit.path : '',
            error: '',
          }
        } catch (error) {
          state = { ...state, ready: true, error: error instanceof Error ? error.message : String(error) }
        }
        publish()
      }
      const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined } }
      return {
        current: () => state,
        subscribe(listener) {
          listeners.add(listener)
          // LAZY, and this is not an optimisation. Starting the timer in `apply()` left a live
          // interval behind that nothing owned: the unit tests never exited, and an app with no
          // surface mounted would poll a route forever for nobody. The first subscriber is exactly
          // when the data starts to matter.
          if (listeners.size === 1 && typeof setInterval === 'function') {
            timer = setInterval(() => void refresh(), intervalMs)
            void refresh()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stop()
          }
        },
        refresh,
        dispose() { listeners.clear(); stop() },
      }
    }

    /**
     * Read the feed as component state.
     *
     * `enabled = false` releases the subscription instead of reading it, which matters because the
     * feed's timer is refcounted: a pane body that is mounted but NOT visible (a background Session,
     * or a collapsed column) would otherwise be the one subscriber holding a poll open for a surface
     * nobody is looking at. The pane passes `tab.visible` here.
     */
    function useApprovals(feed, enabled = true) {
      const [state, setState] = React.useState(feed.current())
      React.useEffect(() => {
        if (enabled === false) return undefined
        setState(feed.current())
        return feed.subscribe(setState)
      }, [feed, enabled])
      return state
    }

    /** Allow/deny one request. Shared, so no two surfaces can disagree about the outcome. */
    function useDecide(feed, post) {
      const [busyId, setBusyId] = React.useState('')
      const [error, setError] = React.useState('')
      const decide = React.useCallback(async (id, decision) => {
        setBusyId(id)
        setError('')
        try {
          // `via` is what makes the audit read "a person clicked". It is EVIDENCE, not a boundary
          // -- any caller can claim it -- but the alternative was measured dead in this app's own
          // transport: the click arrived without a usable Origin and was recorded as `api` (F22).
          await post('approvals.decide', { id, decision, via: 'page' })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusyId('')
          await feed.refresh()
        }
      }, [feed, post])
      return { busyId, error, decide }
    }

    /**
     * Clear the operator-facing record of missed requests.
     *
     * WHAT THIS DOES NOT DO, deliberately: delete rows from the trail. The file is append-only
     * evidence, and the one thing an audit trail must never do is quietly lose the record of
     * something that happened. Clearing appends a watermark row instead -- so the miss list resets
     * to empty while the file keeps every row AND keeps the fact that the operator cleared the
     * view, and by which route. Rows are never removed; only the view's starting point moves.
     *
     * @param {(action: string, payload?: object) => Promise<object>} post
     * @param {() => Promise<unknown>} refresh re-read whatever snapshot this surface renders
     */
    function useClear(post, refresh) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [done, setDone] = React.useState('')
      const clear = React.useCallback(async () => {
        setBusy(true)
        setError('')
        setDone('')
        try {
          // Same provenance claim as the decision buttons: this is a person pressing a button.
          const data = await post('approvals.clear', { via: 'page' })
          setDone(String(data?.cleared ?? 0))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
          await refresh()
        }
      }, [post, refresh])
      return { busy, error, done, clear }
    }

    /** The tier being ASKED for: the request first, the inferred minimum only as a fallback. */
    function shownTier(row) {
      const requested = String(row?.requestedTier ?? '')
      return requested !== '' ? requested : String(row?.requiredTier ?? '?')
    }

    /** The `by` vocabulary in words, for the record list. */
    function byWords(t, by) {
      if (by === 'page') return t('auditByPage')
      if (by === 'api') return t('auditByApi')
      if (by === 'timeout') return t('auditByTimeout')
      if (by === 'disposed') return t('auditByDisposed')
      if (by === 'human') return t('auditByHuman')
      return String(by ?? '')
    }

    /**
     * The tier being ASKED for: the request first, the inferred minimum only as a fallback.
     *
     * Stated once, at the top of these surfaces, because this field is what the 0.2.4 fix was
     * about: a request for the unrestricted tier used to display the minimum that would do.
     */
    function shownTier(row) {
      const requested = String(row?.requestedTier ?? '')
      return requested !== '' ? requested : String(row?.requiredTier ?? '?')
    }

    /** Who is asking, and for which task. */
    function whoLine(row) {
      const task = String(row.taskId ?? '')
      return `${String(row.peerId ?? '')}${task === '' ? '' : ` \u00b7 ${task}`}`
    }

    /** How long is left, in mono so the digits do not jitter as they tick. */
    function countdown(t, row, timeoutMs) {
      const left = Math.max(0, Math.round((Number(timeoutMs) - Number(row.ageMs ?? 0)) / 1000))
      return h('span', { className: 'ru-count' }, fmt(t('approvalsLeft'), { s: left }))
    }

    /** Both decisions, in one place so no surface can offer a different pair. */
    function decideButtons(t, id, busyId, onDecide) {
      return [
        h('button', {
          type: 'button', className: 'ru-btn primary', disabled: busyId !== '',
          onClick: () => void onDecide(id, 'allow'),
        }, t('btnAllowShort')),
        h('button', {
          type: 'button', className: 'ru-btn', disabled: busyId !== '',
          onClick: () => void onDecide(id, 'deny'),
        }, t('btnDenyShort')),
      ]
    }

    /**
     * The "clear the missed list" control, shared by the pane and the Settings page.
     *
     * The note is not decoration: without it the button reads as "delete the record", and the
     * operator would reasonably expect the file to shrink. It does not -- see `useClear`.
     */
    function clearControls(t, clearState) {
      const { busy, error, done, clear } = clearState
      return h('div', { className: 'ru-clear' },
        h('button', {
          type: 'button', className: 'ru-btn', disabled: busy,
          onClick: () => void clear(),
        }, busy ? t('btnClearing') : t('btnClearMissed')),
        h('span', { className: 'ru-note dim' }, t('clearMissedNote')),
        done === '' ? null : h('span', { className: 'ru-note' }, fmt(t('clearedMissed'), { n: done })),
        error === '' ? null : h('span', { className: 'ru-note warn' }, error))
    }

    /**
     * The composer dock: one quiet strip per request, two lines each.
     *
     * WHY IT IS NOT THE PANEL IN MINIATURE: this strip sits directly above the input, so every pixel
     * it takes is taken from writing. Line one answers "what is this?", line two answers "what do I
     * do?" -- the reason and the arguments a decision may need stay in the panel, one click away.
     */
    function dockRows(t, pending, busyId, onDecide, timeoutMs) {
      return pending.map((row) => {
        const id = String(row.id ?? '')
        return h('div', { className: 'ru-dock-row', key: id },
          h('div', { className: 'ru-dock-main' },
            h('span', { className: 'ru-tool' }, String(row.toolName ?? '?')),
            h('span', { className: 'ru-tier' }, shownTier(row))),
          h('span', { className: 'ru-dock-who' }, whoLine(row)),
          h('div', { className: 'ru-dock-actions' },
            countdown(t, row, timeoutMs),
            ...decideButtons(t, id, busyId, onDecide)))
      })
    }

    /** The panel rows: the same facts, plus the reason and the arguments. */
    function approvalRows(props) {
      const { t, pending, busyId, onDecide, timeoutMs } = props
      return pending.map((row) => {
        const id = String(row.id ?? '')
        return h('div', { className: 'ru-row', key: id },
          h('div', { className: 'ru-row-main' },
            h('span', { className: 'ru-tool' }, String(row.toolName ?? '?')),
            h('span', { className: 'ru-tier' }, shownTier(row)),
            h('span', { className: 'ru-dim' }, whoLine(row))),
          countdown(t, row, timeoutMs),
          h('p', { className: 'ru-why' }, String(row.reason ?? '')),
          row.rawInput === '' ? null : h('pre', { className: 'ru-args' }, String(row.rawInput)),
          h('div', { className: 'ru-row-actions' }, ...decideButtons(t, id, busyId, onDecide)))
      })
    }

    /** Right above the composer: the operator is already looking here. */
    function ApprovalsDock(props) {
      const { t, feed, post } = props
      const state = useApprovals(feed)
      const { busyId, error, decide } = useDecide(feed, post)
      if (state.pending.length === 0) return null
      return h('div', { className: 'ru-dock', role: 'status', 'aria-live': 'polite' },
        ...dockRows(t, state.pending, busyId, decide, state.timeoutMs),
        error === '' ? null : h('p', { className: 'ru-note warn' }, error))
    }

    /** Session header: quiet while nothing waits, and the way into the panel. */
    function ApprovalsHeaderButton(props) {
      const { t, feed, openPanel } = props
      const state = useApprovals(feed)
      const pending = state.pending.length
      if (pending === 0 && state.missedCount === 0) return null
      // The beacon appears ONLY while a worker is actually stuck. A record of past misses is worth
      // keeping reachable, not worth shouting about in every session forever.
      const children = pending > 0
        ? [h('span', { className: 'ru-beacon' }), h('span', null, fmt(t('approvalsHeaderPending'), { n: pending }))]
        : [h('span', null, fmt(t('approvalsHeaderMissed'), { n: state.missedCount }))]
      return h('button', {
        type: 'button',
        className: `ru-hdrbtn${pending > 0 ? ' pending' : ''}`,
        title: t('approvalsOpenPanel'),
        onClick: () => openPanel(),
      }, ...children)
    }

    /**
     * The right pane: what waits now, and what was missed before.
     *
     * The body reads its own occurrence through the framework-injected `useTabInfo()` -- the
     * documented face for a pane body, which delivers `{ sidebar, panel, tab }`. Only `tab.visible`
     * is used here, and for a real reason: `tab.visible` is false for a background Session or a
     * collapsed column, and the feed's poll is refcounted, so an invisible pane must not subscribe.
     */
    function ApprovalsTab(props) {
      const { t, feed, post, useTabInfo } = props
      // The documented face for a pane body: it delivers `{ sidebar, panel, tab }`. REQUIRED, and a
      // missing one is thrown rather than tolerated -- a shell that does not inject it cannot render
      // this body, and the renderer's own entry boundary turns that into one dead pane instead of a
      // dead application. Degrading silently here would be worse: the visibility gate below would
      // stop working with nothing on screen to say so (F25).
      if (typeof useTabInfo !== 'function') {
        throw new Error('remote-use: the approvals pane body needs the framework-injected useTabInfo')
      }
      const { tab } = useTabInfo()
      const visible = tab === undefined || tab.visible !== false
      const state = useApprovals(feed, visible)
      const { busyId, error, decide } = useDecide(feed, post)
      const clearState = useClear(post, feed.refresh)
      const pendingBlock = state.pending.length === 0
        ? h('p', { className: 'ru-empty' }, t('approvalsPanelEmpty'))
        : h('div', null, ...approvalRows({ t, pending: state.pending, busyId, onDecide: decide, timeoutMs: state.timeoutMs }))
      const missedRows = state.missed.map((row, index) => h('div', { className: 'ru-record', key: `${String(row.at)}-${index}` },
        h('span', null, `${String(row.toolName ?? '?')} \u00b7 ${shownTier(row)} \u00b7 ${whoLine(row)} \u00b7 ${byWords(t, row.by)}`),
        h('span', { className: 'ru-record-when' }, new Date(row.at).toLocaleString())))
      const missedBlock = state.missed.length === 0
        ? h('p', { className: 'ru-empty' }, t('approvalsPanelNoMissed'))
        : h('div', null, ...missedRows)
      const auditNote = state.auditPath === ''
        ? null
        : h('p', { className: 'ru-why', style: { paddingTop: '12px' } }, fmt(t('approvalsPanelAlso'), { p: String(state.auditPath) }))
      return h('div', { className: 'ru-panel', 'data-ru-tab': tab?.id === undefined ? '' : String(tab.id) },
        h('div', { className: 'ru-panel-head' },
          h('h3', { className: 'ru-panel-title' }, t('approvalsPanelPendingTitle')),
          h('span', { className: 'ru-count' }, String(state.pending.length))),
        pendingBlock,
        error === '' ? null : h('p', { className: 'ru-note warn' }, error),
        h('div', { className: 'ru-panel-head' },
          h('h3', { className: 'ru-panel-title' }, t('approvalsPanelMissedTitle')),
          h('span', { className: 'ru-count' }, String(state.missedCount))),
        missedBlock,
        state.missedCount === 0 ? null : clearControls(t, clearState),
        auditNote)
    }

    /** The right-pane tab identity: an address pattern, a title, and how to recognise one. */
    const APPROVALS_TAB_ID = 'remote-use-approvals'
    const APPROVALS_RESOURCE = 'dsh-resource://remote-use-approvals'

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-remote-use: dictionaries')

      /**
       * The stylesheet must be GLOBAL, not a `<style>` inside the settings page's tree.
       *
       * MEASURED 2026-10-15: the three approval surfaces render in the session header, above the
       * composer and in the right pane -- all OUTSIDE the settings page -- so the `<style>` node
       * that lives in that page's tree never mounted for them. What the operator saw was unstyled
       * HTML that read as a design failure: `pwsh` touching its tier with no gap, no chip, and the
       * two-line grid collapsing into the host's own status line. The page keeps its own copy
       * (belt and braces); this one covers the chrome. Id-guarded, so two loads cannot stack sheets.
       */
      const STYLE_ID = 'dsh-plugin-remote-use-style'
      if (typeof document !== 'undefined' && document.getElementById(STYLE_ID) === null) {
        const sheet = document.createElement('style')
        sheet.id = STYLE_ID
        sheet.textContent = CSS
        document.head.appendChild(sheet)
        ctx.effect(() => () => { sheet.remove() }, 'dsh-plugin-remote-use: stylesheet')
      }

      // ---- the three approval surfaces, where the work happens --------------------------
      //
      // One GET and one POST, shared by the feed and every button, so all three surfaces talk to
      // the route the same way -- and so `via: 'page'` is asserted in exactly one place.
      const getSnapshot = async () => {
        const response = await fetch(ROUTE, { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      }
      const postRoute = async (action, payload) => {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload === undefined ? { action } : { action, ...payload }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || data?.ok === false) throw new Error(String(data?.error ?? `HTTP ${response.status}`))
        return data
      }
      const feed = createApprovalFeed({ get: getSnapshot })
      ctx.effect(() => () => feed.dispose(), 'dsh-plugin-remote-use: approval feed')

      /**
       * Register into a slot, and never let one registration take the application down.
       *
       * WHY THE try/catch IS NOT PARANOIA: `slots.register` THROWS on a contract violation -- a
       * `list` slot without `id`, a `keyed` slot without `key`, a name no parent declared -- and an
       * `apply()` that throws means this plugin's client bundle never loads. Measured 2026-10-14:
       * the DSH window on the worker would not start at all, because two registrations below were
       * missing `id` and the test stub had been accepting them. A surface that cannot be placed
       * must cost the operator that surface, not the application.
       *
       * @param {string} slot
       * @param {object} decl
       * @param {Function} component
       */
      const registerSlot = (slot, decl, component) => {
        ctx.slots.inject(slot, () => {
          try {
            ctx.slots.register(decl, component)
          } catch (error) {
            console.warn(`[remote-use] could not register into "${slot}":`, error)
          }
        })
      }

      // THE SEAT, and why it is this one (measured 2026-10-15, not guessed).
      //
      // `conversation.input.dock` is a `list` slot rendered as a FULL-WIDTH row directly above the
      // input bar, and it is the seat DSH's own first-party strips use for exactly this shape:
      // `todo` (order 0), `goal` (order 10), the queued-message dock `queue` (order 20). The input
      // bar itself is the next sibling, so `order: 30` puts this strip immediately above it.
      //
      // The previous seat was `conversation.composer.dock`, which is NOT a strip position: it
      // renders inside the composer's STATUS line, the same flex row as the context meter and the
      // activity readout. A `list` entry there is one more inline item, so its position drifted with
      // the row's width and it inherited the status line's typography -- the operator saw it sitting
      // between "cache hit" and "context share", then saw its reason wrapped one word per line (F28).
      //
      // `conversation.composer` (the `chain` seat DSH's own approval prompt uses) was the other
      // candidate and is WRONG here: its owner renders it with `overlay: true`, and an elected chain
      // entry is drawn with the fallback set to `display: none` -- that fallback IS the composer bar,
      // so electing there would hide the input box for as long as a remote request waits.
      registerSlot('conversation.input.dock', {
        name: 'conversation.input.dock',
        // A `list` slot is keyed by id; without one the real service throws (PITFALLS F24).
        id: 'remote-use-approvals',
        order: 30,
        locale: NS,
      }, (props) => h(ApprovalsDock, { ...props, feed, post: postRoute }))

      registerSlot('conversation.session.header.actions', {
        name: 'conversation.session.header.actions',
        id: 'remote-use-approvals',
        locale: NS,
      }, (props) => h(ApprovalsHeaderButton, { ...props, feed, openPanel: () => openApprovalsPane() }))

      // The panel is optional on purpose. `sidebarRightTabs`/`sidebarRight` are first-party
      // services; on a shell that lacks them the dock and the header button still work, so a
      // missing pane must not take the rest of the plugin down with it. Neither is listed in
      // `inject`: requiring them would stop `apply` from running at all on such a shell.
      //
      // `openResource(address)` is the documented navigation controller -- "every way into the
      // column calls one of them". It replaced `openResourceIn`, which the docs mark as NOT part of
      // the public face (F27). The temporary probe that reported this click's internals to the audit
      // trail has been removed now that the public path is confirmed working; the reasoning it
      // produced is recorded in docs/PITFALLS.md rather than kept in the shipping path.
      function openApprovalsPane() {
        const controller = ctx.get('sidebarRight')
        if (controller === undefined || controller === null) return
        try {
          controller.openResource(`${APPROVALS_RESOURCE}/current`)
        } catch (error) {
          // Reported, never swallowed: a silent no-op is what made the first failed click
          // undiagnosable (F25).
          console.warn('[remote-use] could not open the approvals pane:', error)
        }
      }
      const sidebarRightTabs = ctx.get('sidebarRightTabs')
      if (sidebarRightTabs !== undefined) {
        ctx.effect(() => sidebarRightTabs.register({
          id: APPROVALS_TAB_ID,
          kind: 'remote-use-approvals',
          patterns: [`${APPROVALS_RESOURCE}/**`],
          // The documented bands are `extension` (a type from outside the product -- the highest,
          // and the default when none is named), `builtin` and `fallback`. This plugin IS a type
          // from outside the product, so `builtin` was the wrong seat (PITFALLS F27).
          priority: 'extension',
          // Recognises our own addresses, so another plugin's tab can never be hijacked by ours.
          canOpen: (address) => String(address).startsWith(APPROVALS_RESOURCE),
          title: () => t('approvalsPanel'),
          // THE PIECE THAT WAS MISSING, straight from the docs: the pane's DEFAULT PAGE follows the
          // number of registered guide entries -- one entry opens its page directly, zero or many
          // open the guide. A type with no entry contributes nothing to that decision, so the
          // operator had no way in from the pane itself. Picking a capsule calls
          // `openTab(entry.kind, { replaceTab: true })`, which is why the entry names its kind.
          guide: [{
            id: APPROVALS_TAB_ID,
            kind: 'remote-use-approvals',
            title: () => t('approvalsPanel'),
            description: () => t('approvalsOpenPanel'),
          }],
        }), 'dsh-plugin-remote-use: approvals tab type')
        registerSlot('sidebar.right.pane.tab', {
          name: 'sidebar.right.pane.tab',
          key: APPROVALS_TAB_ID,
          locale: NS,
        }, (props) => h(ApprovalsTab, { ...props, feed, post: postRoute }))
        registerSlot('sidebar.right.pane.tab.title', {
          name: 'sidebar.right.pane.tab.title',
          key: APPROVALS_TAB_ID,
          locale: NS,
        }, () => h('span', null, t('approvalsPanel')))
      }

      registerSlot('settings.section', {
        name: 'settings.section',
        // A slot/ledger id, and deliberately SHORT. Only the registration id at the top of this file
        // must equal the package name; section ids are conventionally short in DSH's own first-party
        // sections (`agent-presets`, `account`) and in working third-party plugins (`dsh-skins`).
        // Changing this one buys nothing and would churn the Settings nav identity.
        id: 'dsh-plugin-remote-use',
        // After the notification plugin's 40, so operator surfaces stay grouped together.
        order: 45,
        label: () => t('nav'),
        locale: NS,
      }, RemoteUseSection)
    }

    return { inject, apply }
  },
})
