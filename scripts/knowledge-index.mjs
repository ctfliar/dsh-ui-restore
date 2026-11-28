#!/usr/bin/env node
/**
 * dsh-ui-restore · 知识库索引生成 / 校验
 *
 * 扫描 `docs/knowledge/projects/<slug>/cases/*.md` 与 `docs/knowledge/patterns/`，
 * 生成 `docs/knowledge/INDEX.md`：
 * - 项目案例表：项目 / 案例 / 状态 / 日期 / 链接；
 * - patterns 资产表：文件 / 用途 / 链接。
 *
 * 状态与日期的解析顺序：
 * 1. 正文条目：`- 状态：✅ passed`、`- 日期：2026-11-26`（支持中英文冒号）；
 * 2. 文件名：`YYYY-MM-DD-<topic>-<status>.md`（status ∈ passed / failed / superseded）。
 *
 * 正文状态与文件名状态同时存在但不一致时直接报错，避免索引「看起来对、实际错了」。
 *
 * 用法：
 *   node scripts/knowledge-index.mjs            # 生成/刷新 INDEX.md
 *   node scripts/knowledge-index.mjs --check    # 只校验，不一致时退出码 1（CI/本地）
 *   node scripts/knowledge-index.mjs --help
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KNOWLEDGE_DIR = join(ROOT, 'docs', 'knowledge');
const INDEX_PATH = join(KNOWLEDGE_DIR, 'INDEX.md');
const ALLOWED_STATUSES = ['passed', 'failed', 'superseded'];
const STATUS_LABEL = {
  passed: '✅ passed',
  failed: '❌ failed',
  superseded: '↩️ superseded',
};

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const help = argv.includes('--help') || argv.includes('-h');

function helpText() {
  return [
    '知识库索引生成 / 校验',
    '',
    '用法：',
    '  node scripts/knowledge-index.mjs           生成/刷新 docs/knowledge/INDEX.md',
    '  node scripts/knowledge-index.mjs --check   只校验；索引缺失或不一致时退出码 1',
    '  node scripts/knowledge-index.mjs --help',
    '',
    '扫描范围：',
    '  docs/knowledge/projects/<slug>/cases/*.md   案例（项目/案例/状态/日期/链接）',
    '  docs/knowledge/patterns/                    跨项目配方与模板',
    '',
    '案例命名：YYYY-MM-DD-<topic>-<status>.md',
    '  status ∈ passed / failed / superseded；正文 `- 状态：...` 与文件名冲突时报错。',
  ].join('\n');
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

function compareName(a, b) {
  return a.name.localeCompare(b.name, 'en');
}

/** 取正文第一个一级标题。 */
function firstHeading(text) {
  const match = /^#\s+(.+?)\s*$/m.exec(text);
  return match ? match[1].trim() : '';
}

/** 解析 `- 标签：值` 条目（也接受 `*`、`**标签**`、英文冒号）。 */
function bulletValue(text, label) {
  const pattern = new RegExp(
    `^\\s*[-*]\\s*(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[：:]\\s*(.+?)\\s*$`,
    'm',
  );
  const match = pattern.exec(text);
  return match ? match[1].trim() : '';
}

function statusFromText(text) {
  const raw = bulletValue(text, '状态');
  if (!raw) return '';
  const match = /(passed|failed|superseded)/i.exec(raw);
  if (!match) {
    throw new Error(`无法解析状态：${raw}（允许 ${ALLOWED_STATUSES.join(' / ')}）`);
  }
  return match[1].toLowerCase();
}

function statusFromName(name) {
  const match = /-([a-z]+)\.md$/i.exec(name);
  return match && ALLOWED_STATUSES.includes(match[1].toLowerCase())
    ? match[1].toLowerCase()
    : '';
}

function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dateFromText(text) {
  const raw = bulletValue(text, '日期');
  if (!raw) return '';
  if (!isValidDate(raw)) throw new Error(`日期格式非法：${raw}（应为 YYYY-MM-DD）`);
  return raw;
}

function dateFromName(name) {
  const match = /^(\d{4}-\d{2}-\d{2})-/.exec(name);
  return match ? match[1] : '';
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function escapeLinkText(value) {
  return escapeCell(value).replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function relativePosix(knowledgeDir, file) {
  return file.slice(knowledgeDir.length + 1).split('\\').join('/');
}

function projectTitle(projectDir, slug) {
  const readme = join(projectDir, 'README.md');
  if (!existsSync(readme)) return slug;
  const heading = firstHeading(readText(readme));
  return heading.replace(/^项目[：:]\s*/, '').trim() || slug;
}

/** 收集项目案例。 */
function collectCases(knowledgeDir) {
  const projectsDir = join(knowledgeDir, 'projects');
  if (!existsSync(projectsDir)) throw new Error(`知识库缺少 projects/ 目录：${projectsDir}`);
  const cases = [];

  const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort(compareName);

  for (const projectEntry of projectDirs) {
    const slug = projectEntry.name;
    const projectDir = join(projectsDir, slug);
    const casesDir = join(projectDir, 'cases');
    if (!existsSync(casesDir)) continue;
    const title = projectTitle(projectDir, slug);

    const caseFiles = readdirSync(casesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
      .sort(compareName);

    for (const caseEntry of caseFiles) {
      const name = caseEntry.name;
      const file = join(casesDir, name);
      const text = readText(file);
      const nameStatus = statusFromName(name);
      let bodyStatus;
      try {
        bodyStatus = statusFromText(text);
      } catch (error) {
        throw new Error(`${relativePosix(knowledgeDir, file)}：${error.message}`);
      }
      if (bodyStatus && nameStatus && bodyStatus !== nameStatus) {
        throw new Error(
          `${relativePosix(knowledgeDir, file)}：正文状态 ${bodyStatus} 与文件名状态 ${nameStatus} 冲突`,
        );
      }
      const status = bodyStatus || nameStatus;
      if (!status) {
        throw new Error(
          `${relativePosix(knowledgeDir, file)}：无法解析状态；`
          + `文件名应为 YYYY-MM-DD-<topic>-<status>.md，或在正文写「- 状态：passed」。`,
        );
      }

      let date;
      try {
        date = dateFromText(text);
      } catch (error) {
        throw new Error(`${relativePosix(knowledgeDir, file)}：${error.message}`);
      }
      date ||= dateFromName(name);
      if (!date) {
        throw new Error(
          `${relativePosix(knowledgeDir, file)}：无法解析日期；`
          + `请在正文写「- 日期：YYYY-MM-DD」或用 YYYY-MM-DD 作为文件名前缀。`,
        );
      }

      const caseTitle = firstHeading(text) || basename(name, '.md');
      cases.push({
        projectSlug: slug,
        projectTitle: title,
        projectLink: `projects/${slug}/README.md`,
        title: caseTitle,
        status,
        date,
        link: `projects/${slug}/cases/${name}`,
        file: relativePosix(knowledgeDir, file),
      });
    }
  }

  // 项目按 slug、日期倒序、文件名升序，保证跨机器稳定（不依赖 ICU 排序）。
  cases.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug, 'en')
    || b.date.localeCompare(a.date)
    || a.file.localeCompare(b.file, 'en'));
  return cases;
}

function fallbackPatternDescription(file, name) {
  if (name.endsWith('.md')) return firstHeading(readText(file)) || name;
  if (name.endsWith('.json')) {
    try {
      const data = JSON.parse(readText(file));
      for (const key of ['description', 'note', 'title', '用途']) {
        if (typeof data[key] === 'string' && data[key].trim() !== '') return data[key].trim();
      }
    } catch {
      // 描述兜底即可，JSON 合法性由其他测试覆盖。
    }
    return `JSON 配方（patterns/${name}）`;
  }
  if (name.endsWith('.html') || name.endsWith('.htm')) return `HTML 模板（patterns/${name}）`;
  return `patterns/${name}`;
}

/** 收集 patterns 资产；用途优先取 patterns/README.md 的表格。 */
function collectPatterns(knowledgeDir) {
  const patternsDir = join(knowledgeDir, 'patterns');
  if (!existsSync(patternsDir)) return [];
  const readme = join(patternsDir, 'README.md');
  const described = new Map();
  if (existsSync(readme)) {
    for (const line of readText(readme).split(/\r?\n/)) {
      const match = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
      if (!match) continue;
      const target = match[2].trim().replace(/^\.\//, '');
      if (target === '' || target.includes('/')) continue;
      described.set(target, match[3].trim());
    }
  }

  return readdirSync(patternsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name !== 'README.md')
    .sort(compareName)
    .map((entry) => {
      const file = join(patternsDir, entry.name);
      return {
        name: entry.name,
        link: `patterns/${entry.name}`,
        description: described.get(entry.name) || fallbackPatternDescription(file, entry.name),
      };
    });
}

function renderIndex({ cases, patterns }) {
  const projectCount = new Set(cases.map((entry) => entry.projectSlug)).size;
  const counts = Object.fromEntries(ALLOWED_STATUSES.map((status) => [
    status,
    cases.filter((entry) => entry.status === status).length,
  ]));
  const lines = [];

  lines.push('# 知识库索引', '');
  lines.push('> 本文件由 `scripts/knowledge-index.mjs` 生成，请勿手工编辑。');
  lines.push('> 重新生成：`node scripts/knowledge-index.mjs`；一致性校验：`node scripts/knowledge-index.mjs --check`。');
  lines.push('');
  lines.push(
    `共 **${projectCount}** 个项目 · **${cases.length}** 个案例`
    + `（passed ${counts.passed} / failed ${counts.failed} / superseded ${counts.superseded}）`
    + `· **${patterns.length}** 个 patterns 资产。`,
  );
  lines.push('');

  lines.push('## 项目案例', '');
  if (cases.length === 0) {
    lines.push('（暂无案例：在 `projects/<slug>/cases/` 下按 `YYYY-MM-DD-<topic>-<status>.md` 新增。）', '');
  } else {
    lines.push('| 项目 | 案例 | 状态 | 日期 | 链接 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of cases) {
      lines.push(
        `| [${escapeLinkText(entry.projectTitle)}](${entry.projectLink})`
        + ` | ${escapeCell(entry.title)}`
        + ` | ${STATUS_LABEL[entry.status]}`
        + ` | ${entry.date}`
        + ` | [${escapeCell(basename(entry.link))}](${entry.link}) |`,
      );
    }
    lines.push('');
  }

  lines.push('## 跨项目复用（patterns/）', '');
  lines.push('说明与使用方式见 [patterns/README.md](patterns/README.md)。', '');
  if (patterns.length === 0) {
    lines.push('（暂无 patterns 资产：把跨项目配方/模板放在 `patterns/` 下。）', '');
  } else {
    lines.push('| 文件 | 用途 | 链接 |');
    lines.push('| --- | --- | --- |');
    for (const entry of patterns) {
      lines.push(
        `| ${escapeCell(entry.name)} | ${escapeCell(entry.description)} | [${escapeCell(entry.link)}](${entry.link}) |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const length = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < length; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        line: index + 1,
        expected: expectedLines[index] ?? '<EOF>',
        actual: actualLines[index] ?? '<EOF>',
      };
    }
  }
  return undefined;
}

function buildIndex() {
  const cases = collectCases(KNOWLEDGE_DIR);
  const patterns = collectPatterns(KNOWLEDGE_DIR);
  return { content: renderIndex({ cases, patterns }), cases, patterns };
}

if (help) {
  console.log(helpText());
  process.exit(0);
}

try {
  const { content, cases, patterns } = buildIndex();
  const projectCount = new Set(cases.map((entry) => entry.projectSlug)).size;

  if (checkOnly) {
    if (!existsSync(INDEX_PATH)) {
      throw new Error(`索引不存在：${INDEX_PATH}\n修复：node scripts/knowledge-index.mjs`);
    }
    const actual = normalizeNewlines(readText(INDEX_PATH));
    const expected = normalizeNewlines(content);
    if (actual !== expected) {
      const diff = firstDifference(expected, actual);
      throw new Error([
        `索引与案例/patterns 不一致：${relativePosix(KNOWLEDGE_DIR, INDEX_PATH)}`,
        diff ? `首个差异在第 ${diff.line} 行` : '',
        diff ? `  期望：${diff.expected}` : '',
        diff ? `  实际：${diff.actual}` : '',
        '修复：node scripts/knowledge-index.mjs',
      ].filter(Boolean).join('\n'));
    }
    console.log(
      `OK    索引一致：${relativePosix(KNOWLEDGE_DIR, INDEX_PATH)}`
      + `（${projectCount} 项目 / ${cases.length} 案例 / ${patterns.length} patterns）`,
    );
  } else {
    writeFileSync(INDEX_PATH, content, 'utf8');
    console.log(
      `WRITE ${relativePosix(KNOWLEDGE_DIR, INDEX_PATH)}`
      + `（${projectCount} 项目 / ${cases.length} 案例 / ${patterns.length} patterns）`,
    );
  }
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  process.exit(1);
}
