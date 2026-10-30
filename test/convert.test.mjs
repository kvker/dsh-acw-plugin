import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  convertWorkspaceDirectory,
  isAcwRoot,
  normalizeOptions,
} from '../lib/convert.js'

/**
 * 造一份最小 ACW 模板，避免测试联网。
 *
 * @param {string} root - 临时根目录。
 * @returns {Promise<string>} 模板目录。
 */
async function makeTemplate(root) {
  const template = path.join(root, 'template')
  await fs.mkdir(path.join(template, 'projects'), { recursive: true })
  await fs.mkdir(path.join(template, 'conventions'), { recursive: true })
  await fs.mkdir(path.join(template, 'background'), { recursive: true })
  await fs.mkdir(path.join(template, 'artifacts', '_archived', 'demo'), { recursive: true })
  await fs.mkdir(path.join(template, '.agents', 'skills', 'an-init'), { recursive: true })
  await fs.mkdir(path.join(template, '.git'), { recursive: true })
  await fs.writeFile(path.join(template, 'AGENTS.md'), '# ACW\n')
  await fs.writeFile(path.join(template, 'projects', 'AGENTS.md'), '# projects\n')
  await fs.writeFile(path.join(template, 'conventions', 'AGENTS.md'), '# conventions\n')
  await fs.writeFile(path.join(template, 'artifacts', 'index.json'), '{}\n')
  await fs.writeFile(path.join(template, 'artifacts', '_archived', 'demo', 'artifact.json'), '{}\n')
  await fs.writeFile(path.join(template, '.agents', 'skills', 'an-init', 'SKILL.md'), '# an-init\n')
  await fs.writeFile(path.join(template, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await fs.writeFile(path.join(template, '.gitignore'), '.DS_Store\n')
  return template
}

/**
 * 建立干净的测试沙盒。
 *
 * @returns {Promise<{root: string, options: object}>} 根目录与选项。
 */
async function sandbox() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acw-plugin-')))
  const templateCacheDir = await makeTemplate(root)
  const options = normalizeOptions({
    templateCacheDir,
    sessionLogRoot: path.join(root, 'sessions'),
    prewarmTemplate: false,
  })
  return { root, options }
}

/**
 * 造一个待转换的项目目录。
 *
 * @param {string} parent - 父目录。
 * @param {string} name - 目录名。
 * @returns {Promise<string>} 目录路径。
 */
async function makeProject(parent, name = 'foo') {
  const dir = path.join(parent, name)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(path.join(dir, 'README.md'), '# hello\n')
  await fs.writeFile(path.join(dir, 'src', 'main.js'), 'console.log(1)\n')
  return dir
}

test('选中目录转换成 <名字>--acw 且原内容进 projects/<名字>/', async () => {
  const { root, options } = await sandbox()
  const picked = await makeProject(root)

  const outcome = await convertWorkspaceDirectory(picked, options)

  const target = path.join(root, 'foo--acw')
  assert.equal(outcome.converted, true)
  assert.equal(outcome.path, target)
  assert.equal(outcome.base, 'foo')

  assert.equal(await fs.readFile(path.join(target, '.acw-marker'), 'utf8'), '1\n')
  assert.equal(await fs.readFile(path.join(target, 'AGENTS.md'), 'utf8'), '# ACW\n')
  assert.equal(await fs.readFile(path.join(target, 'projects', 'foo', 'README.md'), 'utf8'), '# hello\n')
  assert.equal(await fs.readFile(path.join(target, 'projects', 'foo', 'src', 'main.js'), 'utf8'), 'console.log(1)\n')
  assert.equal(await fs.readFile(path.join(target, 'projects', 'AGENTS.md'), 'utf8'), '# projects\n')

  // 原路径已经不存在，模板的 .git 与模板自身历史 artifact 不复制
  await assert.rejects(fs.access(picked))
  await assert.rejects(fs.access(path.join(target, '.git')))
  assert.deepEqual(await fs.readdir(path.join(target, 'artifacts', '_archived')), [])
  assert.equal(await fs.readFile(path.join(target, '.gitignore'), 'utf8'), '.DS_Store\n')

  assert.equal(await isAcwRoot(target, options), true)
})

test('marker 决定幂等：再次选中已转换目录按原样注册', async () => {
  const { root, options } = await sandbox()
  const picked = await makeProject(root)
  const first = await convertWorkspaceDirectory(picked, options)

  const second = await convertWorkspaceDirectory(first.path, options)

  assert.equal(second.converted, false)
  assert.equal(second.reason, 'already-acw')
  assert.equal(second.path, first.path)
})

test('老工作区没有 marker，靠四个目录识别为 ACW', async () => {
  const { root, options } = await sandbox()
  const legacy = path.join(root, 'legacy-acw')
  for (const dir of ['background', 'conventions', 'artifacts', '.agents', 'projects']) {
    await fs.mkdir(path.join(legacy, dir), { recursive: true })
  }
  await fs.writeFile(path.join(legacy, 'AGENTS.md'), '# legacy\n')

  assert.equal(await fs.access(path.join(legacy, '.acw-marker')).then(() => true, () => false), false)
  assert.equal(await isAcwRoot(legacy, options), true)

  const outcome = await convertWorkspaceDirectory(legacy, options)

  assert.equal(outcome.converted, false)
  assert.equal(outcome.reason, 'already-acw')
  assert.equal(outcome.path, legacy)
})

test('缺少任一特征目录时仍按普通目录转换', async () => {
  const { root, options } = await sandbox()
  const partial = path.join(root, 'partial')
  for (const dir of ['background', 'conventions', 'artifacts']) {
    await fs.mkdir(path.join(partial, dir), { recursive: true })
  }

  const outcome = await convertWorkspaceDirectory(partial, options)

  assert.equal(outcome.converted, true)
  assert.equal(outcome.path, path.join(root, 'partial--acw'))
})

test('特征目录是文件而不是目录时不算 ACW', async () => {
  const { root, options } = await sandbox()
  const tricky = path.join(root, 'tricky')
  await fs.mkdir(tricky, { recursive: true })
  for (const name of ['background', 'conventions', 'artifacts', '.agents']) {
    await fs.writeFile(path.join(tricky, name), 'not a dir\n')
  }

  assert.equal(await isAcwRoot(tricky, options), false)
})

test('writeMarker: false 时不写 marker，但目录特征仍可识别', async () => {
  const { root, options } = await sandbox()
  const noMarker = normalizeOptions({ ...options, writeMarker: false })
  const picked = await makeProject(root)

  const outcome = await convertWorkspaceDirectory(picked, noMarker)

  assert.equal(outcome.converted, true)
  assert.equal(await fs.access(path.join(outcome.path, '.acw-marker')).then(() => true, () => false), false)
  assert.equal(await isAcwRoot(outcome.path, noMarker), true)
})

test('目标目录已存在时报错而不是覆盖', async () => {
  const { root, options } = await sandbox()
  const picked = await makeProject(root)
  await fs.mkdir(path.join(root, 'foo--acw'))
  await fs.writeFile(path.join(root, 'foo--acw', 'keep.txt'), 'keep\n')

  await assert.rejects(
    convertWorkspaceDirectory(picked, options),
    /目标目录已存在/,
  )
  assert.equal(await fs.readFile(path.join(root, 'foo--acw', 'keep.txt'), 'utf8'), 'keep\n')
  assert.equal(await fs.readFile(path.join(picked, 'README.md'), 'utf8'), '# hello\n')
})

test('目录名已带后缀时按原样注册', async () => {
  const { root, options } = await sandbox()
  const picked = await makeProject(root, 'bar--acw')

  const outcome = await convertWorkspaceDirectory(picked, options)

  assert.equal(outcome.converted, false)
  assert.equal(outcome.reason, 'suffixed')
  assert.equal(outcome.path, picked)
})

test('位于已有 ACW 内时按原样注册', async () => {
  const { root, options } = await sandbox()
  const picked = await makeProject(root)
  const converted = await convertWorkspaceDirectory(picked, options)

  // 原项目现在位于 <acw>/projects/foo：自身不是 ACW 根，但祖先 foo--acw 是。
  const outcome = await convertWorkspaceDirectory(path.join(converted.path, 'projects', 'foo'), options)

  assert.equal(outcome.converted, false)
  assert.equal(outcome.reason, 'inside-acw')
  assert.equal(outcome.path, path.join(converted.path, 'projects', 'foo'))
})

test('命中保护区时按原样注册', async () => {
  const { root, options } = await sandbox()
  const picked = await makeProject(root)
  const guarded = normalizeOptions({ ...options, protectedPaths: [picked] })

  const outcome = await convertWorkspaceDirectory(picked, guarded)

  assert.equal(outcome.converted, false)
  assert.equal(outcome.reason, 'protected')
})

test('已有历史会话时按原样注册，避免破坏会话', async () => {
  const { root, options } = await sandbox()
  const picked = await makeProject(root)
  const key = `--${picked.replace(/^\/+/, '').replace(/[\\/]+/g, '-')}--`
  await fs.mkdir(path.join(options.sessionLogRoot, key), { recursive: true })

  const outcome = await convertWorkspaceDirectory(picked, options)

  assert.equal(outcome.converted, false)
  assert.equal(outcome.reason, 'has-sessions')
  assert.equal(await fs.readFile(path.join(picked, 'README.md'), 'utf8'), '# hello\n')
})

test('不存在的路径按原样返回，不抛错', async () => {
  const { root, options } = await sandbox()
  const missing = path.join(root, 'nope')

  const outcome = await convertWorkspaceDirectory(missing, options, { ctx: undefined })

  assert.equal(outcome.converted, false)
  assert.equal(outcome.reason, 'missing')
  assert.equal(outcome.path, missing)
})

test('keepTemplateHistory 保留模板自带的历史 artifact', async () => {
  const { root, options } = await sandbox()
  const picked = await makeProject(root)
  const kept = normalizeOptions({ ...options, keepTemplateHistory: true })

  const outcome = await convertWorkspaceDirectory(picked, kept)

  assert.equal(
    await fs.readFile(path.join(outcome.path, 'artifacts', '_archived', 'demo', 'artifact.json'), 'utf8'),
    '{}\n',
  )
})
