// 离线自测：用假 ctx 捕获 tools/pre-execute 监听器，逐条断言。
import plugin from './index.mjs'

function makeListeners(config = {}) {
  const listeners = []
  const ctx = {
    on(event, fn) { listeners.push({ event, fn }) },
    get() { return null },
    effect(fn) { try { fn() } catch {} },
  }
  // 默认关掉审计，避免离线测试往真实 $DSH_HOME 写日志；审计用例显式打开。
  plugin.apply(ctx, { auditLog: false, ...config })
  return {
    pre: listeners.find((l) => l.event === 'tools/pre-execute')?.fn,
    result: listeners.find((l) => l.event === 'tools/result')?.fn,
  }
}

function makeListener(config = {}) {
  return makeListeners(config).pre
}

let callSeq = 0
async function run(listener, tool, args) {
  let allowed = false
  callSeq += 1
  const exec = {
    name: tool,
    arguments: args,
    callId: `test-call-${callSeq}`,
    rootCallId: `test-call-${callSeq}`,
  }
  const res = await listener(exec, async () => {
    allowed = true
    return { kind: 'allow' }
  })
  return { denied: res?.kind === 'deny', allowed, reason: res?.reason ?? '', exec }
}

const main = makeListener()

const cases = [
  {
    label: '自动变量赋值 + rmdir /s /q "$home"',
    listener: main,
    tool: 'pwsh',
    args: { command: 'Start-Sleep -Seconds 2; $home = "C:\\Users\\Ansel\\AppData\\Local\\Temp\\x"; if (Test-Path $home) { cmd /c rmdir /s /q "$home" }' },
    expect: 'deny',
  },
  {
    label: '安全写法（$dshHome 命名 + 字面路径）',
    listener: main,
    tool: 'pwsh',
    args: { command: '$dshHome = "C:\\Users\\Ansel\\AppData\\Local\\Temp\\x"; if (Test-Path -LiteralPath $dshHome) { Write-Output "exists" }' },
    expect: 'allow',
  },
  {
    label: '递归删除参数带 $env:',
    listener: main,
    tool: 'pwsh',
    args: { command: 'Remove-Item -LiteralPath "$env:TEMP\\foo" -Recurse -Force' },
    expect: 'deny',
  },
  {
    label: '递归删除用户主目录（字面量）',
    listener: main,
    tool: 'pwsh',
    args: { command: "Remove-Item -LiteralPath 'C:\\Users\\Ansel' -Recurse -Force" },
    expect: 'deny',
  },
  {
    label: '递归删除 C:\\Users（主目录的祖先）',
    listener: main,
    tool: 'pwsh',
    args: { command: 'cmd /c rmdir /s /q "C:\\Users"' },
    expect: 'deny',
  },
  {
    label: '递归删除 Documents 本身',
    listener: main,
    tool: 'pwsh',
    args: { command: "Remove-Item -LiteralPath 'C:\\Users\\Ansel\\Documents' -Recurse -Force" },
    expect: 'deny',
  },
  {
    label: '递归删除 Documents 下子目录（放行）',
    listener: main,
    tool: 'pwsh',
    args: { command: "Remove-Item -LiteralPath 'C:\\Users\\Ansel\\Documents\\proj\\build' -Recurse -Force" },
    expect: 'allow',
  },
  {
    label: '命令开头有 $ErrorActionPreference，删除用字面路径（放行）',
    listener: main,
    tool: 'pwsh',
    args: { command: "$ErrorActionPreference='Continue'\nRemove-Item -LiteralPath 'C:\\Users\\Ansel\\AppData\\Local\\Temp\\guard-probe' -Recurse -Force" },
    expect: 'allow',
  },
  {
    label: '先赋值再删变量路径（deny）',
    listener: main,
    tool: 'pwsh',
    args: { command: "$p = 'C:\\Users\\Ansel\\AppData\\Local\\Temp\\x'\nRemove-Item -LiteralPath $p -Recurse -Force" },
    expect: 'deny',
  },
  {
    label: 'write 工具写入含 rmdir 的文档（放行：非 shell）',
    listener: main,
    tool: 'write',
    args: { file_path: 'C:\\x\\notes.md', content: 'cmd /c rmdir /s /q "$home"' },
    expect: 'allow',
  },
  {
    label: '普通读取命令（放行）',
    listener: main,
    tool: 'pwsh',
    args: { command: 'Get-ChildItem -LiteralPath C:\\Users\\Ansel\\Desktop | Select-Object -First 5' },
    expect: 'allow',
  },
  {
    label: 'bash 里 rm -rf "$HOME"',
    listener: main,
    tool: 'bash',
    args: { command: 'rm -rf "$HOME"' },
    expect: 'deny',
  },
]

// 自定义保护清单
const custom = makeListener({ protectedPaths: ['D:\\Projects\\keep', 'C:\\Data'] })
cases.push(
  {
    label: '自定义清单：目标正是保护项',
    listener: custom,
    tool: 'pwsh',
    args: { command: "Remove-Item -LiteralPath 'D:\\Projects\\keep' -Recurse -Force" },
    expect: 'deny',
  },
  {
    label: '自定义清单：目标的子目录（放行）',
    listener: custom,
    tool: 'pwsh',
    args: { command: "Remove-Item -LiteralPath 'D:\\Projects\\keep\\dist' -Recurse -Force" },
    expect: 'allow',
  },
  {
    label: '自定义清单：目标的祖先（deny）',
    listener: custom,
    tool: 'pwsh',
    args: { command: 'cmd /c rmdir /s /q "D:\\Projects"' },
    expect: 'deny',
  },
  {
    label: '自定义清单：其它盘路径（放行）',
    listener: custom,
    tool: 'pwsh',
    args: { command: "Remove-Item -LiteralPath 'E:\\temp\\build' -Recurse -Force" },
    expect: 'allow',
  },
)

const cases2 = []

// 脚本扫描：写入期 + 执行期
{
  const w = makeListener()
  cases2.push({
    label: '写 .ps1：正文含自动变量赋值 → 拒绝',
    listener: w,
    tool: 'write',
    args: { file_path: 'C:\\tmp\\clean.ps1', content: '$home = "C:\\x"\nRemove-Item -Recurse "$home"' },
    expect: 'deny',
  })
  cases2.push({
    label: '写 .ps1：正文含变量目标的递归删除 → 拒绝',
    listener: w,
    tool: 'write',
    args: { file_path: 'C:\\tmp\\build.ps1', content: 'Remove-Item -Recurse -Force $scratch' },
    expect: 'deny',
  })
  cases2.push({
    label: '写 .ps1：普通内容 → 放行',
    listener: w,
    tool: 'write',
    args: { file_path: 'C:\\tmp\\ok.ps1', content: 'Write-Output "hello"\nGet-ChildItem .' },
    expect: 'allow',
  })
  cases2.push({
    label: '写 .md：正文含删除字样 → 放行（非脚本）',
    listener: w,
    tool: 'write',
    args: { file_path: 'C:\\tmp\\notes.md', content: 'Remove-Item -Recurse -Force $scratch' },
    expect: 'allow',
  })
}

{
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = join(tmpdir(), 'dsh-guard-scan-test')
  mkdirSync(dir, { recursive: true })
  const bad = join(dir, 'bad.ps1')
  const good = join(dir, 'good.ps1')
  writeFileSync(bad, 'Remove-Item -Recurse -Force $target\n', 'utf8')
  writeFileSync(good, 'Write-Output "ok"\n', 'utf8')

  const e = makeListener()
  cases2.push({
    label: '执行脚本：-File 指向含变量删除的脚本 → 拒绝',
    listener: e,
    tool: 'pwsh',
    args: { command: `pwsh -NoProfile -File "${bad}"` },
    expect: 'deny',
  })
  cases2.push({
    label: '执行脚本：-File 指向干净脚本 → 放行',
    listener: e,
    tool: 'pwsh',
    args: { command: `pwsh -NoProfile -File "${good}"` },
    expect: 'allow',
  })
  cases2.push({
    label: '只读取脚本（Get-Content）→ 放行',
    listener: e,
    tool: 'pwsh',
    args: { command: `Get-Content -LiteralPath "${bad}"` },
    expect: 'allow',
  })

  const off = makeListener({ scanScriptExec: false, scanScriptWrites: false })
  cases2.push({
    label: '关闭脚本扫描后：执行同一脚本 → 放行',
    listener: off,
    tool: 'pwsh',
    args: { command: `pwsh -NoProfile -File "${bad}"` },
    expect: 'allow',
  })

  // 清理放在全部用例之后（见文件末尾），否则执行期用例读不到文件
}

// 逐条停用 + 旧格式兼容
{
  const offEntry = makeListener({ protectedPaths: [{ path: 'C:\\Data', enabled: false }] })
  cases2.push({
    label: '该条已停用：递归删除它 → 放行',
    listener: offEntry,
    tool: 'pwsh',
    args: { command: "Remove-Item -LiteralPath 'C:\\Data' -Recurse -Force" },
    expect: 'allow',
  })
  const onEntry = makeListener({ protectedPaths: [{ path: 'C:\\Data', enabled: true }] })
  cases2.push({
    label: '该条启用：同一条命令 → 拒绝',
    listener: onEntry,
    tool: 'pwsh',
    args: { command: "Remove-Item -LiteralPath 'C:\\Data' -Recurse -Force" },
    expect: 'deny',
  })
  const legacy = makeListener({ protectedPaths: ['C:\\Legacy'] })
  cases2.push({
    label: '旧版字符串数组按启用处理 → 拒绝',
    listener: legacy,
    tool: 'pwsh',
    args: { command: "Remove-Item -LiteralPath 'C:\\Legacy' -Recurse -Force" },
    expect: 'deny',
  })
}

let failed = 0
for (const c of cases) {
  const r = await run(c.listener, c.tool, c.args)
  const got = r.denied ? 'deny' : 'allow'
  const ok = got === c.expect
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.expect.padEnd(5)} -> ${got.padEnd(5)}  ${c.label}`)
  if (!ok && r.reason) console.log(`      reason: ${r.reason.slice(0, 140)}`)
}

// 跨平台/异常路径：只验证判定结果，监听器不会真的执行命令
{
  const tilde = makeListener()
  cases2.push({ label: '`rm -rf ~` 命中用户主目录', listener: tilde, tool: 'bash', args: { command: 'rm -rf ~' }, expect: 'deny' })

  // 全是别的平台的路径 → 回落到默认清单（fail-closed），C:\Users\Ansel 仍受保护
  const foreign = makeListener({ protectedPaths: ['/Users/bob/Documents', '/home/bob/Desktop'] })
  cases2.push({ label: '清单全是 POSIX 路径（当前 win32）→ 回落默认，主目录仍受保护', listener: foreign, tool: 'pwsh', args: { command: "Remove-Item -LiteralPath 'C:\\Users\\Ansel' -Recurse -Force" }, expect: 'deny' })

  // 显式清空 → 用户明确要求不做路径保护
  const empty = makeListener({ protectedPaths: [] })
  cases2.push({ label: '显式空清单 → 不做路径保护（放行）', listener: empty, tool: 'pwsh', args: { command: "Remove-Item -LiteralPath 'C:\\Users\\Ansel\\AppData\\Local\\Temp\\empty-list-probe' -Recurse -Force" }, expect: 'allow' })

  // Windows 上 `/s` 这类开关不会被误认成路径
  const flags = makeListener({ protectedPaths: ['C:\\Data'] })
  cases2.push({ label: 'rmdir /s /q 的开关不被当成 POSIX 路径', listener: flags, tool: 'pwsh', args: { command: 'cmd /c rmdir /s /q "D:\\scratch\\build"' }, expect: 'allow' })
}

for (const c of cases2) {
  const r = await run(c.listener, c.tool, c.args)
  const got = r.denied ? 'deny' : 'allow'
  const ok = got === c.expect
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.expect.padEnd(5)} -> ${got.padEnd(5)}  ${c.label}`)
  if (!ok && r.reason) console.log(`      reason: ${r.reason.slice(0, 140)}`)
}

// 频率熔断：窗口内 3 次，第 4 次拒绝
const limited = makeListener({ maxDeletesPerWindow: 3, windowSeconds: 60 })
const burst = []
for (let i = 0; i < 4; i++) {
  burst.push(await run(limited, 'pwsh', { command: `Remove-Item -LiteralPath 'C:\\Users\\Ansel\\AppData\\Local\\Temp\\f${i}.txt' -Force` }))
}
const burstOk = burst.slice(0, 3).every((r) => !r.denied) && burst[3].denied
if (!burstOk) failed++
console.log(`${burstOk ? 'PASS' : 'FAIL'}  熔断：3 次放行、第 4 次拒绝  [${burst.map((r) => (r.denied ? 'D' : 'A')).join('')}]`)

// 熔断关闭时不受影响
const noLimit = makeListener({ maxDeletesPerWindow: 0 })
let anyDenied = false
for (let i = 0; i < 8; i++) {
  const r = await run(noLimit, 'pwsh', { command: `Remove-Item -LiteralPath 'C:\\Users\\Ansel\\AppData\\Local\\Temp\\n${i}.txt' -Force` })
  if (r.denied) anyDenied = true
}
const offOk = !anyDenied
if (!offOk) failed++
console.log(`${offOk ? 'PASS' : 'FAIL'}  熔断关闭（0）：8 次均放行`)

// ---- 审计日志 -------------------------------------------------------------
{
  const auditFs = await import('node:fs')
  const auditOs = await import('node:os')
  const auditPath = await import('node:path')
  const auditRoot = auditFs.mkdtempSync(auditPath.join(auditOs.tmpdir(), 'dsh-guard-audit-'))
  const auditDir = auditPath.join(auditRoot, 'audit')
  const auditCfg = { auditLog: true, auditDir, auditRetentionDays: 30 }

  const readAudit = () => {
    let files = []
    try { files = auditFs.readdirSync(auditDir) } catch { return [] }
    const records = []
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue
      let text = ''
      try { text = auditFs.readFileSync(auditPath.join(auditDir, name), 'utf8') } catch { continue }
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue
        try { records.push(JSON.parse(line)) } catch {}
      }
    }
    return records
  }
  const checkAudit = (ok, label) => {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  }

  // 1. 拦截的递归删除：R3 + targets
  {
    const protectedDir = auditFs.mkdtempSync(auditPath.join(auditOs.tmpdir(), 'dsh-guard-protected-'))
    const { pre } = makeListeners({ ...auditCfg, protectedPaths: [protectedDir] })
    const cmd = "Remove-Item -LiteralPath '" + protectedDir + "' -Recurse -Force"
    const r = await run(pre, 'pwsh', { command: cmd })
    const rec = readAudit().find((x) => x.event === 'delete-intent' && x.rule === 'R3')
    checkAudit(r.denied && !!rec && rec.verdict === 'blocked' && rec.targets.length > 0, '审计：拦截的递归删除记录 R3 + 目标')
  }

  // 2. 放行的递归删除：allowed + recursive
  {
    const target = auditPath.join(auditRoot, 'allowed-probe')
    auditFs.mkdirSync(target, { recursive: true })
    const { pre } = makeListeners(auditCfg)
    const cmd = "Remove-Item -LiteralPath '" + target + "' -Recurse -Force"
    await run(pre, 'pwsh', { command: cmd })
    const rec = readAudit().find((x) => x.event === 'delete-intent' && x.verdict === 'allowed' && x.recursive === true && x.command === cmd)
    checkAudit(!!rec, '审计：放行的递归删除记录 allowed + recursive')
  }

  // 3. 放行的非递归删除：默认不记
  {
    const before = readAudit().filter((x) => x.event === 'delete-intent').length
    const file = auditPath.join(auditRoot, 'single.txt')
    const { pre } = makeListeners(auditCfg)
    const cmd = "Remove-Item -LiteralPath '" + file + "' -Force"
    await run(pre, 'pwsh', { command: cmd })
    const after = readAudit().filter((x) => x.event === 'delete-intent').length
    checkAudit(after === before, '审计：放行的非递归删除默认不记录')
  }

  // 4. 被拦截的自动变量赋值：即使不是递归删除也记
  {
    const { pre } = makeListeners(auditCfg)
    const cmd = '$' + 'home = "C:"'
    const r = await run(pre, 'pwsh', { command: cmd })
    const rec = readAudit().find((x) => x.event === 'delete-intent' && x.rule === 'R1')
    checkAudit(r.denied && !!rec && rec.verdict === 'blocked', '审计：被拦截的自动变量赋值也记录')
  }

  // 5. 被拦截的脚本写入：source/script
  {
    const { pre } = makeListeners(auditCfg)
    const scriptPath = auditPath.join(auditRoot, 'bad.ps1')
    const body = '$' + 'home = "C:"'
    const r = await run(pre, 'write', { file_path: scriptPath, content: body })
    const rec = readAudit().find((x) => x.event === 'delete-intent' && x.source === 'script-write')
    checkAudit(r.denied && !!rec && rec.rule === 'R1' && rec.script === scriptPath, '审计：被拦截的脚本写入记录 source/script')
  }

  // 6. 审计目录自保护：R7
  {
    const { pre } = makeListeners(auditCfg)
    const cmd = "Remove-Item -LiteralPath '" + auditDir + "' -Recurse -Force"
    const r = await run(pre, 'pwsh', { command: cmd })
    const rec = readAudit().find((x) => x.event === 'delete-intent' && x.rule === 'R7')
    checkAudit(r.denied && !!rec && rec.verdict === 'blocked', '审计：审计目录自保护 R7')
  }

  // 6b. 审计目录的祖先也受保护
  {
    const { pre } = makeListeners(auditCfg)
    const cmd = "Remove-Item -LiteralPath '" + auditRoot + "' -Recurse -Force"
    const r = await run(pre, 'pwsh', { command: cmd })
    const rec = readAudit().find((x) => x.event === 'delete-intent' && x.rule === 'R7')
    checkAudit(r.denied && !!rec, '审计：审计目录的祖先也受 R7 保护')
  }

  // 7. 日志目录不可写时，拦截仍然生效
  {
    const protectedDir = auditFs.mkdtempSync(auditPath.join(auditOs.tmpdir(), 'dsh-guard-protected2-'))
    const badDir = auditPath.join(auditRoot, 'not-a-dir')
    auditFs.writeFileSync(badDir, 'x')
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const { pre } = makeListeners({ auditLog: true, auditDir: badDir, protectedPaths: [protectedDir] })
      const cmd = "Remove-Item -LiteralPath '" + protectedDir + "' -Recurse -Force"
      const r = await run(pre, 'pwsh', { command: cmd })
      checkAudit(r.denied === true, '审计：日志写不进去时拦截仍然生效')
    } finally {
      console.warn = originalWarn
    }
  }

  // 8. 过期日志清理
  {
    const retentionDir = auditPath.join(auditRoot, 'retention')
    auditFs.mkdirSync(retentionDir, { recursive: true })
    const oldFile = auditPath.join(retentionDir, 'audit-2020-01-01.jsonl')
    auditFs.writeFileSync(oldFile, '{}\n')
    const old = new Date(Date.now() - 40 * 86400000)
    auditFs.utimesSync(oldFile, old, old)
    makeListeners({ auditLog: true, auditDir: retentionDir, auditRetentionDays: 30 })
    checkAudit(!auditFs.existsSync(oldFile), '审计：超过保留期的日志在启动时清理')
  }

  // 9. 放行后的结果记录
  {
    const { pre, result } = makeListeners(auditCfg)
    const target = auditPath.join(auditRoot, 'result-probe')
    const exec = {
      name: 'pwsh',
      callId: 'audit-result-1',
      rootCallId: 'audit-result-1',
      arguments: { command: "Remove-Item -LiteralPath '" + target + "' -Recurse -Force" },
    }
    await pre(exec, async () => ({ kind: 'allow' }))
    if (typeof result === 'function') result(exec, { isError: false, value: null, content: [] })
    const rec = readAudit().find((x) => x.event === 'delete-result' && x.callId === 'audit-result-1')
    checkAudit(!!rec && rec.isError === false && typeof rec.durationMs === 'number', '审计：放行的递归删除追加结果记录')
  }

  try { auditFs.rmSync(auditRoot, { recursive: true, force: true }) } catch {}
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)

try {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  fs.rmSync(path.join(os.tmpdir(), 'dsh-guard-scan-test'), { recursive: true, force: true })
} catch {}

process.exit(failed === 0 ? 0 : 1)
