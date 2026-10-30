[Chinese](README.md) | English

# dsh-acw-plugin

[![CI](https://github.com/kvker/dsh-acw-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/kvker/dsh-acw-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin that turns the directory you pick in
**Add workspace** into an [AI Context Workspace (ACW)](https://github.com/kvker/ai-context-workspace) layout, and offers
`$an-init` on the first turn of a new conversation.

## What it does

```
Pick a directory:  ~/work/foo/
                   ↓   (converted, then registered)
Workspace:         ~/work/foo--acw/          ← ACW root; sidebar title is foo--acw too
                   ├── AGENTS.md
                   ├── background/  conventions/  artifacts/  .agents/
                   ├── .acw-marker             ← contains "1", marks a converted directory
                   └── projects/
                       └── foo/                ← the whole original directory
```

The session working directory is the ACW root. On the first turn, if the workspace has not been initialized yet, the
plugin asks the model to use `ask_user_question` once: "Initialize the workspace now (recommended) / Not now".

## Features

- **Convert on add**: wraps `workspaceRegistry.create`, converts the picked directory, then registers the new path.
- **Legacy-friendly**: ACW roots without a marker are detected by the four directories
  `background/`, `conventions/`, `artifacts/`, `.agents/`, so they are never converted twice.
- **First-turn `$an-init` offer**: shown only while `.agents/skills/an-init/SKILL.md` still exists (the skill deletes
  itself once initialization finishes). Asked once per conversation.
- **Title sync**: workspace titles follow the directory name; legacy `path=foo--acw, title=foo` records are fixed on load.
- **Safety first**: refuses to overwrite an existing target, skips directories with session history, rolls back on failure.

## Install

Requires the DeepSeek Harness desktop app (which ships the `dsh` CLI).

```sh
# from GitHub
dsh plugin --profile desktop add git+https://github.com/kvker/dsh-acw-plugin.git

# or from a local checkout (pnpm links it)
dsh plugin --profile desktop add ~/Documents/deepseek-harness/plugins/dsh-acw-plugin
```

The package declares `dsh.bundle.patch`, so the CLI adds it as a bundle layer and enables it. Config hot reload is on by
default; if the plugin does not appear, quit and reopen DSH.

Uninstall:

```sh
dsh plugin --profile desktop remove dsh-acw-plugin
```

## Usage

1. Sidebar → **Add workspace** → pick a directory.
2. It becomes `<name>--acw`, and the original contents move into `projects/<name>/`.
3. Chat normally; if the ACW workspace is uninitialized, the first turn asks whether to run `$an-init`.

> The conversion **really moves the directory**; the original path disappears. IDE windows, shell cwd and hard-coded
> absolute paths in scripts are not updated.

## Configuration

Override any default in `~/.dsh/profiles/desktop/cordis.patch.yml` by row id (`ai-context-workspace`):

```yaml
- id: ai-context-workspace
  config:
    suffix: '.acw'
    title: 'original'
    initPrompt: 'off'
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when off, `create` is untouched. |
| `suffix` | `--acw` | ACW root directory suffix. |
| `marker` | `.acw-marker` | Marker filename; its presence means "already ACW". |
| `writeMarker` | `true` | Write the marker after conversion. |
| `signatureDirs` | `['background','conventions','artifacts','.agents']` | Structural signature; all present means ACW. |
| `title` | `directory` | `directory` titles the workspace `foo--acw`; `original` uses `foo`. |
| `syncTitles` | `true` | Fix legacy `foo` titles on load (only in `directory` mode). |
| `initPrompt` | `first-turn` | Offer `$an-init` on the first turn; `off` disables it. |
| `initSkill` | `.agents/skills/an-init/SKILL.md` | Skill entry used to detect "not initialized yet". |
| `templateUrl` | `https://github.com/kvker/ai-context-workspace.git` | ACW template repository. |
| `templateBranch` | `main` | Template branch. |
| `templateCacheDir` | `~/.dsh/ai-context-workspace/template` | Local template cache. |
| `refreshTemplate` | `false` | Re-clone the template before each conversion. |
| `prewarmTemplate` | `true` | Clone the template in the background at plugin load. |
| `keepTemplateHistory` | `false` | Keep the template's own `artifacts/_archived/*` examples. |
| `skipWhenSessionsExist` | `true` | Skip conversion when the directory has session history. |
| `cloneTimeoutMs` | `120000` | Per-clone timeout. |
| `protectedPaths` | `[]` | Extra absolute paths that are never converted. |
| `sessionLogRoot` | `~/.dsh/sessions` | Session log root used for the history check. |

## How the first-turn offer works

`an-init` is a one-shot ACW skill: it removes itself when initialization completes, so "skill present" means
"not initialized yet". On `agent/created` the plugin registers a system-prompt section for that agent whose text is
returned exactly once, after the conversation has its first user message. That means: no events are written to blank
sessions (DSH blank-session reuse keeps working), internal calls such as title generation cannot consume the offer, and
the model is told to ask once and never again in the same conversation.

## Safety rules

| Situation | Behavior |
| --- | --- |
| Marker present, or the four signature directories exist | Register as-is (already ACW). |
| Directory name already ends with `--acw` | Register as-is. |
| Directory is inside another ACW | Register as-is (no ACW-in-ACW). |
| Protected path (home, `~/Desktop`, `~/Documents`, `~/.dsh`, `/Users`, `/System`, …) | Register as-is. |
| Directory has session history | Register as-is, so existing sessions keep working. |
| Target `foo--acw` already exists | **Fail** without overwriting. |
| Template clone fails and no cache exists | Fail; the original directory stays untouched. |
| Move or publish fails | Roll back; if rollback fails, the error names where the data is. |

## Development

```sh
node --test test/
```

- `lib/convert.js` — conversion and ACW detection, dependency-free.
- `lib/init.js` — first-turn offer detection and wording.
- `lib/index.js` — the Cordis plugin wiring.

## License

[MIT](LICENSE) © 2026 kvker
