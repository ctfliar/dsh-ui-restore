/**
 * dsh-ui-restore · 内置 SKILL 自动注册
 *
 * 插件包自带 `skills/ui-restore/SKILL.md`，但 DSH 的技能发现根（项目 / 用户 /
 * customSkillDirs / bundledSkillDir）都指向外部目录，profile 里的插件包不在其中。
 * 这里用 `ctx.skills.register()` 把它注册成 runtime skill（rank 250）：
 * 安装后新会话的 skill 目录直接就能看到 `ui-restore`，用户不需要手工拷贝。
 *
 * 路径由 `import.meta.url` 推导（`PLUGIN_ROOT`），源码里不出现任何本机绝对路径。
 * 注册用 `ctx.inject(['skills'], ...)` 做可选依赖：没有 skills service 的精简组合
 * 只是不注册技能，不会阻止四个工具挂载。
 *
 * @module dsh-ui-restore/skill
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './paths.js';

/** runtime skill 名称（kebab-case，与 SKILL.md 的主题一致）。 */
export const SKILL_NAME = 'ui-restore';
/** 包内技能目录（运行时由包位置解析）。 */
export const SKILL_DIR = join(PLUGIN_ROOT, 'skills', SKILL_NAME);
/** 包内 SKILL.md 绝对路径。 */
export const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');

/** 模型侧路由描述（catalog 里显示）。 */
export const SKILL_DESCRIPTION = 'UI 还原闭环：按设计稿/项目规范实现前端页面，用截图、像素差异与样式探针量化验收并产出报告。';
/** 补充使用场景。 */
export const SKILL_WHEN_TO_USE = '当任务要求实现或验收前端页面、需要量化「还原度」，或要建立可复用的 UI 验收闭环时使用。';

/**
 * 去掉 SKILL.md 的 YAML frontmatter，只留正文。
 * runtime skill 的 content 约定是「去掉 provider 元数据后的 Markdown 正文」。
 * @param {string} markdown 原始文件内容
 * @returns {string} 正文
 */
export function stripFrontmatter(markdown) {
  const text = String(markdown ?? '');
  if (!text.startsWith('---')) return text;
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

/**
 * 读取包内 SKILL.md，组装成 `ctx.skills.register()` 需要的技能定义。
 * 文件缺失（例如只拷贝了 lib 的开发副本）时返回 undefined，不影响插件其余功能。
 * @returns {{ name: string, description: string, whenToUse: string, content: string, resourceBase: { kind: 'directory', path: string } }|undefined}
 */
export function readBundledSkill() {
  if (!existsSync(SKILL_FILE)) return undefined;
  const raw = readFileSync(SKILL_FILE, 'utf8');
  const content = stripFrontmatter(raw);
  if (content.trim() === '') return undefined;
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    content,
    source: 'runtime',
    path: SKILL_FILE,
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  };
}

/**
 * 把包内 SKILL 注册成 runtime skill。
 *
 * `ctx.inject(['skills'], ...)` 是 Cordis 的可选依赖注入：skills service 就绪时
 * 才执行注册回调；缺失时回调永不执行，插件本身照常挂载。注册返回的 disposer
 * 由 `skillCtx.effect()` 持有，插件卸载时会自动注销。
 *
 * @param {object} ctx 插件上下文（需要 `inject`；测试可传假对象）
 * @returns {boolean} 是否发起了注册
 */
export function registerBundledSkill(ctx) {
  if (typeof ctx?.inject !== 'function') return false;
  const skill = readBundledSkill();
  if (skill === undefined) return false;
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => skillCtx.skills.register(skill), 'ui-restore: register bundled skill');
  });
  return true;
}
