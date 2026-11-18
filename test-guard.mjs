// 离线自测：用假 ctx 捕获 tools/pre-execute 监听器，逐条断言。
import plugin from './index.mjs'

function makeListener(config = {}) {
  const listeners = []
  const ctx = {
    on(event, fn) { listeners.push({ event, fn }) },
    get() { return null },
    effect(fn) { try { fn() } catch {} },
  }
  plugin.apply(ctx, config)
  return listeners.find((l) => l.event === 'tools/pre-execute').fn
}

async function run(listener, tool, args) {
  let allowed = false
  const res = await listener({ name: tool, arguments: args }, async () => {
    allowed = true
    return { kind: 'allow' }
  })
  return { denied: res?.kind === 'deny', allowed, reason: res?.reason ?? '' }
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
const cases2 = []
{
  const tilde = makeListener()
  cases2.push({ label: '`rm -rf ~` 命中用户主目录', listener: tilde, tool: 'bash', args: { command: 'rm -rf ~' }, expect: 'deny' })

  // 全是别的平台的路径 → 回落到默认清单（fail-closed），C:\Users\Ansel 仍受保护
  const foreign = makeListener({ protectedPaths: ['/Users/bob/Documents', '/home/bob/Desktop'] })
  cases2.push({ label: '清单全是 POSIX 路径（当前 win32）→ 回落默认，主目录仍受保护', listener: foreign, tool: 'pwsh', args: { command: "Remove-Item -LiteralPath 'C:\\Users\\Ansel' -Recurse -Force" }, expect: 'deny' })

  // 显式清空 → 用户明确要求不做路径保护
  const empty = makeListener({ protectedPaths: [] })
  cases2.push({ label: '显式空清单 → 不做路径保护（放行）', listener: empty, tool: 'pwsh', args: { command: "Remove-Item -LiteralPath 'C:\\Users\\Ansel' -Recurse -Force" }, expect: 'allow' })

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

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
