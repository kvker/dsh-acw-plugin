/**
 * 会话首轮的 `$an-init` 提示：判断工作区是否「已是 ACW 但还没初始化」，
 * 并生成给模型的指令文本。
 *
 * 判定只依赖文件系统，不写任何状态：
 * - 工作区是 ACW（marker 或特征目录）；
 * - 且 `.agents/skills/an-init/SKILL.md` 仍然存在（`$an-init` 执行后会删除该技能）。
 *
 * @module dsh-acw-plugin/init
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_INIT_SKILL, isAcwRootSync } from './convert.js'

export { DEFAULT_INIT_SKILL }

/**
 * 判断一个会话目录是否「待初始化」。
 *
 * @param {string | undefined} cwd - 会话工作目录。
 * @param {object} options - {@link normalizeOptions} 的结果。
 * @returns {{ acw: boolean, skill: boolean, pending: boolean, cwd?: string }} 判定结果。
 */
export function initState(cwd, options) {
  if (typeof cwd !== 'string' || cwd.length === 0 || !path.isAbsolute(cwd)) {
    return { acw: false, skill: false, pending: false }
  }
  const acw = isAcwRootSync(cwd, options)
  if (!acw) return { acw: false, skill: false, pending: false, cwd }
  const skill = existsSync(path.join(cwd, options.initSkill))
  return { acw: true, skill, pending: skill, cwd }
}

/**
 * 给模型的首轮提示。指令用英文写（模型对英文指令更稳定），并要求用用户的语言发问。
 *
 * @returns {string} 系统提示段落文本。
 */
export function buildInitPromptText() {
  return [
    '## ACW workspace not initialized',
    '',
    'This workspace uses the AI Context Workspace (ACW) layout and still contains the one-time',
    '`$an-init` skill, so the workspace has not been initialized yet.',
    '',
    'On this first turn, before starting the user\'s actual work, ask the user once, using the',
    '`ask_user_question` tool, whether to initialize the workspace now. Offer exactly these two',
    'options: "Initialize now (recommended)" and "Not now". If the user chooses to initialize,',
    'invoke the `an-init` skill (the same thing as `$an-init`) and follow its instructions.',
    '',
    'Rules:',
    '- Ask exactly once in this conversation. If the user declines, continue with their request',
    '  and never bring it up again in this conversation.',
    '- If the `ask_user_question` tool is unavailable, mention the option in one short sentence',
    '  at the start of your reply instead, and still only once.',
    '- Skip the question entirely when the user already asked to initialize, or explicitly',
    '  declined, in this message.',
    '- Write the question in the language the user is writing in.',
  ].join('\n')
}
