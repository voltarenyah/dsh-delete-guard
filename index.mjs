// dsh-delete-guard — 在 shell 工具执行前检查删除命令的三道闸门。
//
// R1 自动变量：拒绝给 PowerShell 自动变量赋值（$home 就是只读的 $HOME，赋值只报
//    非终止错误，脚本继续，后续命令拿到的仍是用户主目录）。
// R2 变量目标：递归删除的参数区里出现 `$` 或 `%` 就拒绝——目标没有被证明是一个确定的路径。
// R3 保护路径：用户在设置页维护的路径清单，清单里的路径本身与其祖先不接受递归删除，
//    其下的子路径可以删（清理构建产物不受影响）。
// R4 频率熔断：滑动窗口内删除类命令超过阈值就拒绝，防止把一次递归删除拆成很多次单个删除。
//
// 设计取向：fail-closed 只发生在「删除」这一动作上；其余工具调用一律放行。
// 守卫自身任何异常都不阻断宿主工具面（catch 后放行）。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

const SHELL_TOOLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'zsh', 'shell', 'terminal', 'terminal_send', 'terminal_write', 'run_command', 'cmd', 'exec'])

/** 会被执行的脚本文件后缀。 */
const SCRIPT_EXT = /\.(ps1|psm1|sh|bash|zsh|cmd|bat|py|js|mjs|cjs|vbs)$/i

/** 命令里出现的脚本路径（带引号或不带，绝对或相对）。 */
const SCRIPT_TOKEN_RE = /(?:"([^"\r\n]+\.(?:ps1|psm1|sh|bash|zsh|cmd|bat|py|js|mjs|cjs|vbs))"|'([^'\r\n]+\.(?:ps1|psm1|sh|bash|zsh|cmd|bat|py|js|mjs|cjs|vbs))'|((?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|[^\s"'|<>;])[^\s"'|<>;]*\.(?:ps1|psm1|sh|bash|zsh|cmd|bat|py|js|mjs|cjs|vbs)))/gi

/** 看起来是在「执行」脚本：`-File x`、`& .\x.ps1`、`bash x.sh`、`cmd /c x.bat`、`node x.mjs`。 */
const SCRIPT_CALL_RES = [
  /-file\s+["']?([^"'\s|<>]+\.(?:ps1|psm1|sh|bash|zsh|cmd|bat|py|js|mjs|cjs|vbs))["']?/gi,
  /(?:^|[;&|(\n])\s*(?:&\s*)?["']?((?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/])[^"'\s|<>;]+\.(?:ps1|psm1|sh|bash|zsh|cmd|bat|py|js|mjs|cjs|vbs))["']?/gi,
  /(?:bash|sh|zsh|python|py|node|pwsh|powershell|cmd)(?:\.exe)?\s+(?:\/c\s+)?["']?([^"'\s|<>;]+\.(?:ps1|psm1|sh|bash|zsh|cmd|bat|py|js|mjs|cjs|vbs))["']?/gi,
]

/** 单个脚本最多读这么多字节；再大的不扫描（避免拖慢工具调用）。 */
const SCRIPT_SCAN_LIMIT = 256 * 1024

/** PowerShell 自动变量名（大小写不敏感）。 */
const AUTO_VARS = [
  'home', 'profile', 'pwd', 'input', 'args', 'host', 'pid', 'error', 'this', 'matches',
  'pshome', 'psscriptroot', 'myinvocation', 'lastexitcode', 'shellid', 'consolefilename',
  'stacktrace', 'executioncontext', 'nestedpromptlevel', 'pscommandpath', 'psboundparameters',
]

const ASSIGN_RE = new RegExp(`(?:^|[\\s;(])\\$(?:${AUTO_VARS.join('|')})\\s*=(?!=)`, 'i')

/** 递归删除的写法。 */
const RECURSIVE_RES = [
  /\brmdir\b[^\n|]*\/s\b/i,
  /\brd\b[^\n|]*\/s\b/i,
  /\bdel\b[^\n|]*\/s\b/i,
  /\berase\b[^\n|]*\/s\b/i,
  /\bremove-item\b[^\n|]*-recurse\b/i,
  /\bri\b[^\n|]*-recurse\b/i,
  /\brm\s+-[a-z]*[rf][a-z]*\b/i,
]

/** 删除类命令（含非递归）：只用于频率熔断计数。 */
const DELETE_RES = [
  ...RECURSIVE_RES,
  /\bremove-item\b/i,
  /\brmdir\b/i,
  /\brd\b\s/i,
  /\bdel\b\s/i,
  /\berase\b/i,
  /\brm\b\s/i,
  /\bunlink\b/i,
  /\brimraf\b/i,
]

const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'

/**
 * 路径字面量：引号串、`~` 开头、Windows 盘符/UNC、POSIX 绝对路径。
 * 具体接受哪些由 platformToken() 按当前平台过滤。
 */
const TOKEN_RE = /(?:"([^"\r\n]{2,300})"|'([^'\r\n]{2,300})'|(~[^\s"'|<>)]*|(?:[A-Za-z]:[\\/]|\\\\)[^\s"'|<>)]*|\/[^\s"'|<>)]+))/g

/** 单个字母的 `/x` 是命令行开关，不是路径。 */
const POSIX_FLAG_RE = /^\/[A-Za-z]$/

/** 这个字符串在当前平台上是不是一条可用的绝对路径。 */
function isAbsoluteForPlatform(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  return WIN ? /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) : p.startsWith('/')
}

/** 把一条候选 token 归一成当前平台的绝对路径；不是路径则返回 null。 */
function platformToken(raw) {
  let value = raw.trim()
  if (!value) return null

  // ~ / ~/xxx → 用户主目录
  if (value === '~' || /^~[\\/]/.test(value)) {
    const rest = value === '~' ? '' : value.slice(2)
    return rest ? join(homedir(), rest) : homedir()
  }

  if (WIN) {
    // Windows 上 `/s` `/q` 是开关，不是路径
    if (value.startsWith('/')) return null
    return isAbsoluteForPlatform(value) ? value : null
  }

  if (POSIX_FLAG_RE.test(value)) return null
  return isAbsoluteForPlatform(value) ? value : null
}

function norm(p) {
  let out
  try {
    out = resolve(p)
  } catch {
    return null
  }
  if (out.length > 3 && out.endsWith(sep)) out = out.slice(0, -1)
  return out.toLowerCase()
}

/** 前缀比较用的带分隔符形式；盘根 'c:\' 归一成 'c:' 后要补回分隔符。 */
function withSep(p) {
  return p.endsWith(sep) ? p : p + sep
}

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out)
  return out
}

/** 读取开关：volatile 字段是引用对象，必须每次调用时取值，改动才能即时生效。 */
function flag(config, name, fallback) {
  const raw = config ? config[name] : undefined
  if (raw && typeof raw.get === 'function') {
    try {
      const current = raw.get()
      return typeof current === 'boolean' ? current : fallback
    } catch {
      return fallback
    }
  }
  return typeof raw === 'boolean' ? raw : fallback
}

/** 读取数组型配置（volatile 或普通都兼容）；不是数组时返回 null，用于区分「没配」与「配成空」。 */
function listOf(config, name) {
  const raw = config ? config[name] : undefined
  let value = raw
  if (raw && typeof raw.get === 'function') {
    try {
      value = raw.get()
    } catch {
      return null
    }
  }
  if (!Array.isArray(value)) return null
  return value.filter((v) => typeof v === 'string' && v.trim().length > 0)
}

/** 读取数值型配置。 */
function number(config, name, fallback) {
  const raw = config ? config[name] : undefined
  let value = raw
  if (raw && typeof raw.get === 'function') {
    try {
      value = raw.get()
    } catch {
      value = fallback
    }
  }
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 默认保护清单。
 *
 * 规则是「清单项本身 + 它的祖先」都拒绝递归删除，所以祖先不需要单独列：
 * 列出 C:\Users\<name> 之后，删 C:\Users、C:\ 同样会被拒。
 * 反过来，清单项下面的子目录不受保护（否则整个用户目录都不能清理），
 * 所以 Desktop/Documents/... 这些需要各自列出。
 */
function defaultProtectedPaths() {
  const home = homedir()
  const out = [home]

  if (WIN) {
    for (const key of ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
      if (process.env[key]) out.push(process.env[key])
    }
  } else if (MAC) {
    out.push('/Applications', '/System', '/Library', '/usr', '/bin', '/sbin', '/etc')
  } else {
    out.push('/etc', '/usr', '/bin', '/sbin', '/lib', '/boot')
  }

  out.push(process.env.DSH_HOME || join(home, '.dsh'))

  const names = MAC
    ? ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music']
    : ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive']
  for (const name of names) out.push(join(home, name))

  const seen = new Set()
  const result = []
  for (const p of out) {
    if (!p) continue
    const n = norm(p)
    if (!n || seen.has(n)) continue
    seen.add(n)
    result.push(p)
  }
  return result
}

const DEFAULTS = {
  blockAutoVarAssignment: true,
  blockVariableDelete: true,
  scanScriptWrites: true,
  scanScriptExec: true,
  maxDeletesPerWindow: 20,
  windowSeconds: 60,
  allowUntil: 0,
}

export const Config = Schema.object({
  blockAutoVarAssignment: Schema.boolean().default(true).volatile()
    .description('拒绝给 PowerShell 自动变量赋值（$home/$profile/$pwd/$args/$host/$pid…）'),
  blockVariableDelete: Schema.boolean().default(true).volatile()
    .description('递归删除（rmdir /s、rd /s、del /s、Remove-Item -Recurse、rm -rf）的参数里出现 $ 或 % 时拒绝'),
  scanScriptWrites: Schema.boolean().default(true).volatile()
    .description('写入 .ps1/.sh/.py/.js/.cmd/.bat 等脚本时，用同一套规则扫描正文；命中则拒绝写入'),
  scanScriptExec: Schema.boolean().default(true).volatile()
    .description('执行脚本（-File、./x.ps1、bash x.sh、node x.mjs 等）前读取文件内容，用同一套规则扫描；命中则拒绝执行'),
  protectedPaths: Schema.array(Schema.string()).default(defaultProtectedPaths()).volatile()
    .description('受保护路径：清单中的路径本身及其祖先不接受递归删除，其下的子路径可以删除'),
  maxDeletesPerWindow: Schema.number().default(20).volatile()
    .description('删除熔断阈值：时间窗口内允许的删除类命令数，0 表示关闭'),
  windowSeconds: Schema.number().default(60).volatile()
    .description('删除熔断的时间窗口（秒）'),
  allowUntil: Schema.number().default(0).volatile()
    .description('临时放行截止时间（毫秒时间戳，0 表示关闭）；由设置页的「临时放行 5 分钟」写入，到点自动失效'),
})

/** 递归删除命令的「参数区」：从动词位置到行尾。 */
function destructiveRegions(text) {
  const regions = []
  for (const line of text.split(/\r?\n/)) {
    let best = null
    for (const re of RECURSIVE_RES) {
      re.lastIndex = 0
      const m = re.exec(line)
      if (m && (best === null || m.index < best)) best = m.index
    }
    if (best !== null) regions.push(line.slice(best))
  }
  return regions
}

/** 任意删除类命令（用于计数）。 */
function hasDeleteIntent(text) {
  return DELETE_RES.some((re) => {
    re.lastIndex = 0
    return re.test(text)
  })
}

function pathTokensOf(text) {
  const out = []
  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3]
    if (!raw) continue
    if (/[$%]/.test(raw)) continue          // 变量目标由 R2 处理，这里只认字面路径
    const value = platformToken(raw)
    if (value) out.push(value)
  }
  return out
}

/** target 本身在清单里，或是清单条目的祖先（删它会连带删掉受保护项）。 */
function hitsProtected(target, protectedList) {
  if (protectedList.includes(target)) return target
  const prefix = withSep(target)
  for (const item of protectedList) {
    if (item.startsWith(prefix)) return item
  }
  return null
}

/** 读脚本正文；读不到、不是文件、或超过上限时返回 null。 */
function readScriptText(filePath) {
  try {
    const info = statSync(filePath)
    if (!info.isFile() || info.size > SCRIPT_SCAN_LIMIT) return null
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/** 命令里被「执行」的脚本，解析成绝对路径并去重（最多 5 个）。 */
function scriptPathsOf(text) {
  const out = []
  const seen = new Set()
  for (const re of SCRIPT_CALL_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const raw = (m[1] || '').trim()
      if (!raw || /[$%]/.test(raw)) continue
      let abs
      try {
        abs = resolve(raw)
      } catch {
        continue
      }
      const key = abs.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(abs)
      if (out.length >= 5) return out
    }
  }
  return out
}

function deny(reason) {
  return { kind: 'deny', reason }
}

const PROCEED_EN = 'To proceed: use a literal path and confirm it first (Resolve-Path + Write-Output). If this delete is what the user asked for, ask them to click "Allow for 5 minutes" in Settings → Delete guard, then retry.'
const PROCEED_ZH = '要继续：改用字面路径并先打印确认（Resolve-Path + Write-Output）。如果这次删除确实是用户要的，请让用户在「设置 → 删除闸门」点击「临时放行 5 分钟」，然后重试。'

/** 双语拒绝文案：谁看都能懂，不依赖界面语言。 */
function blocked(en, zh) {
  return [
    'dsh-delete-guard blocked this call.',
    en,
    '',
    'dsh-delete-guard 已拦截本次调用。',
    zh,
    '',
    PROCEED_EN,
    PROCEED_ZH,
  ].join('\n')
}

const PROTOCOL_SECTION = `## 删除命令硬约束（dsh-delete-guard）

执行任何删除前先读这三条，违反会被工具层直接拒绝：

1. **禁止给 PowerShell 自动变量赋值**：\`$home\` \`$profile\` \`$pwd\` \`$input\` \`$args\` \`$host\` \`$pid\`
   \`$error\` \`$this\` \`$matches\` \`$pshome\` \`$PSScriptRoot\` \`$LASTEXITCODE\` 等。变量名大小写不敏感，
   \`$home\` 就是只读的 \`$HOME\`；赋值只报非终止错误，脚本继续跑，后面的命令拿到的仍是用户主目录。
   用 \`$dshHome\` \`$targetDir\` \`$outDir\` 这类名字。
2. **递归删除（\`rmdir /s\`、\`rd /s\`、\`del /s\`、\`Remove-Item -Recurse\`、\`rm -rf\`）的参数里不得出现
   \`$\` 或 \`%\`**。先把目标解析成字面路径并打印出来，确认后再删。
3. **受保护路径不接受递归删除**：用户主目录、其祖先（\`C:\\Users\`、盘根）、用户已知文件夹
   （Desktop/Documents/Downloads/Pictures/Videos/Music/OneDrive）、\`SystemRoot\`、\`Program Files\`、
   \`DSH_HOME\`。这些路径本身与它们的祖先都不能被递归删除；它们下面的具体子目录可以删。
4. **不要绕过频率限制**：短时间内连续多次删除会触发熔断，把一次递归删除拆成很多次单个删除同样会被拒绝。
5. **不要把删除写进脚本文件再执行**：写 \`.ps1\`/\`.sh\`/\`.py\`/\`.js\` 时正文会被扫描，执行脚本前也会读文件检查；
   命中上面任何一条同样被拒绝。需要清理就写一条字面路径的命令，别封装成脚本。
6. **被拒时不要绕过**：不要为了通过检查去改写命令（换引号、拆字符串、base64 都算绕过）。
   如果这次删除确实是用户要求的，先向用户说明被拦的原因，请他在「设置 → 删除闸门」点击「临时放行 5 分钟」，然后重试。
   When blocked, do not work around the check. If the user explicitly asked for that delete, explain why it was
   blocked and ask them to click "Allow for 5 minutes" in Settings → Delete guard, then retry.

要清理某个构建产物或测试目录时：\`$p = 'C:\\...\\dist'; Get-ChildItem -LiteralPath $p | Measure-Object\`
先看规模，再 \`Remove-Item -LiteralPath 'C:\\...\\dist' -Recurse -Force\`（字面量，不带变量）。`

export default {
  name: 'dsh-delete-guard',
  Config,

  apply(ctx, config = {}) {
    let protectedCache = null
    let protectedCacheKey = ''
    let warnedInvalid = false
    const deleteLog = []

    /** 每 500ms 内同一份清单只解析一次。 */
    function protectedList() {
      const configured = listOf(config, 'protectedPaths')
      let source
      let usedDefaults = false

      if (configured === null) {
        // 没配过 → 平台默认清单
        source = defaultProtectedPaths()
        usedDefaults = true
      } else {
        const valid = configured.filter(isAbsoluteForPlatform)
        if (configured.length > 0 && valid.length === 0) {
          // 配了但全部不是当前平台的绝对路径（例如从另一台机器抄来的 C:\…）→ 回落默认，fail-closed
          if (!warnedInvalid) {
            warnedInvalid = true
            try {
              console.warn('[dsh-delete-guard] protectedPaths 中没有当前平台可用的绝对路径，已回落到默认清单')
            } catch {}
          }
          source = defaultProtectedPaths()
          usedDefaults = true
        } else {
          // 显式清空 = 不做路径保护（用户意图，UI 有提示）
          source = valid
        }
      }

      const key = `${usedDefaults ? 'd' : 'c'}|${configured === null ? 'n' : configured.length}|${source.join('|').toLowerCase()}`
      if (key !== protectedCacheKey) {
        protectedCache = source.map(norm).filter(Boolean)
        protectedCacheKey = key
      }
      return protectedCache
    }

    /** 滑动窗口计数；返回 true 表示本次调用应被熔断。 */
    function tripped() {
      const max = number(config, 'maxDeletesPerWindow', DEFAULTS.maxDeletesPerWindow)
      if (max <= 0) return false
      const windowMs = Math.max(1, number(config, 'windowSeconds', DEFAULTS.windowSeconds)) * 1000
      const now = Date.now()
      while (deleteLog.length > 0 && now - deleteLog[0] > windowMs) deleteLog.shift()
      deleteLog.push(now)
      return deleteLog.length > max
    }

    function evaluate(text) {
      // R1：自动变量赋值
      if (flag(config, 'blockAutoVarAssignment', true)) {
        const m = ASSIGN_RE.exec(text)
        if (m) {
          return deny(blocked(
            `Assigning to the PowerShell automatic variable ${m[0].trim()} is not allowed. Variable names are case-insensitive, so $home is the read-only $HOME (the user home): the assignment raises a non-terminating error, the script keeps running, and later lines still resolve to the home directory. Use $dshHome / $targetDir / $outDir instead.`,
            `不能给 PowerShell 自动变量赋值（${m[0].trim()}）。变量名大小写不敏感，$home 就是只读的 $HOME（用户主目录）；赋值只报非终止错误，脚本继续执行，后续命令拿到的仍是主目录。改用 $dshHome / $targetDir / $outDir 这类名字。`,
          ))
        }
      }

      const regions = destructiveRegions(text)
      if (regions.length === 0) return null
      const targetText = regions.join('\n')

      // R2：参数区里带变量
      if (flag(config, 'blockVariableDelete', true) && /[$%]/.test(targetText)) {
        return deny(blocked(
          'A recursive delete whose arguments contain `$` or `%` is refused: the target must be a literal path that was actually resolved. Do not build a delete target and delete it in one step.',
          '递归删除的参数里出现 `$` 或 `%`，拒绝执行：删除目标必须是已解析出来的字面路径，不要在同一行里既拼变量又删。',
        ))
      }

      // R3：受保护路径
      const guarded = protectedList()
      for (const token of pathTokensOf(targetText)) {
        const target = norm(token)
        if (!target) continue
        const hit = hitsProtected(target, guarded)
        if (hit) {
          return deny(blocked(
            `Recursive delete of ${target} is refused: it is a protected path (${hit}) or an ancestor of one. The list is editable in Settings → Delete guard. To clean something inside it, target the concrete subdirectory instead.`,
            `拒绝递归删除 ${target}：它是受保护路径（${hit}）本身或它的祖先目录。清单可在 设置 → 删除闸门 调整。如果确实要清理其中某个子目录，请把命令写到那个具体子目录。`,
          ))
        }
      }

      // R4 在监听器里统一计数，此处不再重复判定
      return null
    }

    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (!exec) return next()

        // 临时放行：用户在设置页手动开的窗口，优先级最高
        const allowUntil = number(config, 'allowUntil', 0)
        if (allowUntil > Date.now()) {
          try {
            console.warn('[dsh-delete-guard] bypassed by temporary allow until', new Date(allowUntil).toISOString())
          } catch {}
          return next()
        }

        // R5：写脚本时扫正文，把「看不见的执行期」提前到「看得见的写入期」
        if (exec.name === 'write' || exec.name === 'edit') {
          if (flag(config, 'scanScriptWrites', true)) {
            const target = exec.arguments?.file_path || exec.arguments?.path
            if (typeof target === 'string' && SCRIPT_EXT.test(target)) {
              const body = exec.name === 'write' ? exec.arguments?.content : exec.arguments?.new_string
              if (typeof body === 'string' && body.length > 0) {
                const verdict = evaluate(body)
                if (verdict) {
                  return deny(
                    `dsh-delete-guard blocked this call: the script body hits the delete rules (${target}).\n` +
                    `dsh-delete-guard 已拦截：脚本正文命中删除规则（${target}）。\n\n${verdict.reason}`,
                  )
                }
              }
            }
          }
          return next()
        }

        if (!SHELL_TOOLS.has(exec.name)) return next()
        const texts = collectStrings(exec.arguments ?? {}, [])
        if (texts.length === 0) return next()
        const text = texts.join('\n')

        // R6：执行脚本前读文件，用同一套规则扫描
        if (flag(config, 'scanScriptExec', true)) {
          for (const file of scriptPathsOf(text)) {
            const body = readScriptText(file)
            if (body === null) continue
            const verdict = evaluate(body)
            if (verdict) {
              return deny(
                `dsh-delete-guard blocked this call: the script ${file} hits the delete rules.\n` +
                `dsh-delete-guard 已拦截：被调用脚本 ${file} 的内容命中删除规则。\n\n${verdict.reason}`,
              )
            }
          }
        }

        // R4：每次删除类命令计数一次（被拒也计入），超阈值直接熔断
        if (hasDeleteIntent(text) && tripped()) {
          const max = number(config, 'maxDeletesPerWindow', DEFAULTS.maxDeletesPerWindow)
          const windowSeconds = number(config, 'windowSeconds', DEFAULTS.windowSeconds)
          return deny(blocked(
            `More than ${max} delete commands in ${windowSeconds} seconds: the rate limit tripped. Splitting one bulk delete into many single deletes is refused the same way. Do one explicit cleanup (Measure-Object, then a single delete on a concrete directory) or wait for the window.`,
            `${windowSeconds} 秒内删除类命令超过 ${max} 次，触发熔断。把一次批量删除拆成很多次单个删除同样会被拒绝；请先 Measure-Object 统计条目数，再对一个具体目录执行一次删除，或等窗口过去。`,
          ))
        }

        const verdict = evaluate(text)
        if (verdict) return verdict
      } catch (error) {
        try {
          console.error('[dsh-delete-guard] guard failed, allowing call:', error && error.message)
        } catch {}
      }
      return next()
    })

    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        ctx.effect(() => systemPrompt.section({ name: 'dsh-delete-guard-rules', order: 900, text: PROTOCOL_SECTION }))
      }
    } catch {}
  },
}



