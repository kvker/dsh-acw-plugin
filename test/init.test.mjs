import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { normalizeOptions } from '../lib/convert.js'
import { buildInitPromptText, DEFAULT_INIT_SKILL, initState } from '../lib/init.js'

/**
 * 造一个临时目录。
 *
 * @returns {Promise<string>} 真实路径。
 */
async function tempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acw-init-')))
}

/**
 * 把目录布置成 ACW 结构。
 *
 * @param {string} dir - 目标目录。
 * @param {boolean} withSkill - 是否放 an-init 技能。
 * @returns {Promise<void>} 完成。
 */
async function makeAcw(dir, withSkill = true) {
  for (const name of ['background', 'conventions', 'artifacts', '.agents']) {
    await fs.mkdir(path.join(dir, name), { recursive: true })
  }
  if (withSkill) {
    const skill = path.join(dir, DEFAULT_INIT_SKILL)
    await fs.mkdir(path.dirname(skill), { recursive: true })
    await fs.writeFile(skill, '# an-init\n')
  }
}

/** 默认选项。 */
const options = normalizeOptions({ prewarmTemplate: false, templateCacheDir: '/nonexistent/template' })

test('ACW 且 an-init 技能还在 => 待初始化', async () => {
  const dir = await tempDir()
  await makeAcw(dir, true)

  const state = initState(dir, options)

  assert.equal(state.acw, true)
  assert.equal(state.skill, true)
  assert.equal(state.pending, true)
})

test('an-init 技能已消失 => 不再提示', async () => {
  const dir = await tempDir()
  await makeAcw(dir, true)
  await fs.rm(path.join(dir, DEFAULT_INIT_SKILL))

  const state = initState(dir, options)

  assert.equal(state.acw, true)
  assert.equal(state.skill, false)
  assert.equal(state.pending, false)
})

test('不是 ACW 的目录即便有同名技能文件也不提示', async () => {
  const dir = await tempDir()
  const skill = path.join(dir, DEFAULT_INIT_SKILL)
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, '# an-init\n')

  const state = initState(dir, options)

  assert.equal(state.acw, false)
  assert.equal(state.pending, false)
})

test('目录不可用/相对路径时安全返回', async () => {
  assert.equal(initState(undefined, options).pending, false)
  assert.equal(initState('', options).pending, false)
  assert.equal(initState('relative/path', options).pending, false)
  assert.equal(initState('/definitely/not/here', options).pending, false)
})

test('initSkill 可配置', async () => {
  const dir = await tempDir()
  await makeAcw(dir, false)
  const custom = normalizeOptions({ ...options, initSkill: '.agents/skills/custom/SKILL.md' })
  const skill = path.join(dir, '.agents/skills/custom/SKILL.md')
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, '# custom\n')

  assert.equal(initState(dir, custom).pending, true)
})

test('提示文本包含 ask_user_question、an-init 与「只问一次」约束', () => {
  const text = buildInitPromptText()

  assert.match(text, /ask_user_question/)
  assert.match(text, /an-init/)
  assert.match(text, /Ask exactly once/i)
})
