Chinese | [English](README.en.md)

# dsh-acw-plugin

[![CI](https://github.com/kvker/dsh-acw-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/kvker/dsh-acw-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

把 DeepSeek Harness 的「添加工作区」一键变成 [AI Context Workspace（ACW）](https://github.com/kvker/ai-context-workspace)，
并在新工作区的第一轮对话里提示你执行 `$an-init`。

## 它做什么

```
添加工作区选中：  ~/work/foo/
                ↓   （自动转换 + 注册）
实际工作区：      ~/work/foo--acw/          ← ACW 根，侧边栏标题也是 foo--acw
                 ├── AGENTS.md
                 ├── background/  conventions/  artifacts/  .agents/
                 ├── .acw-marker             ← 内容 "1"，标记已转换
                 └── projects/
                     └── foo/                ← 原目录内容整体搬进来
```

新会话的 cwd 就是 ACW 根，所以打开即可按 ACW 的约定工作；第一轮对话时，如果工作区还没初始化，
插件会让模型用 `ask_user_question` 问你一次：「现在初始化工作区（推荐）／暂不初始化」。

## 功能

- **添加即转换**：拦截 `workspaceRegistry.create`，把选中目录改成 ACW 布局再用新路径注册。
- **兼容老工作区**：没有 marker 的老 ACW 靠 `background/`、`conventions/`、`artifacts/`、`.agents/`
  四个目录识别，不会被二次转换。
- **首轮 `$an-init` 提示**：ACW 且 `.agents/skills/an-init/SKILL.md` 还在时，第一轮询问是否初始化；
  技能消失（初始化完成）后不再提示。只问一次，拒绝后同一会话不再打扰。
- **标题同步**：工作区标题默认与目录名一致；历史遗留的「路径 `foo--acw`、标题 `foo`」会在加载时自动修正。
- **安全兜底**：目标已存在时报错不覆盖；搬动前检查历史会话；失败自动回滚。

## 安装

需要 DeepSeek Harness 桌面端（自带 `dsh` CLI）。

```sh
# 从 GitHub 安装
dsh plugin --profile desktop add git+https://github.com/kvker/dsh-acw-plugin.git

# 或从本地目录（开发时用，pnpm 会建 link）
dsh plugin --profile desktop add ~/Documents/deepseek-harness/plugins/dsh-acw-plugin
```

本包声明了 `dsh.bundle.patch`，CLI 会把它作为 bundle 层追加到 profile 并启用。
默认开启配置热重载，装完通常几秒内生效；没有生效就退出并重开 DSH。

卸载：

```sh
dsh plugin --profile desktop remove dsh-acw-plugin
```

## 使用

1. 侧边栏 → **Add workspace** → 选一个目录；
2. 目录被转换成 `<名字>--acw`，原内容进 `projects/<名字>/`；
3. 新会话里正常对话；如果 ACW 未初始化，第一轮会收到是否执行 `$an-init` 的询问。

> 注意：转换会**真的移动目录**，原路径消失。IDE 窗口、shell 当前目录、脚本里的绝对路径不会跟着改。

## 配置

默认值即可用。要覆盖时，在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里写同 id（`ai-context-workspace`）的条目：

```yaml
- id: ai-context-workspace
  config:
    suffix: '.acw'
    title: 'original'
    initPrompt: 'off'
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭时完全不碰 `create`。 |
| `suffix` | `--acw` | ACW 根目录后缀。 |
| `marker` | `.acw-marker` | 标记文件名；存在即视为已是 ACW。 |
| `writeMarker` | `true` | 转换后是否写 marker；关掉后只靠目录特征识别。 |
| `signatureDirs` | `['background','conventions','artifacts','.agents']` | 结构特征目录，全部存在即视为 ACW（兼容老工作区）。 |
| `title` | `directory` | `directory` 用目录名 `foo--acw` 做标题；`original` 用原目录名 `foo`。 |
| `syncTitles` | `true` | 加载时修正「路径 `foo--acw`、标题 `foo`」的旧记录；仅在 `title: 'directory'` 时生效。 |
| `initPrompt` | `first-turn` | 首轮是否提示 `$an-init`；`off` 关闭。 |
| `initSkill` | `.agents/skills/an-init/SKILL.md` | 判断「是否已初始化」的技能入口路径。 |
| `templateUrl` | `https://github.com/kvker/ai-context-workspace.git` | ACW 模板仓库。 |
| `templateBranch` | `main` | 模板分支。 |
| `templateCacheDir` | `~/.dsh/ai-context-workspace/template` | 本地模板缓存（clone 一次后只做本地复制）。 |
| `refreshTemplate` | `false` | 每次转换前都重新 clone 模板。 |
| `prewarmTemplate` | `true` | 插件加载时后台预热模板缓存。 |
| `keepTemplateHistory` | `false` | 是否保留模板自带的 `artifacts/_archived/*` 示例。 |
| `skipWhenSessionsExist` | `true` | 目录已有历史会话时跳过转换。 |
| `cloneTimeoutMs` | `120000` | 单次 `git clone` 超时。 |
| `protectedPaths` | `[]` | 额外保护目录（绝对路径），命中则按原样注册。 |
| `sessionLogRoot` | `~/.dsh/sessions` | 探测历史会话用的日志根目录。 |

## 首轮 `$an-init` 提示是怎么实现的

`an-init` 是 ACW 模板里的「一次性」技能：初始化完成后它会删除自己，所以「技能还在」就等于「还没初始化」。

插件在 `agent/created` 时给该 agent 挂一个 system prompt 段落；段落文本只在**本轮会话第一条用户消息出现后**
返回一次，之后返回空串。因此：

- 不会给空白会话写任何事件（不影响 DSH 的 blank session 复用）；
- 标题生成之类的内部调用不会误消耗这次提示；
- 没有 `ask_user_question` 工具时，提示会让模型在回复开头用一句话代替，同样只提一次。

## 安全规则

转换会移动真实目录，因此按「宁可不转，也不破坏数据」处理：

| 情况 | 行为 |
| --- | --- |
| 已有 `.acw-marker`，或四个特征目录齐全 | 按原样注册（已转换过）。 |
| 目录名已带 `--acw` 后缀 | 按原样注册。 |
| 目录位于某个 ACW 之内 | 按原样注册，避免 ACW 套 ACW。 |
| 命中保护区（家目录、`~/Desktop`、`~/Documents`、`~/Downloads`、`~/.dsh`、`/Users`、`/System` 等） | 按原样注册。 |
| 目录已有历史会话（活动会话或 `~/.dsh/sessions` 里的日志） | 按原样注册，避免会话 cwd 失联。 |
| 目标 `foo--acw` 已存在 | **报错并阻止创建**，不覆盖。 |
| 模板 clone 失败且无本地缓存 | 报错并阻止创建，原目录未被移动。 |
| 搬入原目录或发布失败 | 自动回滚；回滚失败时错误信息给出数据实际位置。 |

转换用「同父目录下的临时脚手架 + rename」完成：先在 `.<名字>--acw.partial-*` 里铺模板、
把原目录 rename 进 `projects/<名字>/`，最后整体 rename 成正式目录名。

## 诊断

每次「添加工作区」的结果写到 `~/.dsh/ai-context-workspace/last-run.json`：

```json
{
  "at": "2026-10-30T02:16:16.659Z",
  "picked": "/Users/you/work/foo",
  "converted": true,
  "reason": "converted",
  "workspace": { "id": "…", "path": "/Users/you/work/foo--acw", "title": "foo--acw" }
}
```

`converted: false` 会带上跳过原因（`already-acw`、`inside-acw`、`has-sessions`、`protected`、`suffixed` 等）。

## 开发

```sh
node --test test/
```

- `lib/convert.js` 目录转换与 ACW 判定，不依赖 Cordis，可单独测试。
- `lib/init.js` 首轮提示的判定与文案。
- `lib/index.js` Cordis 插件：包装 `workspaceRegistry.create`、挂 system prompt 段落。

## License

[MIT](LICENSE) © 2026 kvker
