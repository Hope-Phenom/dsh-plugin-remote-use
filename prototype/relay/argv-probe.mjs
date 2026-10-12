// argv-probe.mjs -- what actually reaches the child on Windows?
import { spawn } from 'node:child_process'

const DSH = 'C:\\Users\\worker\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'

function run(label, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    console.log(`\n=== ${label} ===`)
    console.log(`  cmd  = ${cmd}`)
    console.log(`  args = ${JSON.stringify(args)}`)
    let out = ''
    const c = spawn(cmd, args, { windowsHide: true, ...opts })
    c.stdout?.on('data', (d) => { out += d })
    c.stderr?.on('data', (d) => { out += d })
    c.on('error', (e) => { console.log(`  spawn error: ${e.message}`); resolve() })
    c.on('exit', (code) => {
      console.log(`  exit = ${code}`)
      console.log(`  output = ${JSON.stringify(out.trim().slice(0, 200))}`)
      resolve()
    })
    setTimeout(() => { try { c.kill() } catch {} ; resolve() }, 15000)
  })
}

// A: cmd.exe with a single command string (what the relay does now)
await run('A cmd.exe /c <quoted path> --profile acp', process.env.ComSpec || 'cmd.exe',
  ['/d', '/s', '/c', `"${DSH}" --profile acp`])

// B: invoke the .cmd directly with args array
await run('B spawn dsh.cmd directly', DSH, ['--profile', 'acp'])

// C: invoke the .cmd via shell:true
await run('C shell:true', `"${DSH}" --profile acp`, [], { shell: true })

// D: cmd.exe /c with 8.3 short path (no spaces)
await run('D cmd.exe /c shortpath', process.env.ComSpec || 'cmd.exe',
  ['/d', '/s', '/c', `C:\\Users\\worker\\AppData\\Local\\Programs\\DEEPSE~1\\resour~1\\runtime\\cli\\bin\\dsh.cmd --profile acp`])
