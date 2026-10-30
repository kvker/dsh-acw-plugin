/**
 * DSH host 插件：在「添加工作区」时把选中的目录自动改造成
 * [AI Context Workspace](https://github.com/kvker/ai-context-workspace) 布局。
 *
 * 挂载点：`ctx.workspaceRegistry.create(path, title)` —— GUI 的「添加工作区」
 * （`workspaceController.create`）最终只从这里创建 Workspace，且新会话的 cwd
 * 取自注册路径，因此在这里换路径即可端到端生效。
 *
 * @module dsh-acw-plugin
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { convertWorkspaceDirectory, ensureTemplate, normalizeOptions } from './convert.js'
import { buildInitPromptText, initState } from './init.js'

/** 插件名（Cordis / Loader 用）。 */
export const name = 'ai-context-workspace'

/** 依赖的 host 服务：Workspace 注册表与 Agent 注册表。 */
export const inject = ['workspaceRegistry', 'agents']

/** 记录「create 已被本插件包装」的标记，避免 HMR 重复包装。 */
const WRAPPED = Symbol.for('dsh-acw-plugin.wrapped')

/** 每个 Agent 的首轮提示 fiber，Agent 释放时一起清理。 */
const initPromptFibers = new Map()

/**
 * 会话日志里是否已经有用户消息。用于确保提示只出现在真正的第一轮，
 * 而不是标题生成之类的内部调用上。
 *
 * @param {object} session - 会话对象。
 * @returns {boolean} 是否已有用户消息。
 */
function hasUserMessage(session) {
  let events = []
  try {
    events = session?.snapshotEvents?.() ?? []
  } catch {
    return false
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'user/message') return true
  }
  return false
}

/**
 * 给一个 Agent 挂上「首轮询问是否 $an-init」的系统提示段落。
 *
 * 只有工作区已具备 ACW 结构、且 `an-init` 技能仍在时才挂；技能消失（初始化完成）后
 * 不再提示。文本在会话第一轮返回一次，之后返回空串，因此不会反复打扰。
 *
 * @param {object} agent - DSH Agent。
 * @param {object} options - 规范化选项。
 * @param {(message: string) => void} log - 信息日志。
 * @returns {void}
 */
function installInitPrompt(agent, options, log) {
  if (options.initPrompt === 'off') return
  if (agent === undefined || initPromptFibers.has(agent)) return
  if ((agent.options?.subagentDepth ?? 0) > 0) return

  const cwd = agent.session?.header?.cwd
  const state = initState(cwd, options)
  if (!state.pending) return

  const tracking = { shown: false }
  const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'context:acw-init',
      order: 700,
      text: () => {
        if (tracking.shown || !hasUserMessage(agent.session)) return ''
        tracking.shown = true
        log(`首轮提示 $an-init：${cwd}`)
        return buildInitPromptText()
      },
    })
  })
  initPromptFibers.set(agent, fiber)
}

/**
 * 释放某个 Agent 的首轮提示。
 *
 * @param {object} agent - DSH Agent。
 * @param {(message: string) => void} warn - 警告日志。
 * @returns {void}
 */
function disposeInitPrompt(agent, warn) {
  const fiber = initPromptFibers.get(agent)
  if (fiber === undefined) return
  initPromptFibers.delete(agent)
  Promise.resolve()
    .then(() => fiber.dispose())
    .catch((error) => {
      warn(`首轮提示清理失败：${error instanceof Error ? error.message : String(error)}`)
    })
}

/**
 * 把最近一次「添加工作区」的处理结果写到磁盘，便于排查静默跳过。
 *
 * @param {string} file - 状态文件路径。
 * @param {Record<string, unknown>} entry - 本次记录。
 * @returns {Promise<void>} 写入完成（失败被吞掉，不影响主流程）。
 */
async function recordStatus(file, entry) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const payload = { at: new Date().toISOString(), ...entry }
    await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 })
  } catch {
    // 状态文件只是诊断信息，写不了就算了。
  }
}

/**
 * 把「路径已经是 xxx--acw、标题却还是 xxx」的旧记录改回目录名。
 *
 * 只处理标题恰好等于「去掉后缀的原名」的记录，用户自己改过的标题不动。
 *
 * @param {object} registry - Workspace 注册表。
 * @param {object} options - 规范化选项。
 * @param {(message: string) => void} log - 信息日志。
 * @param {(message: string) => void} warn - 警告日志。
 * @returns {Promise<void>} 同步完成。
 */
async function syncLegacyTitles(registry, options, log, warn) {
  try {
    for (const workspace of registry.list()) {
      const name = path.basename(workspace.path)
      if (!name.endsWith(options.suffix)) continue
      const legacy = name.slice(0, -options.suffix.length)
      if (legacy.length === 0 || workspace.title !== legacy) continue
      await workspace.setTitle(name)
      log(`标题已同步：${legacy} → ${name}（${workspace.path}）`)
    }
  } catch (error) {
    warn(`同步旧工作区标题失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 安装插件。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {Record<string, unknown>} config - Loader 传入的行配置。
 */
export function apply(ctx, config) {
  const options = normalizeOptions(config)
  const logger = ctx.logger
  const log = (message) => logger.info(`[ai-context-workspace] ${message}`)
  const warn = (message) => logger.warn(`[ai-context-workspace] ${message}`)

  if (!options.enabled) {
    log('已在配置中关闭（enabled: false）')
    return
  }

  const registry = ctx.workspaceRegistry
  const originalCreate = registry?.create
  if (typeof originalCreate !== 'function') {
    warn('workspaceRegistry.create 不可用，插件未生效')
    return
  }
  if (registry[WRAPPED] === true) {
    log('已包装过 workspaceRegistry.create，跳过重复安装')
    return
  }

  /**
   * 包装后的建工作区入口。
   *
   * @param {string} pickedPath - 用户选择的目录。
   * @param {string} [title] - 可选标题。
   * @returns {Promise<object>} Workspace 实体。
   */
  const wrappedCreate = async function createWorkspace(pickedPath, title) {
    if (typeof pickedPath !== 'string' || pickedPath.length === 0) {
      return originalCreate.call(registry, pickedPath, title)
    }

    const statusFile = path.join(path.dirname(options.templateCacheDir), 'last-run.json')
    let outcome
    try {
      outcome = await convertWorkspaceDirectory(pickedPath, options, { log, warn, ctx })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warn(`转换失败，工作区未创建：${reason}`)
      await recordStatus(statusFile, { picked: pickedPath, converted: false, reason: 'error', error: reason })
      throw error
    }

    if (outcome.converted) {
      // 默认用 ACW 根目录名（foo--acw）当标题，与磁盘上的目录一致。
      const finalTitle = options.title === 'original' ? outcome.base : path.basename(outcome.path)
      const workspace = await originalCreate.call(registry, outcome.path, finalTitle)
      await recordStatus(statusFile, {
        picked: pickedPath,
        converted: true,
        reason: outcome.reason,
        workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
      })
      return workspace
    }

    if (outcome.reason !== 'already-acw') {
      log(`按原样注册（${outcome.reason}）：${outcome.path}`)
    }
    const workspace = await originalCreate.call(registry, outcome.path, title)
    await recordStatus(statusFile, {
      picked: pickedPath,
      converted: false,
      reason: outcome.reason,
      workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
    })
    return workspace
  }

  try {
    registry.create = wrappedCreate
    registry[WRAPPED] = true
  } catch (error) {
    warn(`无法包装 workspaceRegistry.create：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  ctx.effect(() => () => {
    if (registry.create === wrappedCreate) {
      registry.create = originalCreate
      registry[WRAPPED] = false
      log('已恢复 workspaceRegistry.create')
    }
  }, 'ai-context-workspace: restore workspace creation')

  log(`已启用：选中目录将转换为 <名字>${options.suffix}，模板缓存 ${options.templateCacheDir}`)

  for (const agent of ctx.agents.list()) installInitPrompt(agent, options, log)
  ctx.on('agent/created', ({ agent }) => installInitPrompt(agent, options, log))
  ctx.on('agent/disposed', ({ agent }) => disposeInitPrompt(agent, warn))
  ctx.effect(() => () => {
    for (const agent of [...initPromptFibers.keys()]) disposeInitPrompt(agent, warn)
  }, 'ai-context-workspace: dispose init prompts')

  if (options.syncTitles && options.title === 'directory') {
    // 修一次历史遗留：路径已是 foo--acw、标题却还是 foo 的工作区。
    // title 显式要求 original 时不跑，避免把刚建好的原名标题又改回后缀名。
    void syncLegacyTitles(registry, options, log, warn)
  }

  if (options.prewarmTemplate) {
    // 后台预热，避免首次「添加工作区」时卡在 clone 上。
    ensureTemplate(options, log).catch((error) => {
      warn(`模板预热失败（首次添加工作区时会重试）：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

/** 供测试或其它插件复用的导出。 */
export { convertWorkspaceDirectory, ensureTemplate, normalizeOptions }
