/**
 * 目录转换核心：把「添加工作区」选中的目录改造成
 * [AI Context Workspace](https://github.com/kvker/ai-context-workspace) 布局。
 *
 * 目标形态（以选中 `~/work/foo` 为例）：
 *
 *   ~/work/foo--acw/                 ← ACW 根，注册成 DSH 工作区
 *   ├── AGENTS.md  conventions/  background/  artifacts/  .agents/
 *   └── projects/
 *       └── foo/                     ← 原 foo 的全部内容
 *
 * 该模块不依赖 Cordis，便于单独测试。
 *
 * @module dsh-acw-plugin/convert
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 写入 ACW 根、用来标记「此目录已是 ACW」的文件名。 */
export const DEFAULT_MARKER = '.acw-marker'
/** marker 的内容：`1`。 */
export const MARKER_CONTENT = '1\n'
/** 默认的 ACW 目录后缀。 */
export const DEFAULT_SUFFIX = '--acw'

/**
 * ACW 的结构特征：同时存在这几个目录就认为是 ACW。
 *
 * 老工作区没有 `.acw-marker`，靠这组目录识别；新工作区两者都满足。
 */
export const ACW_SIGNATURE_DIRS = Object.freeze(['background', 'conventions', 'artifacts', '.agents'])

/** `$an-init` 技能入口，相对 ACW 根。初始化完成后该技能会被删除。 */
export const DEFAULT_INIT_SKILL = '.agents/skills/an-init/SKILL.md'

/** 模板仓库。 */
export const DEFAULT_TEMPLATE_URL = 'https://github.com/kvker/ai-context-workspace.git'

/**
 * 把用户配置补全成完整选项。
 *
 * @param {Record<string, unknown>} [raw] - Loader 传入的 config。
 * @returns {object} 规范化后的选项。
 */
export function normalizeOptions(raw = {}) {
  const input = raw ?? {}
  const suffix = typeof input.suffix === 'string' && input.suffix.length > 0
    ? input.suffix
    : DEFAULT_SUFFIX
  const cacheDir = typeof input.templateCacheDir === 'string' && input.templateCacheDir.length > 0
    ? path.resolve(input.templateCacheDir)
    : path.join(os.homedir(), '.dsh', 'ai-context-workspace', 'template')
  return {
    enabled: input.enabled !== false,
    suffix,
    marker: typeof input.marker === 'string' && input.marker.length > 0 ? input.marker : DEFAULT_MARKER,
    writeMarker: input.writeMarker !== false,
    signatureDirs: Array.isArray(input.signatureDirs)
      ? input.signatureDirs.filter(item => typeof item === 'string'
        && item.length > 0
        && item !== '.'
        && item !== '..'
        && !item.includes('/')
        && !item.includes('\\'))
      : [...ACW_SIGNATURE_DIRS],
    templateUrl: typeof input.templateUrl === 'string' && input.templateUrl.length > 0
      ? input.templateUrl
      : DEFAULT_TEMPLATE_URL,
    templateBranch: typeof input.templateBranch === 'string' && input.templateBranch.length > 0
      ? input.templateBranch
      : 'main',
    templateCacheDir: cacheDir,
    refreshTemplate: input.refreshTemplate === true,
    prewarmTemplate: input.prewarmTemplate !== false,
    keepTemplateHistory: input.keepTemplateHistory === true,
    title: input.title === 'original' ? 'original' : 'directory',
    syncTitles: input.syncTitles !== false,
    initPrompt: input.initPrompt === 'off' ? 'off' : 'first-turn',
    initSkill: typeof input.initSkill === 'string' && input.initSkill.length > 0
      ? input.initSkill.split(path.sep).join('/')
      : DEFAULT_INIT_SKILL,
    skipWhenSessionsExist: input.skipWhenSessionsExist !== false,
    cloneTimeoutMs: Number.isFinite(input.cloneTimeoutMs) && input.cloneTimeoutMs > 0
      ? Math.trunc(input.cloneTimeoutMs)
      : 120_000,
    protectedPaths: Array.isArray(input.protectedPaths)
      ? input.protectedPaths.filter(item => typeof item === 'string' && path.isAbsolute(item))
      : [],
    sessionLogRoot: typeof input.sessionLogRoot === 'string' && input.sessionLogRoot.length > 0
      ? path.resolve(input.sessionLogRoot)
      : path.join(os.homedir(), '.dsh', 'sessions'),
  }
}

/**
 * 判断 `child` 是否位于 `parent` 之内（含自身由调用方另行判断）。
 *
 * @param {string} child - 绝对路径。
 * @param {string} parent - 绝对路径。
 * @returns {boolean} 是否在其子树内。
 */
function isStrictlyInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * 异步判断路径是否存在。
 *
 * @param {string} target - 绝对路径。
 * @returns {Promise<boolean>} 是否存在。
 */
async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * 目录是否已经是 ACW 根。
 *
 * 判定顺序：`.acw-marker` 存在即认定（新工作区的显式戳记）；否则看结构特征——
 * `signatureDirs`（默认 background / conventions / artifacts / .agents）全部存在
 * 也认定为 ACW，用来兼容没有 marker 的老工作区。
 *
 * @param {string} dir - 绝对路径。
 * @param {object} options - 规范化选项。
 * @returns {Promise<boolean>} 是否已是 ACW 根。
 */
export async function isAcwRoot(dir, options) {
  return isAcwRootSync(dir, options)
}

/**
 * `isAcwRoot` 的同步版本，供会话首轮提示这类同步判定使用。
 *
 * @param {string} dir - 绝对路径。
 * @param {object} options - 规范化选项。
 * @returns {boolean} 是否已是 ACW 根。
 */
export function isAcwRootSync(dir, options) {
  if (existsSync(path.join(dir, options.marker))) return true
  const signature = options.signatureDirs ?? []
  if (signature.length === 0) return false
  return signature.every((name) => {
    try {
      return statSync(path.join(dir, name)).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 向上查找最近的 ACW 祖先目录。
 *
 * @param {string} dir - 绝对路径。
 * @param {object} options - 规范化选项。
 * @returns {Promise<string | undefined>} 祖先 ACW 根，或 undefined。
 */
async function findAcwAncestor(dir, options) {
  let current = path.dirname(dir)
  while (true) {
    if (await isAcwRoot(current, options)) return current
    const next = path.dirname(current)
    if (next === current) return undefined
    current = next
  }
}

/**
 * 是否命中用户配置的保护区（家目录、系统目录、DSH 数据目录等）。
 *
 * @param {string} real - 解析后的绝对路径。
 * @param {object} options - 规范化选项。
 * @returns {string | undefined} 命中的原因，未命中为 undefined。
 */
function protectedReason(real, options) {
  const home = os.homedir()
  const exact = new Set([
    path.parse(real).root,
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'Library'),
    path.join(home, 'Applications'),
    path.join(home, '.dsh'),
    '/Users',
    '/Applications',
    '/System',
    '/Library',
    '/Volumes',
    '/private',
    '/tmp',
    '/opt',
    '/usr',
    '/var',
    ...options.protectedPaths,
  ])
  if (exact.has(real)) return 'protected'
  if (isStrictlyInside(real, path.join(home, '.dsh'))) return 'dsh-data'
  if (real === options.templateCacheDir || isStrictlyInside(real, options.templateCacheDir)) return 'template-cache'
  return undefined
}

/**
 * 复刻 DSH 会话日志的 projectKey 编码，用于判断该目录是否已有历史会话。
 *
 * @param {string} cwd - 会话工作目录。
 * @returns {string} 会话日志目录名。
 */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index++) {
    const char = cwd[index]
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (/^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 该目录是否已经被会话使用过（有历史会话就无法安全搬动）。
 *
 * @param {string} real - 解析后的绝对路径。
 * @param {object} options - 规范化选项。
 * @param {object} [ctx] - Cordis 上下文，用于读取活动会话。
 * @returns {Promise<boolean>} 是否存在历史会话。
 */
async function hasRecordedSessions(real, options, ctx) {
  try {
    const sessions = ctx?.get?.('sessions')
    for (const session of sessions?.list?.() ?? []) {
      const cwd = session?.header?.cwd ?? session?.cwd
      if (cwd === real) return true
    }
  } catch {
    // 读取活动会话失败不影响主流程。
  }
  return pathExists(path.join(options.sessionLogRoot, projectKey(real)))
}

/**
 * 模板缓存是否可用。
 *
 * @param {string} dir - 缓存目录。
 * @returns {Promise<boolean>} 是否是可用的模板。
 */
async function templateReady(dir) {
  return (await pathExists(path.join(dir, 'AGENTS.md')))
    && (await pathExists(path.join(dir, 'projects')))
}

/** 同一缓存目录只允许一次并发 clone。 */
const templateLocks = new Map()

/**
 * 确保本地模板缓存存在；需要时 `git clone` 官方仓库。
 *
 * @param {object} options - 规范化选项。
 * @param {(message: string) => void} [log] - 日志回调。
 * @returns {Promise<string>} 模板目录。
 */
export async function ensureTemplate(options, log = () => {}) {
  const cache = options.templateCacheDir
  if (!options.refreshTemplate && await templateReady(cache)) return cache

  const pending = templateLocks.get(cache)
  if (pending !== undefined) return pending

  const task = (async () => {
    await fs.mkdir(path.dirname(cache), { recursive: true })
    const staging = `${cache}.clone-${process.pid}-${Date.now()}`
    await fs.rm(staging, { recursive: true, force: true })
    try {
      log(`正在克隆 ACW 模板：${options.templateUrl}`)
      await execFileAsync(
        'git',
        ['clone', '--depth', '1', '--single-branch', '--branch', options.templateBranch, options.templateUrl, staging],
        { timeout: options.cloneTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
      )
      if (!(await templateReady(staging))) {
        throw new Error('模板仓库缺少 AGENTS.md 或 projects/ 目录')
      }
      await fs.rm(cache, { recursive: true, force: true })
      await fs.rename(staging, cache)
      log(`ACW 模板缓存已就绪：${cache}`)
      return cache
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      if (await templateReady(cache)) {
        log(`ACW 模板更新失败，沿用本地缓存：${cache}（${describe(error)}）`)
        return cache
      }
      throw new Error(
        `无法获取 AI Context Workspace 模板（${options.templateUrl}）：${describe(error)}。`
        + `请检查网络与 git 后重试，或手动把模板放到 ${cache}`,
        { cause: error },
      )
    }
  })().finally(() => templateLocks.delete(cache))

  templateLocks.set(cache, task)
  return task
}

/**
 * 把模板复制进目标目录，排除 .git、marker 以及模板自身的历史 artifact。
 *
 * @param {string} templateDir - 模板目录。
 * @param {string} destDir - 目标目录（已存在且为空）。
 * @param {object} options - 规范化选项。
 * @returns {Promise<void>} 复制完成。
 */
async function copyTemplate(templateDir, destDir, options) {
  const archivedDir = path.join('artifacts', '_archived')
  await fs.cp(templateDir, destDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    verbatimSymlinks: true,
    filter: (source) => {
      const relative = path.relative(templateDir, source)
      if (relative === '') return true
      const [head] = relative.split(path.sep)
      const name = path.basename(source)
      if (head === '.git') return false
      if (name === options.marker || name === '.DS_Store') return false
      if (!options.keepTemplateHistory) {
        if (relative === archivedDir) return true
        if (relative.startsWith(`${archivedDir}${path.sep}`)) return false
      }
      return true
    },
  })
}

/**
 * 把错误压成一行文案。
 *
 * @param {unknown} error - 任意错误。
 * @returns {string} 文案。
 */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 在 `parent` 下搭建脚手架、搬入原目录、最后原子改名到 `target`。
 *
 * @param {object} input - 参数集合。
 * @param {string} input.real - 原目录的真实路径。
 * @param {string} input.base - 原目录名。
 * @param {string} input.target - ACW 根目标路径。
 * @param {string} input.templateDir - 模板目录。
 * @param {object} input.options - 规范化选项。
 * @param {(message: string) => void} input.log - 日志回调。
 * @returns {Promise<object>} 转换结果。
 */
async function stageAndPublish({ real, base, target, templateDir, options, log }) {
  const parent = path.dirname(real)
  const partial = path.join(parent, `.${base}${options.suffix}.partial-${process.pid}-${Date.now()}`)
  let movedTo
  let published = false

  try {
    await fs.mkdir(partial, { recursive: false })
    await copyTemplate(templateDir, partial, options)
    if (!(await pathExists(path.join(partial, 'AGENTS.md')))) {
      throw new Error('模板复制不完整：缺少 AGENTS.md')
    }
    const projectsDir = path.join(partial, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    movedTo = path.join(projectsDir, base)
    if (await pathExists(movedTo)) {
      throw new Error(`目标位置已存在：${movedTo}`)
    }

    // 1) 原目录整体搬进脚手架；2) 脚手架原子改名为正式路径。
    await fs.rename(real, movedTo)
    await fs.rename(partial, target)
    published = true

    if (options.writeMarker) {
      try {
        await fs.writeFile(path.join(target, options.marker), MARKER_CONTENT, { mode: 0o644 })
      } catch (error) {
        log(`已转换但写入 ${options.marker} 失败：${describe(error)}`)
      }
    }
    log(`已转换：${real} → ${target}（原内容位于 ${path.join('projects', base)}）`)
    return { path: target, base, converted: true, reason: 'converted' }
  } catch (error) {
    if (published) {
      // 已经发布就不再回滚，避免更坏的状态；把现状告诉调用方。
      const source = error instanceof Error ? error : new Error(String(error))
      throw new Error(`${describe(source)}（已发布的目录：${target}）`, { cause: source })
    }
    if (movedTo !== undefined) {
      try {
        await fs.rename(movedTo, real)
      } catch (rollbackError) {
        const message = `${describe(error)}（回滚失败：原目录内容现位于 ${movedTo}，${
          describe(rollbackError)}）`
        throw new Error(message, { cause: error })
      }
    }
    await fs.rm(partial, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * 把选中目录转换为 ACW 布局。
 *
 * 返回 `converted: false` 表示「按原样注册」：目录本身已是 ACW、位于 ACW 内、
 * 命中保护区、或已有历史会话等；调用方应继续用 `path` 注册工作区。
 *
 * @param {string} pickedPath - 用户选中的目录。
 * @param {object} options - {@link normalizeOptions} 的结果。
 * @param {object} [hooks] - 可选回调。
 * @param {(message: string) => void} [hooks.log] - 信息日志。
 * @param {(message: string) => void} [hooks.warn] - 警告日志。
 * @param {object} [hooks.ctx] - Cordis 上下文。
 * @returns {Promise<{path: string, base: string, converted: boolean, reason: string}>} 结果。
 */
export async function convertWorkspaceDirectory(pickedPath, options, hooks = {}) {
  const log = hooks.log ?? (() => {})
  const warn = hooks.warn ?? log
  const skip = (real, reason, base = path.basename(real)) => ({ path: real, base, converted: false, reason })

  const real = await fs.realpath(pickedPath).catch(() => undefined)
  if (real === undefined) return { path: pickedPath, base: path.basename(pickedPath), converted: false, reason: 'missing' }

  const stat = await fs.stat(real).catch(() => undefined)
  if (stat === undefined || !stat.isDirectory()) return skip(real, 'not-directory')

  if (await isAcwRoot(real, options)) return skip(real, 'already-acw')
  if (path.basename(real).endsWith(options.suffix)) {
    warn(`目录名已带 ${options.suffix} 后缀，按原样注册：${real}`)
    return skip(real, 'suffixed')
  }

  const ancestor = await findAcwAncestor(real, options)
  if (ancestor !== undefined) {
    warn(`目录位于已有 ACW 内（${ancestor}），按原样注册：${real}`)
    return skip(real, 'inside-acw')
  }

  const guarded = protectedReason(real, options)
  if (guarded !== undefined) {
    warn(`目录命中保护区（${guarded}），按原样注册：${real}`)
    return skip(real, guarded)
  }

  const base = path.basename(real)
  const target = path.join(path.dirname(real), `${base}${options.suffix}`)
  if (await pathExists(target)) {
    throw new Error(
      `无法转换 ${real}：目标目录已存在 ${target}。`
      + '请先删除/改名该目录，或直接选择它。',
    )
  }

  if (options.skipWhenSessionsExist && await hasRecordedSessions(real, options, hooks.ctx)) {
    warn(`目录已有历史会话，搬动会破坏这些会话，按原样注册：${real}`)
    return skip(real, 'has-sessions')
  }

  const templateDir = await ensureTemplate(options, log)
  return stageAndPublish({ real, base, target, templateDir, options, log })
}
