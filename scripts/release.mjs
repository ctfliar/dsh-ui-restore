#!/usr/bin/env node
/**
 * dsh-ui-restore · 本地发布工具
 *
 * 只做两件事：在包目录里 bump 版本（`npm version`，保留本地 commit + tag），
 * 然后 `npm publish`。**不 push 任何 git 远端**。
 *
 * 用法：
 *   npm run release:dry                 # 默认 dry-run（patch），只打印计划
 *   node scripts/release.mjs --bump minor --tag next --apply
 *   npm run release:patch               # 真正发布 patch
 *   npm run release:minor               # 真正发布 minor
 *
 * 安全阀（--apply 时命中任一条即拒绝，不落盘）：
 *   - 包目录不是独立 git 仓库根，或工作区有未提交改动；
 *   - 目标版本等于当前版本；
 *   - package.json 的 engines.dsh 与当前运行中的 DSH 版本冲突；
 *   - npm 未登录（先执行 `npm login`）。
 *
 * @module dsh-ui-restore/release
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 包目录（脚本所在目录的上一级）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `用法：
  node scripts/release.mjs [--bump patch|minor] [--tag latest] [--apply]

  默认 dry-run，只打印将要执行的步骤；加 --apply 才真正修改版本并发布。
  本工具不 push 任何 git 远端。`;

const BUMP_KINDS = ['patch', 'minor'];

/** 解析 semver（只支持 major.minor.patch[-prerelease][+build]）。 */
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 按 semver 规则比较两个版本号（预发布版 < 正式版）。 */
export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  if (a === undefined || b === undefined) throw new Error(`版本号非法：${left} / ${right}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = a.prerelease[index];
    const rightId = b.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const order = compareIdentifiers(leftId, rightId);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * 判断版本是否满足 `<op>version || ...` 形式的范围（够用于 engines.dsh）。
 * 预发布版只在同一 major.minor.patch 的预发布比较器下才算满足，与 semver 一致。
 */
export function satisfies(version, range) {
  const target = parseVersion(version);
  if (target === undefined) return false;
  for (const rawClause of String(range ?? '').split('||')) {
    const clause = rawClause.trim();
    if (clause === '') continue;
    const match = /^(>=|>|<=|<|=)?\s*(.+)$/.exec(clause);
    if (match === null) continue;
    const boundary = parseVersion(match[2]);
    if (boundary === undefined) continue;
    const operator = match[1] ?? '>=';
    const order = compareVersions(target, boundary);
    const ok = operator === '>='
      ? order >= 0
      : operator === '>'
        ? order > 0
        : operator === '<='
          ? order <= 0
          : operator === '<'
            ? order < 0
            : order === 0;
    if (!ok) continue;
    if (target.prerelease.length > 0) {
      if (boundary.prerelease.length === 0) continue;
      if (boundary.major !== target.major || boundary.minor !== target.minor || boundary.patch !== target.patch) continue;
    }
    return true;
  }
  return false;
}

/** 计算 bump 后的版本。 */
export function bumpVersion(version, kind = 'patch') {
  const parsed = parseVersion(version);
  if (parsed === undefined) throw new Error(`当前版本非法：${version}`);
  if (!BUMP_KINDS.includes(kind)) throw new Error(`--bump 只支持 ${BUMP_KINDS.join(' / ')}`);
  if (kind === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function readPackage() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
}

/** 用临时文件接 stdout/stderr，避免受限会话里的管道限制。 */
function runCapture(command, args, options = {}) {
  const logFile = join(tmpdir(), `dsh-ui-restore-release-${process.pid}-${Date.now()}.log`);
  const fd = openSync(logFile, 'w');
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      stdio: ['ignore', fd, fd],
      timeout: options.timeout ?? 30000,
      windowsHide: true,
    });
    const output = readFileSync(logFile, 'utf8').trim();
    const status = typeof result.status === 'number' ? result.status : 1;
    return { status, output, error: result.error };
  } finally {
    closeSync(fd);
    try {
      unlinkSync(logFile);
    } catch {
      // 临时文件清理失败不影响发布判断。
    }
  }
}

/** 优先用 `node <npm-cli.js>`，避免 Windows 下 .cmd 与 shell 引号问题。 */
function resolveNpmCommand() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.endsWith('.js'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: process.execPath, prefix: [candidate] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [], shell: process.platform === 'win32' };
}

function runNpm(args, options = {}) {
  const npm = resolveNpmCommand();
  return runCapture(npm.command, [...npm.prefix, ...args], { ...options, shell: npm.shell === true });
}

function git(args, options = {}) {
  return runCapture('git', args, options);
}

/** 检测独立 git 仓库根；不是仓库或不是包目录本身时返回 undefined。 */
function detectStandaloneGitRoot() {
  const result = git(['rev-parse', '--show-toplevel']);
  if (result.status !== 0) return undefined;
  const root = resolve(result.output.split(/\r?\n/u).at(-1)?.trim() ?? '');
  return root === REPO_ROOT ? root : undefined;
}

/** 读取当前运行中的 DSH 版本（存在才返回）。 */
export function detectDshVersion() {
  const candidates = [];
  if (typeof process.env.DSH_INSTALL_DIR === 'string') candidates.push(join(process.env.DSH_INSTALL_DIR, 'package.json'));
  if (typeof process.env.DSH_PROFILE_DIR === 'string') {
    candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')).version;
    } catch {
      // 继续尝试下一个候选。
    }
  }
  return undefined;
}

function parseArgs(argv) {
  const options = { bump: 'patch', tag: 'latest', apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--bump') {
      options.bump = argv[index + 1];
      index += 1;
    } else if (arg === '--tag') {
      options.tag = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--bump=')) options.bump = arg.slice('--bump='.length);
    else if (arg.startsWith('--tag=')) options.tag = arg.slice('--tag='.length);
    else throw new Error(`未知参数：${arg}`);
  }
  if (!BUMP_KINDS.includes(options.bump)) throw new Error(`--bump 只支持 ${BUMP_KINDS.join(' / ')}`);
  if (typeof options.tag !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(options.tag)) throw new Error(`--tag 非法：${options.tag}`);
  return options;
}

function line(text = '') {
  console.log(text);
}

/** 预检：返回 { blockers, notes, facts }。blockers 非空时 --apply 拒绝执行。 */
export function preflight(options = {}) {
  const pkg = readPackage();
  const current = pkg.version;
  const target = bumpVersion(current, options.bump ?? 'patch');
  const engines = pkg.engines ?? {};
  const dshVersion = detectDshVersion();
  const gitRoot = detectStandaloneGitRoot();
  const blockers = [];
  const notes = [];

  let dirty = undefined;
  if (gitRoot === undefined) {
    blockers.push('包目录不是独立 git 仓库根：发布仓库需在包目录执行 git init（本仓库的子目录不会被当作发布仓库）。');
  } else {
    const status = git(['status', '--porcelain']);
    if (status.status !== 0) {
      blockers.push(`git status 执行失败：${status.output.split('\n')[0]}`);
    } else {
      dirty = status.output !== '';
      if (dirty) blockers.push(`工作区不干净（${status.output.split(/\r?\n/u).filter(Boolean).length} 项未提交），先提交或还原改动。`);
    }
  }

  if (target === current) blockers.push(`目标版本与当前版本相同（${current}），没有可发布的改动。`);

  if (typeof engines.dsh === 'string' && engines.dsh !== '') {
    if (dshVersion === undefined) {
      notes.push('未检测到运行中的 DSH 版本（缺少 DSH_INSTALL_DIR/DSH_PROFILE_DIR），跳过 engines 冲突检查。');
    } else if (!satisfies(dshVersion, engines.dsh)) {
      blockers.push(`当前运行中的 DSH ${dshVersion} 不满足 engines.dsh "${engines.dsh}"。`);
    }
  }

  const auth = runNpm(['whoami'], { timeout: 15000 });
  const loggedIn = auth.status === 0 && auth.output !== '';
  const authMessage = loggedIn
    ? auth.output.split(/\r?\n/u)[0]
    : 'not logged in（先执行 `npm login`）';

  return {
    package: {
      name: pkg.name,
      current,
      target,
      engines: { dsh: engines.dsh, node: engines.node },
    },
    git: { root: gitRoot, dirty },
    dshVersion,
    npm: { loggedIn, message: authMessage },
    blockers,
    notes,
  };
}

function printPlan(options, facts) {
  const { package: pkg, git: gitFacts, dshVersion, npm, blockers, notes } = facts;
  line(`dsh-ui-restore release · ${options.apply ? 'apply' : 'dry-run'}`);
  line(`- 包目录: ${REPO_ROOT}`);
  line(`- 包名: ${pkg.name}`);
  line(`- 当前版本: ${pkg.current}`);
  line(`- 目标版本: ${pkg.target}（${options.bump}）`);
  line(`- 工作区: ${gitFacts.root === undefined ? '不是独立 git 仓库' : gitFacts.dirty ? 'dirty（有未提交改动）' : 'clean'}`);
  line(`- engines.dsh: ${pkg.engines?.dsh ?? '（未声明）'}${dshVersion === undefined ? ' · 运行中的 DSH: 未检测到' : ` · 运行中的 DSH: ${dshVersion}`}`);
  line(`- npm 登录态: ${npm.message}`);
  for (const note of notes) line(`- 提示: ${note}`);
  line('');
  line(`${options.apply ? '将要执行' : '计划执行（加 --apply 才真正执行）'}：`);
  line(`  1. npm version ${options.bump} -m "release: v%s"   # 本地 commit + tag`);
  line(`  2. npm publish --tag ${options.tag}`);
  line('不会 push 任何 git 远端（本地 commit/tag 保留，是否推送由你手动决定）。');
  if (blockers.length > 0) {
    line('');
    line('命中发布安全阀（--apply 会拒绝）：');
    for (const blocker of blockers) line(`  - ${blocker}`);
  }
  line('');
}

/** 执行发布；返回进程退出码。 */
export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`参数错误：${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    line(USAGE);
    return 0;
  }

  const facts = preflight(options);
  printPlan(options, facts);

  if (!options.apply) {
    line(`dry-run 完成：未修改 package.json、未 publish。确认无误后运行 npm run release:${options.bump}。`);
    return 0;
  }

  if (!facts.npm.loggedIn) facts.blockers.push('npm 未登录，先执行 `npm login`。');
  if (facts.blockers.length > 0) {
    line('拒绝发布：');
    for (const blocker of facts.blockers) line(`  - ${blocker}`);
    return 1;
  }

  line(`[1/2] npm version ${options.bump} -m "release: v%s"`);
  const versionResult = runNpm(['version', options.bump, '-m', 'release: v%s']);
  if (versionResult.status !== 0) {
    console.error('npm version 失败：');
    console.error(versionResult.output);
    return 1;
  }
  line(versionResult.output);

  line(`[2/2] npm publish --tag ${options.tag}`);
  const publishResult = runNpm(['publish', '--tag', options.tag]);
  if (publishResult.status !== 0) {
    console.error('npm publish 失败（版本已 bump，本地 commit/tag 已保留，修复后可重试 publish）：');
    console.error(publishResult.output);
    return 1;
  }
  line(publishResult.output);
  line('');
  line(`发布完成：${facts.package.name}@${facts.package.target}（dist-tag: ${options.tag}）`);
  line('未 push 任何 git 远端；需要时手动执行 git push。');
  return 0;
}

// 直接运行（而不是被测试 import）时才执行发布流程。
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}
