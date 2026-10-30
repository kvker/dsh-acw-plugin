import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

/**
 * 造最小模板 + 一个假 ctx，用来在不启动 DSH 的情况下验证包装逻辑。
 *
 * @returns {Promise<{root: string, ctx: object, calls: object[], dispose: Function}>} 环境。
 */
async function harness(config = {}, existing = [], agents = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acw-plugin-ctx-')))
  const template = path.join(root, 'template')
  await fs.mkdir(path.join(template, 'projects'), { recursive: true })
  await fs.mkdir(path.join(template, 'conventions'), { recursive: true })
  await fs.writeFile(path.join(template, 'AGENTS.md'), '# ACW\n')

  const calls = []
  const disposers = []
  const messages = []
  const listeners = new Map()
  const sections = []
  const originalCreate = async function create(picked, title) {
    const workspace = { path: picked, title: title ?? path.basename(picked) }
    calls.push(workspace)
    return workspace
  }
  const registry = { create: originalCreate, list: () => existing }
  const ctx = {
    logger: {
      info: (message) => messages.push(`info ${message}`),
      warn: (message) => messages.push(`warn ${message}`),
    },
    workspaceRegistry: registry,
    agents: { list: () => agents },
    get: () => ({ list: () => [] }),
    on: (name, handler) => {
      listeners.set(name, handler)
    },
    effect: (factory) => {
      disposers.push(factory())
    },
  }

  apply(ctx, {
    templateCacheDir: template,
    sessionLogRoot: path.join(root, 'sessions'),
    prewarmTemplate: false,
    ...config,
  })

  return {
    root,
    ctx,
    calls,
    messages,
    sections,
    listeners,
    originalCreate,
    dispose: () => {
      for (const dispose of [...disposers].reverse()) {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

test('拦截 create：注册转换后的 ACW 路径，标题用目录名', async () => {
  const { root, ctx, calls } = await harness()
  const picked = path.join(root, 'foo')
  await fs.mkdir(picked)
  await fs.writeFile(path.join(picked, 'README.md'), '# hello\n')

  const workspace = await ctx.workspaceRegistry.create(picked)

  assert.equal(workspace.path, path.join(root, 'foo--acw'))
  assert.equal(workspace.title, 'foo--acw')
  assert.equal(calls.length, 1)
  assert.equal(
    await fs.readFile(path.join(root, 'foo--acw', 'projects', 'foo', 'README.md'), 'utf8'),
    '# hello\n',
  )
})

test("title: 'original' 时仍用原目录名做标题", async () => {
  const { root, ctx } = await harness({ title: 'original' })
  const picked = path.join(root, 'foo')
  await fs.mkdir(picked)

  const workspace = await ctx.workspaceRegistry.create(picked)

  assert.equal(workspace.title, 'foo')
})

test('已转换目录按原样注册', async () => {
  const { root, ctx } = await harness()
  const picked = path.join(root, 'foo')
  await fs.mkdir(picked)

  await ctx.workspaceRegistry.create(picked)
  const again = await ctx.workspaceRegistry.create(path.join(root, 'foo--acw'))

  assert.equal(again.path, path.join(root, 'foo--acw'))
})

test('每次处理都写 last-run.json 诊断记录', async () => {
  const { root, ctx } = await harness()
  const picked = path.join(root, 'foo')
  await fs.mkdir(picked)

  await ctx.workspaceRegistry.create(picked)
  const status = JSON.parse(await fs.readFile(path.join(root, 'last-run.json'), 'utf8'))

  assert.equal(status.converted, true)
  assert.equal(status.picked, picked)
  assert.equal(status.workspace.path, path.join(root, 'foo--acw'))
  assert.equal(status.workspace.title, 'foo--acw')

  await ctx.workspaceRegistry.create(picked + '--acw')
  const skipped = JSON.parse(await fs.readFile(path.join(root, 'last-run.json'), 'utf8'))
  assert.equal(skipped.converted, false)
  assert.equal(skipped.reason, 'already-acw')
})

test('enabled: false 时完全不动 create', async () => {
  const { root, ctx, originalCreate } = await harness({ enabled: false })
  assert.equal(ctx.workspaceRegistry.create, originalCreate)
  assert.equal(typeof root, 'string')
})

test('卸载后恢复原始的 create', async () => {
  const { ctx, originalCreate, dispose } = await harness()
  assert.notEqual(ctx.workspaceRegistry.create, originalCreate)

  dispose()

  assert.equal(ctx.workspaceRegistry.create, originalCreate)
})

test("title: 'original' 时不同步旧标题", async () => {
  let touched = false
  const legacy = {
    path: '/work/bar--acw',
    title: 'bar',
    setTitle: async () => {
      touched = true
    },
  }
  await harness({ title: 'original' }, [legacy])
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(touched, false)
  assert.equal(legacy.title, 'bar')
})

test('旧的「路径已是 --acw、标题还是原名」会被同步成目录名', async () => {
  const renamed = []
  const legacy = {
    path: '/work/bar--acw',
    title: 'bar',
    setTitle: async (title) => {
      legacy.title = title
      renamed.push(title)
    },
  }
  const custom = {
    path: '/work/keep--acw',
    title: '我的项目',
    setTitle: async () => {
      throw new Error('不该动用户自定义标题')
    },
  }
  const { messages } = await harness({}, [legacy, custom])
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(renamed, ['bar--acw'])
  assert.equal(legacy.title, 'bar--acw')
  assert.equal(custom.title, '我的项目')
  assert.ok(messages.some(message => message.includes('标题已同步')))
})

/**
 * 造一个假的 Agent，记录注册到它作用域里的系统提示段落。
 *
 * @param {{cwd: string, depth?: number, events?: object[]}} input - 目录、子代理深度、会话事件。
 * @returns {{agent: object, sections: object[]}} 假 Agent 与段落数组。
 */
function fakeAgent({ cwd, depth = 0, events = [{ type: 'user/message' }] }) {
  const sections = []
  const agent = {
    options: { subagentDepth: depth },
    session: { header: { cwd }, snapshotEvents: () => events },
    ctx: {
      inject: (_deps, callback) => {
        callback({
          systemPrompt: {
            section: (section) => {
              sections.push(section)
              return { dispose: async () => {} }
            },
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  return { agent, sections }
}

/**
 * 布置一个 ACW 目录，可选放 an-init 技能。
 *
 * @param {string} dir - 目录。
 * @param {boolean} withSkill - 是否放技能。
 * @returns {Promise<void>} 完成。
 */
async function makeAcwDir(dir, withSkill = true) {
  for (const name of ['background', 'conventions', 'artifacts', '.agents']) {
    await fs.mkdir(path.join(dir, name), { recursive: true })
  }
  if (withSkill) {
    const skill = path.join(dir, '.agents/skills/an-init/SKILL.md')
    await fs.mkdir(path.dirname(skill), { recursive: true })
    await fs.writeFile(skill, '# an-init\n')
  }
}

test('ACW 未初始化时，首轮返回一次 an-init 提示', async () => {
  const { root } = await harness()
  const workspace = path.join(root, 'demo--acw')
  await makeAcwDir(workspace, true)
  const { agent, sections } = fakeAgent({ cwd: workspace })
  await harness({}, [], [agent])

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'context:acw-init')
  assert.match(sections[0].text(), /ask_user_question/)
  assert.equal(sections[0].text(), '')
})

test('会话还没有用户消息时不消耗提示', async () => {
  const { root } = await harness()
  const workspace = path.join(root, 'demo--acw')
  await makeAcwDir(workspace, true)
  const events = []
  const { agent, sections } = fakeAgent({ cwd: workspace, events })
  await harness({}, [], [agent])

  assert.equal(sections.length, 1)
  assert.equal(sections[0].text(), '')
  events.push({ type: 'user/message' })
  assert.match(sections[0].text(), /ask_user_question/)
  assert.equal(sections[0].text(), '')
})

test('an-init 技能已消失时不再挂提示', async () => {
  const { root } = await harness()
  const workspace = path.join(root, 'demo--acw')
  await makeAcwDir(workspace, false)
  const { agent, sections } = fakeAgent({ cwd: workspace })
  await harness({}, [], [agent])

  assert.equal(sections.length, 0)
})

test('子代理与 initPrompt: off 都不挂提示', async () => {
  const { root } = await harness()
  const workspace = path.join(root, 'demo--acw')
  await makeAcwDir(workspace, true)

  const child = fakeAgent({ cwd: workspace, depth: 2 })
  await harness({}, [], [child.agent])
  assert.equal(child.sections.length, 0)

  const disabled = fakeAgent({ cwd: workspace })
  await harness({ initPrompt: 'off' }, [], [disabled.agent])
  assert.equal(disabled.sections.length, 0)
})

test('新建的 Agent 也会通过 agent/created 挂上提示', async () => {
  const { root, listeners } = await harness()
  const workspace = path.join(root, 'demo--acw')
  await makeAcwDir(workspace, true)
  const { agent, sections } = fakeAgent({ cwd: workspace })

  listeners.get('agent/created')({ agent })

  assert.equal(sections.length, 1)
})
