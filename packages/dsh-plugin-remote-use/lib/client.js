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
      noWorkers: '尚未配置工作节点。请在 profile 补丁中配置后重启。',
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
    }

    const en = {
      nav: 'Remote workers',
      title: 'Remote workers',
      description: 'Send GUI automation to paired workers instead of taking over this machine\u2019s mouse and keyboard. Availability, diagnostics and the emergency stop live here.',
      groupRole: 'This machine\u2019s role',
      roleMaster: 'Master',
      roleNote: 'This machine dispatches to workers. Switching it into worker mode (symmetric pairing) is not implemented yet.',
      groupWorkers: 'Workers',
      noWorkers: 'No workers configured. Add one to the profile patch and restart.',
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
    }

    const CSS = [
      '.ru-page{display:flex;flex-direction:column;gap:22px;max-width:760px;font-size:13px;line-height:1.5}',
      '.ru-head{display:flex;flex-direction:column;gap:4px}',
      '.ru-title{margin:0;font-size:16px;font-weight:500;line-height:1.4}',
      '.ru-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.ru-group{display:flex;flex-direction:column;border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:14px}',
      '.ru-group-title{margin:0 0 8px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.ru-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
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
    ].join('')

    /** Fill `{name}` placeholders. Kept local so the page does not depend on a t() option API. */
    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
      ))
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
      const { t, row, busy, onAction } = props
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
        h('span', { key: 'hint', className: 'ru-note' }, t('screenshotHint')),
      )

      return h('div', { className: 'ru-card' },
        h('div', { className: 'ru-card-head' }, head),
        h('div', { className: 'ru-kv' }, kv),
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

    function RemoteUseSection(props) {
      const { t } = props
      const [snapshot, setSnapshot] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [status, setStatus] = React.useState({ kind: 'idle', text: '' })

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

      return h('div', { className: 'ru-page' },
        h('style', null, CSS),
        h('div', { className: 'ru-head' },
          h('h2', { className: 'ru-title' }, t('title')),
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
          workers.length === 0
            ? h('p', { className: 'ru-note' }, t('noWorkers'))
            : h('div', {}, workers.map((row) => h(WorkerCard, {
              key: String(row.peerId),
              t,
              row,
              busy: busy === 'stop' ? 'stop' : (busy !== '' && busy !== 'stop' ? busy : ''),
              onAction: (action, peerId) => void onAction(action, peerId),
            }))),
          h('div', { className: 'ru-actions', style: { marginTop: '10px' } },
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
