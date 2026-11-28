/**
 * dsh-ui-restore · 路径、运行目录与运行元数据
 *
 * 所有产物都落在工作区里，工具只返回文件路径（模型用 read_image / 文件读取
 * 自行查看）。一个「run 目录」把一次还原验收的全部产物聚在一起：
 *
 *   <run>/
 *     meta.json          运行元数据（工具版本、档案、视口、产物清单、分数历史）
 *     shot.png           截图（ui_capture）
 *     design.png         设计稿（ui_diff 复制/引用）
 *     diff.png           差异热力图（ui_diff）
 *     side-by-side.png   左右对照图（ui_diff）
 *     diff.json          差异摘要（ui_diff）
 *     probe.json         探针结果（ui_probe）
 *     report.md / report.html  验收报告（ui_report）
 *
 * @module dsh-ui-restore/paths
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 插件根目录（lib 的上一级）。 */
export const PLUGIN_ROOT = resolve(HERE, '..');

export const DEFAULT_RUN_ROOT = 'output/ui-restore';
export const DEFAULT_PROFILE_DIR = 'ui-restore-profiles';
export const META_SCHEMA_VERSION = 1;

function readPackageJson() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  } catch {
    return { name: 'dsh-ui-restore', version: '0.0.0' };
  }
}

/** 插件包元数据（版本写进报告夹具声明）。 */
export const PACKAGE = readPackageJson();
export const TOOL_NAME = PACKAGE.name ?? 'dsh-ui-restore';
export const TOOL_VERSION = PACKAGE.version ?? '0.0.0';

/** 把工作区相对路径解析成绝对路径（不做边界校验；工具参数请用 assertWorkspacePath）。 */
export function resolveWorkspacePath(cwd, target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('路径不能为空');
  }
  return isAbsolute(target) ? resolve(target) : resolve(cwd ?? process.cwd(), target);
}

/** 工作区根目录（绝对路径）。 */
export function workspaceRoot(cwd) {
  return resolve(cwd ?? process.cwd());
}

/** 目标是否位于工作区内（纯词法判断，不跟随符号链接）。 */
export function isWithinWorkspace(cwd, target) {
  const root = workspaceRoot(cwd);
  const absolute = resolve(root, String(target));
  const rel = relative(root, absolute);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 安全边界：所有工具参数里的 path/out/run/shot/design 等路径都必须落在工作区内。
 *
 * - 相对路径按工作区解析；
 * - 绝对路径若指向工作区外，直接抛错（绝不静默写盘）；
 * - 返回值是解析后的绝对路径，调用方应当只使用返回值。
 *
 * @param {string} cwd 工作区根目录
 * @param {string} target 用户传入的路径
 * @param {string} [label] 报错时的参数名（如「design 设计稿路径」）
 * @returns {string} 工作区内的绝对路径
 */
export function assertWorkspacePath(cwd, target, label = '路径') {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error(`${label}不能为空`);
  }
  const root = workspaceRoot(cwd);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
  if (!isWithinWorkspace(root, absolute)) {
    throw new Error([
      `${label}超出工作区，已拒绝：${absolute}`,
      `工作区：${root}`,
      '边界：工具参数里的 path / out / run / shot / design 等路径必须位于工作区内；',
      '绝对路径指向工作区外不会被读取或写入。请把文件放进工作区（通常用 run 目录）。',
    ].join('\n'));
  }
  return absolute;
}

/** 递归建目录并返回目录本身。 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 本地时间戳：20261123-104501。 */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 默认 run 目录：<cwd>/<runRoot>/run-<stamp>（runRoot 也必须在工作区内）。 */
export function defaultRunDir(cwd, runRoot = DEFAULT_RUN_ROOT) {
  return join(assertWorkspacePath(cwd, runRoot, 'runRoot 运行根目录'), `run-${stamp()}`);
}

/** 解析本次运行的目录；显式 run 优先，否则新建默认 run 目录。 */
export function resolveRunDir({ cwd, runRoot, run }) {
  const dir = run
    ? assertWorkspacePath(cwd, run, 'run 运行目录')
    : defaultRunDir(cwd, runRoot);
  return ensureDir(dir);
}

/** 统一成 POSIX 风格，便于写进 Markdown/HTML。 */
export function toPosix(path) {
  return String(path).split(sep).join('/');
}

/** 相对路径（在同一目录树内时）否则绝对路径，用于报告展示。 */
export function relOrAbs(fromDir, target) {
  const rel = relative(fromDir, target);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel);
  return toPosix(target);
}

/** 判断文件是否直接位于目录下。 */
export function isDirectChild(dir, file) {
  return resolve(dirname(file)) === resolve(dir);
}

/** 读取 JSON 文件，失败给出可读错误。 */
export function readJsonFile(file, label = 'JSON') {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`无法读取${label}：${file}（${error.code ?? error.message}）`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${file}（${error.message}）`);
  }
}

/** 写 JSON 文件（自动建目录）。 */
export function writeJsonFile(file, value) {
  ensureDir(dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

/** 读取 run 元数据；不存在时返回骨架。 */
export function readMeta(runDir) {
  const file = join(runDir, 'meta.json');
  if (!existsSync(file)) {
    return {
      schemaVersion: META_SCHEMA_VERSION,
      tool: TOOL_NAME,
      version: TOOL_VERSION,
      createdAt: new Date().toISOString(),
      artifacts: {},
      history: [],
    };
  }
  const meta = readJsonFile(file, 'run 元数据');
  return normalizeMeta(meta);
}

/** 补齐 meta 必需字段，容忍旧版本文件。 */
export function normalizeMeta(meta) {
  const out = meta && typeof meta === 'object' ? { ...meta } : {};
  out.schemaVersion = META_SCHEMA_VERSION;
  out.tool = TOOL_NAME;
  out.version = TOOL_VERSION;
  out.createdAt = typeof out.createdAt === 'string' ? out.createdAt : new Date().toISOString();
  out.artifacts = out.artifacts && typeof out.artifacts === 'object' ? out.artifacts : {};
  out.history = Array.isArray(out.history) ? out.history : [];
  return out;
}

/**
 * 合并写入 run 元数据。
 * artifacts 按 key 覆盖；其余字段浅覆盖；history 由调用方显式追加。
 */
export function mergeMeta(runDir, patch = {}) {
  const meta = readMeta(runDir);
  // undefined 表示「本次没有这项信息」，不能覆盖已有值（JSON 也表达不了 undefined）。
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const next = {
    ...meta,
    ...defined,
    artifacts: { ...meta.artifacts, ...(patch.artifacts ?? {}) },
    history: Array.isArray(patch.history) ? patch.history : meta.history,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(join(runDir, 'meta.json'), next);
  return next;
}

/** 追加一轮分数（同一 run 的多次 ui_diff 形成曲线）。 */
export function appendHistory(runDir, entry) {
  const meta = readMeta(runDir);
  const history = [...meta.history, { at: new Date().toISOString(), ...entry }];
  mergeMeta(runDir, { history, lastScore: entry.score ?? null });
  return history;
}

/** 文件存在性校验，缺失时抛出带上下文的错误。 */
export function assertFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${label} 不存在或不是文件：${file}`);
  }
  return file;
}

/** 计算一段字节的 SHA-256（十六进制小写）。 */
export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 计算文件 SHA-256；读不到时返回 undefined（证据字段缺失，不阻断本次验收）。 */
export function sha256File(file) {
  if (!file || !existsSync(file)) return undefined;
  try {
    return sha256Buffer(readFileSync(file));
  } catch {
    return undefined;
  }
}

/** 生成不与现有文件冲突的目标名：name.ext → name-2.ext。 */
export function uniquePath(dir, name) {
  const ext = extname(name);
  const stem = basename(name, ext);
  let candidate = join(dir, name);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

/**
 * 把图片放进报告目录，报告里只用同目录相对路径引用。
 * - 已经位于报告目录：直接返回文件名
 * - 来自其它目录：以 <slot>[-<原名>].png 复制进报告目录（重名不覆盖）
 */
export function materializeImage(outDir, source, slot) {
  const absolute = resolve(source);
  if (isDirectChild(outDir, absolute)) return basename(absolute);
  const ext = extname(absolute).toLowerCase() || '.png';
  const plain = `${slot}${ext}`;
  const target = existsSync(join(outDir, plain)) ? uniquePath(outDir, `${slot}-${basename(absolute)}`) : join(outDir, plain);
  copyFileSync(absolute, target);
  return basename(target);
}

/** 把一次运行的摘要折算成给报告用的档案信息。 */
export function profileSummary(profile) {
  if (!profile) return undefined;
  const p = profile.profile ?? profile;
  const device = p.devices?.[0];
  return {
    id: p.id,
    label: p.label,
    path: profile.path,
    baseUrl: p.baseUrl,
    designSource: p.designSource ?? { kind: 'none' },
    api: p.api ?? undefined,
    thresholds: p.thresholds,
    device: device ? { id: device.id, width: device.width, height: device.height, dpr: device.dpr } : undefined,
    knownIssues: p.knownIssues ?? [],
    notes: p.notes ?? '',
  };
}
