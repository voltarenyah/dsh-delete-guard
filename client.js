// client.js — dsh-delete-guard 的设置页（Settings → Delete guard / 删除闸门）
//
// 文案跟随宿主 locale 服务；配置读写走 ctx.configForms。
window.__ModuleLoader__.load({
  id: '@voltarenyah/dsh-delete-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useSyncExternalStore = React.useSyncExternalStore

    const SECTION_ID = 'dsh-delete-guard'

    const DEFAULT_LOCALE = (typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('zh')) ? 'zh' : 'en'

    /**
     * 宿主在切语言时会同步 <html lang>（例如 zh-CN），这里直接读它，
     * 不依赖 locale 服务快照的内部字段名。读不到时退回浏览器语言。
     */
    function hostLocale() {
      try {
        const lang = document.documentElement && document.documentElement.lang
        if (lang) return lang
      } catch (e) {}
      return DEFAULT_LOCALE
    }

    function isZh(locale) {
      return String(locale || DEFAULT_LOCALE).toLowerCase().startsWith('zh')
    }

    function t(locale, zh, en) {
      return isZh(locale) ? zh : en
    }

    // 图标候选：改 ICON_VARIANT 一行即可切换
    const ICON_VARIANT = 'trash'
    const ICON_PATHS = {
      trash: [
        'M4 7h16',
        'M9.5 7V5.6c0-.9.7-1.6 1.6-1.6h1.8c.9 0 1.6.7 1.6 1.6V7',
        'M6.6 7l.7 11.1c.06 1 .9 1.9 2 1.9h5.4c1.1 0 1.9-.9 2-1.9L17.4 7',
        'M10.4 10.8v5.4',
        'M13.6 10.8v5.4',
      ],
      shield: [
        'M12 3l7 3v5.5c0 4.4-2.9 7.4-7 8.5-4.1-1.1-7-4.1-7-8.5V6l7-3z',
        'M9.2 8.8l5.6 5.6',
      ],
      trashShield: [
        'M3 6h11',
        'M6.9 6V4.8c0-.9.7-1.6 1.6-1.6h1.4c.9 0 1.6.7 1.6 1.6V6',
        'M4.9 6l.5 11.2c.05 1 .9 1.8 2 1.8h3.2',
        'M7.9 9.4v4',
        'M10.3 9.4v2',
        'M17.6 12l3.4 1.4v2.5c0 2-1.4 3.5-3.4 4.2-2-.7-3.4-2.2-3.4-4.2v-2.5l3.4-1.4z',
      ],
      stop: [
        'M8.7 3.6h6.6l4.2 4.2v6.6l-4.2 4.2H8.7l-4.2-4.2V7.8z',
        'M9.2 9.2l5.6 5.6',
      ],
    }

    function GuardIcon(props) {
      const size = (props && props.size) || 16
      const paths = ICON_PATHS[ICON_VARIANT] || ICON_PATHS.trash
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      }, paths.map((d, i) => h('path', { key: i, d })))
    }

    const SWITCHES = [
      {
        key: 'blockAutoVarAssignment',
        zh: '禁止给 PowerShell 自动变量赋值',
        en: 'Block automatic-variable assignment',
        zhDesc: '$home、$profile、$pwd、$args、$host、$pid 等是 PowerShell 自动变量（$home 即用户主目录）。给它们赋值只产生非终止错误，脚本会继续执行并沿用原值。',
        enDesc: '$home, $profile, $pwd, $args, $host, $pid are PowerShell automatic variables ($home is the user home). Assigning one raises a non-terminating error, so the script keeps running with the original value.',
      },
      {
        key: 'blockVariableDelete',
        zh: '拒绝以变量为目标的递归删除',
        en: 'Reject recursive deletes with a variable target',
        zhDesc: '递归删除（rmdir /s、rd /s、del /s、Remove-Item -Recurse、rm -rf）的参数里出现 $ 或 % 时拒绝，要求先用字面路径确认目标。',
        enDesc: 'Refuse rmdir /s, rd /s, del /s, Remove-Item -Recurse or rm -rf when the arguments contain $ or %, requiring a literal path instead.',
      },
      {
        key: 'scanScriptWrites',
        zh: '写入脚本时检查正文',
        en: 'Scan scripts when writing them',
        zhDesc: '写入 .ps1、.sh、.py、.js、.cmd、.bat 等脚本时，用上面同一套规则扫描内容；命中则拒绝写入，把执行期看不见的问题提前到写入期。',
        enDesc: 'When writing .ps1, .sh, .py, .js, .cmd or .bat files, scan the content with the same rules; a hit is refused at write time, where the guard can actually see it.',
      },
      {
        key: 'scanScriptExec',
        zh: '执行脚本前检查内容',
        en: 'Scan scripts before running them',
        zhDesc: '执行 -File、./x.ps1、bash x.sh、node x.mjs 等时，先读取该文件再按同一套规则判定；命中的脚本不会被执行。',
        enDesc: 'Before running a script via -File, ./x.ps1, bash x.sh, node x.mjs and similar, read the file and apply the same rules; a hit is not executed.',
      },
    ]

    const FULL_DEFAULTS = {
      blockAutoVarAssignment: true,
      blockVariableDelete: true,
      scanScriptWrites: true,
      scanScriptExec: true,
      maxDeletesPerWindow: 20,
      windowSeconds: 60,
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', maxWidth: 720, gap: 6 },
      h3: { margin: '0 0 2px', fontSize: 15, fontWeight: 600 },
      intro: { margin: '0 0 10px', fontSize: 12, opacity: 0.65, lineHeight: 1.6 },
      row: { padding: '10px 0', borderTop: '1px solid rgba(127,127,127,0.18)' },
      label: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
      desc: { marginLeft: 24, marginTop: 4, fontSize: 12, lineHeight: 1.5, opacity: 0.65 },
      list: { margin: '6px 0 8px 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 },
      item: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, padding: '4px 6px', border: '1px solid rgba(127,127,127,0.35)', borderRadius: 4, background: 'transparent', color: 'inherit', flex: 1, minWidth: 240 },
      btn: { fontSize: 12, padding: '4px 10px', border: '1px solid rgba(127,127,127,0.4)', borderRadius: 4, background: 'transparent', color: 'inherit', cursor: 'pointer' },
      err: { marginTop: 8, fontSize: 12, color: 'crimson' },
      num: { width: 64, fontSize: 12, padding: '4px 6px', border: '1px solid rgba(127,127,127,0.35)', borderRadius: 4, background: 'transparent', color: 'inherit' },
    }

    function useLocale(locale) {
      return useSyncExternalStore(
        function (cb) {
          try { return locale.subscribe(cb) } catch (e) { return function () {} }
        },
        hostLocale,
      )
    }

    function useSnapshot(form) {
      return useSyncExternalStore(
        function (cb) { return form.subscribe(cb) },
        function () { return form.getSnapshot() },
      )
    }

    function SwitchRow(props) {
      const field = props.field
      const lang = props.lang
      return h('div', { style: styles.row }, [
        h('label', { key: 'l', style: styles.label }, [
          h('input', {
            key: 'i',
            type: 'checkbox',
            checked: props.on,
            disabled: props.disabled,
            onChange: function (e) { props.onChange(e.target.checked) },
          }),
          h('span', { key: 't', style: { fontWeight: 500 } }, t(lang, field.zh, field.en)),
        ]),
        h('div', { key: 'd', style: styles.desc }, t(lang, field.zhDesc, field.enDesc)),
      ])
    }

    function Section(props) {
      const form = props.form
      const lang = useLocale(props.locale)
      const snap = useSnapshot(form)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [draft, setDraft] = React.useState('')

      const value = (snap && snap.value) || {}
      const effective = (key) => (typeof value[key] === 'boolean' ? value[key] : FULL_DEFAULTS[key])
      // 兼容旧版字符串数组与新版 { path, enabled }
      const protectedPaths = (Array.isArray(value.protectedPaths) ? value.protectedPaths : [])
        .map(function (item) {
          if (typeof item === 'string') return { path: item, enabled: true }
          if (item && typeof item.path === 'string') return { path: item.path, enabled: item.enabled !== false }
          return null
        })
        .filter(Boolean)
      const maxPerWindow = typeof value.maxDeletesPerWindow === 'number' ? value.maxDeletesPerWindow : FULL_DEFAULTS.maxDeletesPerWindow
      const windowSeconds = typeof value.windowSeconds === 'number' ? value.windowSeconds : FULL_DEFAULTS.windowSeconds

      const write = function (key, next, tag) {
        setError(null)
        setBusy(tag || key)
        return Promise.resolve(form.set(key, next))
          .catch(function (e) { setError(String((e && e.message) || e)) })
          .then(function () { setBusy(null) })
      }

      const addPath = function () {
        const candidate = draft.trim().replace(/^"|"$/g, '')
        if (!candidate) return
        const absolute = /^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\/.test(candidate) || candidate.startsWith('/')
        if (!absolute) {
          setError(t(lang, '请填写绝对路径，例如 D:\\Projects\\my-app 或 /Users/me/projects', 'Enter an absolute path, e.g. D:\\Projects\\my-app or /Users/me/projects'))
          return
        }
        const exists = protectedPaths.some((entry) => entry.path.toLowerCase() === candidate.toLowerCase())
        if (exists) {
          setError(t(lang, '该路径已在清单里', 'That path is already in the list'))
          return
        }
        // 祖先自动受保护：候选路径若覆盖了已有清单项，就属于重复定义
        const simple = function (p) { return p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() }
        const target = simple(candidate)
        const coveredBy = protectedPaths.find(function (entry) {
          const np = simple(entry.path)
          return np === target || np.indexOf(target + '\\') === 0
        })
        if (coveredBy) {
          setError(t(lang,
            '该路径已被「' + coveredBy.path + '」覆盖：清单项的上层目录自动受保护，不需要单独添加。',
            'Already covered by "' + coveredBy.path + '": ancestors of a listed path are protected automatically.',
          ))
          return
        }
        write('protectedPaths', protectedPaths.concat({ path: candidate, enabled: true }), 'paths').then(function () { setDraft('') })
      }

      const removePath = function (target) {
        write('protectedPaths', protectedPaths.filter((entry) => entry.path !== target), 'paths')
      }

      const togglePath = function (target, enabled) {
        write('protectedPaths', protectedPaths.map(function (entry) {
          return entry.path === target ? { path: entry.path, enabled: enabled } : entry
        }), 'paths')
      }

      const rateOn = maxPerWindow > 0

      return h('div', { style: styles.page }, [
        h('h3', { key: 'h', style: styles.h3 }, t(lang, '删除闸门', 'Delete guard')),
        h('p', { key: 'i', style: styles.intro },
          t(lang,
            '在 shell 工具执行前检查删除命令：拦下未展开的变量目标、受保护路径，以及短时间内的批量删除。改动即时生效。',
            'Checks delete commands before a shell tool runs: unexpanded variable targets, protected paths, and bursts of deletions. Changes apply immediately.',
          )),

        h('div', { key: 'switches' }, SWITCHES.map((field) => h(SwitchRow, {
          key: field.key,
          field: field,
          lang: lang,
          on: effective(field.key),
          disabled: busy === field.key,
          onChange: function (next) { write(field.key, next) },
        }))),

        h('div', { key: 'paths', style: styles.row }, [
          h('div', { key: 'title', style: { fontWeight: 500, marginBottom: 4 } },
            t(lang, '受保护路径', 'Protected paths')),
          h('div', { key: 'desc', style: { fontSize: 12, opacity: 0.65, lineHeight: 1.6 } },
            t(lang,
              '清单中的路径本身、以及它们的祖先目录都不接受递归删除；它们下面的子目录仍然可以删除。祖先目录自动包含，不需要单独添加。每条前面的勾选可以单独停用该条保护，停用后此路径不再受保护。',
              'A listed path and its ancestors cannot be recursively deleted; anything below a listed path still can. Ancestors are included automatically. The checkbox in front of each entry switches that single entry off.',
            )),
          h('ul', { key: 'list', style: styles.list }, protectedPaths.map((entry) => h('li', {
            key: entry.path,
            style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', opacity: entry.enabled ? 1 : 0.45 },
          }, [
            h('input', {
              key: 'on',
              type: 'checkbox',
              checked: entry.enabled,
              disabled: busy === 'paths',
              title: t(lang, '启用这条保护', 'Enable this entry'),
              onChange: function (e) { togglePath(entry.path, e.target.checked) },
            }),
            h('span', { key: 'p', style: { flex: 1, wordBreak: 'break-all' } }, entry.path),
            h('button', {
              key: 'x',
              type: 'button',
              style: styles.btn,
              disabled: busy === 'paths',
              onClick: function () { removePath(entry.path) },
            }, t(lang, '移除', 'Remove')),
          ]))),
          protectedPaths.length === 0
            ? h('div', { key: 'empty', style: { fontSize: 12, opacity: 0.65, marginBottom: 8 } },
                t(lang, '清单为空：不做路径保护。', 'Empty: no path protection.'))
            : null,
          h('div', { key: 'add', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
            h('input', {
              key: 'in',
              type: 'text',
              value: draft,
              placeholder: t(lang, '输入绝对路径后点添加', 'Absolute path, then Add'),
              style: styles.mono,
              disabled: busy === 'paths',
              onChange: function (e) { setDraft(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') addPath() },
            }),
            h('button', {
              key: 'b',
              type: 'button',
              style: styles.btn,
              disabled: busy === 'paths',
              onClick: addPath,
            }, t(lang, '添加', 'Add')),
          ]),
        ]),

        h('div', { key: 'rate', style: styles.row }, [
          h('label', { key: 'l', style: styles.label }, [
            h('input', {
              key: 'i',
              type: 'checkbox',
              checked: rateOn,
              disabled: busy === 'rate',
              onChange: function (e) { write('maxDeletesPerWindow', e.target.checked ? 20 : 0, 'rate') },
            }),
            h('span', { key: 't', style: { fontWeight: 500 } }, t(lang, '删除频率熔断', 'Delete rate limit')),
          ]),
          h('div', { key: 'd', style: styles.desc },
            t(lang,
              '短时间内的删除类命令超过阈值就拒绝，防止把一次批量删除拆成很多次单个删除。',
              'Refuse bursts of delete commands, so a bulk delete cannot be split into many single deletes.',
            )),
          rateOn
            ? h('div', { key: 'n', style: { marginLeft: 24, marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } }, [
                h('span', { key: 'a' }, t(lang, '每', 'At most')),
                h('input', {
                  key: 'max',
                  type: 'number',
                  min: 1,
                  value: maxPerWindow,
                  style: styles.num,
                  disabled: busy === 'rate',
                  onChange: function (e) {
                    const n = parseInt(e.target.value, 10)
                    if (Number.isFinite(n) && n > 0) write('maxDeletesPerWindow', n, 'rate')
                  },
                }),
                h('span', { key: 'b' }, t(lang, '次删除 /', 'deletes per')),
                h('input', {
                  key: 'win',
                  type: 'number',
                  min: 1,
                  value: windowSeconds,
                  style: styles.num,
                  disabled: busy === 'rate',
                  onChange: function (e) {
                    const n = parseInt(e.target.value, 10)
                    if (Number.isFinite(n) && n > 0) write('windowSeconds', n, 'rate')
                  },
                }),
                h('span', { key: 'c' }, t(lang, '秒', 'seconds')),
              ])
            : null,
        ]),

        error ? h('p', { key: 'err', style: styles.err }, t(lang, '保存失败：', 'Save failed: ') + error) : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.inject(['configForms', 'locale'], function (ready) {
          const locale = ready.locale
          const sectionLabel = function () { return t(hostLocale(), '删除闸门', 'Delete guard') }

          let form = null
          try {
            form = ready.configForms.get(SECTION_ID)
          } catch (e) {
            return
          }
          if (!form) return
          ready.effect(function () {
            const disposeSection = ready.slots.inject('settings.section', function () {
              return ready.slots.register({
                name: 'settings.section',
                id: SECTION_ID,
                order: 60,
                label: sectionLabel,
                inject: function () { return { form, locale } },
              }, Section)
            })
            const disposeIcon = ready.slots.inject('settings.section.icon', function () {
              return ready.slots.register({
                name: 'settings.section.icon',
                id: SECTION_ID,
                label: sectionLabel,
              }, GuardIcon)
            })
            return function () {
              try { disposeSection() } catch (e) {}
              try { disposeIcon() } catch (e) {}
            }
          })
        })
      },
    }
  },
})
