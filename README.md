# @voltarenyah/dsh-delete-guard

**English** | [简体中文](./README.zh-CN.md)

A delete guard for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It inspects every
shell command at the host's `tools/pre-execute` seam and refuses the ones that would delete something
you cannot get back.

Policy layer, not a sandbox: it decides *whether a command runs*, it does not intercept filesystem calls.

![Delete guard settings page](docs/settings-en.png)

## What it blocks

| Rule | Trigger | Result |
|---|---|---|
| **Automatic-variable assignment** | A command assigns to `$home`, `$profile`, `$pwd`, `$input`, `$args`, `$host`, `$pid`, `$error`, `$matches`, `$pshome`, `$PSScriptRoot`, `$LASTEXITCODE`, … | Denied |
| **Variable delete target** | A recursive delete (`rmdir /s`, `rd /s`, `del /s`, `Remove-Item -Recurse`, `rm -rf`) whose argument region contains `$` or `%` | Denied |
| **Protected path** | A recursive delete targets a listed path, or an ancestor of one | Denied |
| **Delete rate limit** | More delete commands inside the window than the threshold | Denied |

Why the first rule matters: PowerShell variable names are case-insensitive, so `$home` **is** `$HOME`.
Assigning to it is a *non-terminating* error, the script keeps running, and every later use of `$home`
still resolves to the user's home directory. A command that looks like "delete a temp folder" can
therefore delete the profile.

The path rule uses scope proof rather than a keyword blocklist:

- A listed path and its **ancestors** are protected — deleting an ancestor would take the listed path with it.
- Anything **below** a listed path is still deletable, so build output and scratch directories keep working.
- Deleting a path that is not covered does not need an allowlist entry.

## Install

```shell
dsh plugin --profile <profile> add @voltarenyah/dsh-delete-guard
```

The plugin is host + web client: after installing, restart DSH, then open
**Settings → Delete guard**.

## Settings

Everything is editable from **Settings → Delete guard** and takes effect on the next tool call
(no restart): the two switches, the protected-path list, and the rate-limit threshold/window.

| Key | Default | Meaning |
|---|---|---|
| `blockAutoVarAssignment` | `true` | Deny assignments to PowerShell automatic variables |
| `blockVariableDelete` | `true` | Deny recursive deletes whose arguments contain `$` or `%` |
| `protectedPaths` | platform-derived (see below) | Paths that cannot be recursively deleted |
| `maxDeletesPerWindow` | `20` | Delete commands allowed per window; `0` disables the limit |
| `windowSeconds` | `60` | Rate-limit window |

The same values live in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-delete-guard
  name: '@voltarenyah/dsh-delete-guard'
  config:
    blockAutoVarAssignment: true
    blockVariableDelete: true
    protectedPaths:
      - C:\Users\me
      - D:\Projects\keep
    maxDeletesPerWindow: 20
    windowSeconds: 60
```

## Default protected paths

The defaults are computed at load time from `os.homedir()` and the platform's environment — no
machine-specific paths are hardcoded:

| | Windows | macOS | Linux |
|---|---|---|---|
| Home | `C:\Users\<name>` | `/Users/<name>` | `/home/<name>` |
| System | `SystemRoot`, `Program Files`, `Program Files (x86)`, `ProgramData` | `/Applications`, `/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/etc` | `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/boot` |
| DSH home | `~\.dsh` | `~/.dsh` | `~/.dsh` |
| Standard folders | Desktop, Documents, Downloads, Pictures, Videos, Music, OneDrive | Desktop, Documents, Downloads, Pictures, Movies, Music | same as Windows |

Because ancestors are protected automatically, the list does not repeat them: listing `C:\Users\me`
already protects `C:\Users` and `C:\`. Adding an entry that is already covered is rejected with an
explanatory message.

Behaviour when a path is unusable:

| Situation | Behaviour |
|---|---|
| Entry is not an absolute path for this platform (e.g. `/Users/x` on Windows, or `Documents`) | Ignored |
| Entries configured but none valid for this platform | Falls back to the defaults (fails closed) and logs a warning |
| List explicitly emptied | No path protection — this is the user's stated intent, and the UI says so |
| Path does not exist right now (unplugged drive) | Kept; protection applies when it appears |

The default list is generated once and then stored as an explicit list as soon as you edit it in
Settings. To return to "computed from this machine", delete that `- id: dsh-delete-guard` block from
`cordis.patch.yml`.

## Known limits

| Not covered | Why |
|---|---|
| Deletes written inside a script file (`.ps1`, `.sh`, `.py`) | The guard only sees the command line |
| Command names assembled in a variable and invoked (`& $cmd`) | Not resolvable from text |
| Commands split across several inputs in a persistent terminal | Each call sees only its own text |
| `robocopy /MIR`, `git clean -fdx` and other non-delete verbs | Outside the delete-verb set |
| Anything that happens after a call is allowed | This plugin does not intercept filesystem calls and has no trash |

The rate limit counts **tool calls**, not files: one command deleting 100 000 files counts once.

If you need "deleted but recoverable", pair this with volume snapshots/backups, or use a recycle-bin
plugin such as `dsh-safe-delete` or `dsh-delete-guard` — this plugin focuses on never starting the delete.

## License

MIT
