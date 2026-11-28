/**
 * dsh-ui-restore · 项目档案（零依赖 JSON）
 *
 * 档案是「人和模型」共用的夹具声明，插件只读它、不解析也不连接任何外部服务：
 *
 *   {
 *     "id": "example-admin",
 *     "label": "示例后台",
 *     "baseUrl": "http://localhost:3000",
 *     "devices": [{ "id": "desktop", "width": 1440, "height": 900, "dpr": 1 }],
 *     "thresholds": { "score": 0.95, "maxRounds": 3 },
 *     "rules": [{ "cwd": ".", "command": "npm run validate", "required": true }],
 *     "tokens": { "files": ["src/styles/tokens.css"], "prefix": "--" },
 *     "baseline": { "pages": ["src/views/list/index.vue"] },
 *     "designSource": { "kind": "none", "mcpServer": "reference-only", "artboard": "list-page" },
 *     "design": { "mode": "reference", "brief": "", "styleRefs": [], "outputs": ["spec", "mock"] },
 *     "styleBaseline": "design/style-baseline.png",
 *     "api": { "source": "project", "env": "test", "enabled": false, "allow": ["http://127.0.0.1:8080"], "authEnv": "APP_TOKEN" },
 *     "knownIssues": ["分页器在 1280 宽度下换行（已知，不记为缺陷）"],
 *     "notes": "自由文本"
 *   }
 *
 * designSource.mcpServer / artboard 只是给人和模型的引用文字，插件从不连接。
 * design 段是「自主设计」的开关与简报：mode=from-scratch 时由 ui-restore-designer
 * 先产出设计包（design.json / ui-spec / mock），画师再按设计包实现。
 * api 段同样只是交给接线者与验收者读的接线约定：插件不访问网络、不读凭据。
 *
 * @module dsh-ui-restore/profile
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  DEFAULT_PROFILE_DIR,
  PLUGIN_ROOT,
  readJsonFile,
  resolveWorkspacePath,
} from './paths.js';

/** 缺省档案：所有工具在未指定 profile 时按这份兜底。 */
export const DEFAULT_PROFILE = Object.freeze({
  id: 'default',
  label: '默认档案',
  baseUrl: '',
  devices: [{ id: 'desktop', width: 1440, height: 900, dpr: 1 }],
  thresholds: { score: 0.95, maxRounds: 3 },
  rules: [],
  tokens: { files: [], prefix: '--' },
  baseline: { pages: [] },
  designSource: { kind: 'none' },
  design: { mode: 'reference', brief: '', styleRefs: [], outputs: ['spec', 'mock'] },
  styleBaseline: '',
  api: { source: 'none', env: 'test', enabled: false, allow: [], authEnv: '' },
  knownIssues: [],
  notes: '',
});

export const DESIGN_SOURCE_KINDS = ['none', 'image', 'mcp'];
/** 设计模式：reference=有参考（默认）；from-scratch=无参考、由设计师自主设计。 */
export const DESIGN_MODES = ['reference', 'from-scratch'];
/** 设计包可产出物：ui-spec、可截图 mock；paper 需用户同意才可选。 */
export const DESIGN_OUTPUTS = ['spec', 'mock', 'paper'];
export const API_SOURCE_KINDS = ['none', 'project', 'openapi', 'capture'];
export const API_ENVS = ['test', 'prod-readonly'];

const KNOWN_KEYS = new Set([
  'id',
  'label',
  'baseUrl',
  'devices',
  'thresholds',
  'rules',
  'tokens',
  'baseline',
  'designSource',
  'design',
  'styleBaseline',
  'api',
  'knownIssues',
  'notes',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeDevice(raw, index) {
  const device = isPlainObject(raw) ? raw : {};
  return {
    id: asString(device.id, `device-${index + 1}`),
    width: Math.round(positiveNumber(device.width, DEFAULT_PROFILE.devices[0].width)),
    height: Math.round(positiveNumber(device.height, DEFAULT_PROFILE.devices[0].height)),
    dpr: positiveNumber(device.dpr, 1),
  };
}

function normalizeThresholds(raw) {
  const thresholds = isPlainObject(raw) ? raw : {};
  const score = typeof thresholds.score === 'number' && thresholds.score > 0 && thresholds.score <= 1
    ? thresholds.score
    : DEFAULT_PROFILE.thresholds.score;
  const maxRounds = typeof thresholds.maxRounds === 'number' && thresholds.maxRounds >= 1
    ? Math.round(thresholds.maxRounds)
    : DEFAULT_PROFILE.thresholds.maxRounds;
  return { score, maxRounds };
}

function normalizeRules(raw, warnings) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push('rules 必须是数组，已忽略');
    return [];
  }
  return raw
    .filter((rule) => isPlainObject(rule))
    .map((rule) => ({
      cwd: asString(rule.cwd, '.'),
      command: asString(rule.command, ''),
      required: rule.required === true,
    }))
    .filter((rule) => rule.command !== '');
}

function normalizeTokens(raw, warnings) {
  if (raw === undefined) return { ...DEFAULT_PROFILE.tokens, files: [] };
  if (!isPlainObject(raw)) {
    warnings.push('tokens 必须是对象，已用默认值');
    return { ...DEFAULT_PROFILE.tokens, files: [] };
  }
  const files = Array.isArray(raw.files) ? raw.files.filter((file) => typeof file === 'string') : [];
  return { files, prefix: asString(raw.prefix, DEFAULT_PROFILE.tokens.prefix) };
}

function normalizeBaseline(raw, warnings) {
  if (raw === undefined) return { pages: [] };
  if (!isPlainObject(raw)) {
    warnings.push('baseline 必须是对象，已用默认值');
    return { pages: [] };
  }
  const pages = Array.isArray(raw.pages)
    ? raw.pages
      .map((page) => {
        if (typeof page === 'string') return page;
        if (isPlainObject(page) && typeof page.url === 'string') return page.url;
        return undefined;
      })
      .filter((page) => typeof page === 'string' && page !== '')
    : [];
  return { pages };
}

function normalizeDesignSource(raw, warnings) {
  if (raw === undefined) return { kind: 'none' };
  if (!isPlainObject(raw)) {
    warnings.push('designSource 必须是对象，已按 none 处理');
    return { kind: 'none' };
  }
  const kind = asString(raw.kind, 'none');
  if (!DESIGN_SOURCE_KINDS.includes(kind)) {
    throw new Error(`designSource.kind 非法：${kind}（允许 ${DESIGN_SOURCE_KINDS.join(' / ')}）`);
  }
  const out = { kind };
  if (typeof raw.mcpServer === 'string' && raw.mcpServer !== '') out.mcpServer = raw.mcpServer;
  if (typeof raw.artboard === 'string' && raw.artboard !== '') out.artboard = raw.artboard;
  if (typeof raw.path === 'string' && raw.path !== '') out.path = raw.path;
  if (typeof raw.note === 'string' && raw.note !== '') out.note = raw.note;
  return out;
}

/**
 * 自主设计段：决定要不要先派设计师、设计简报、风格参照与设计包产出物。
 * 非法 mode 只告警并退回 reference；outputs 过滤成 spec / mock / paper，
 * 空数组或非数组时退回默认 spec + mock。插件只读这些声明，不替模型选风格。
 */
function normalizeDesign(raw, warnings) {
  const fallback = {
    mode: DEFAULT_PROFILE.design.mode,
    brief: DEFAULT_PROFILE.design.brief,
    styleRefs: [],
    outputs: [...DEFAULT_PROFILE.design.outputs],
  };
  if (raw === undefined) return fallback;
  if (!isPlainObject(raw)) {
    warnings.push('design 必须是对象，已按默认值处理');
    return fallback;
  }
  let mode = asString(raw.mode, DEFAULT_PROFILE.design.mode);
  if (!DESIGN_MODES.includes(mode)) {
    warnings.push(`design.mode 非法（${mode}），已按 reference 处理；允许 ${DESIGN_MODES.join(' / ')}`);
    mode = 'reference';
  }
  let styleRefs = [];
  if (Array.isArray(raw.styleRefs)) {
    styleRefs = raw.styleRefs.filter((ref) => typeof ref === 'string' && ref !== '');
  } else if (raw.styleRefs !== undefined) {
    warnings.push('design.styleRefs 必须是字符串数组，已忽略');
  }
  let outputs;
  if (Array.isArray(raw.outputs)) {
    outputs = raw.outputs.filter((output) => typeof output === 'string' && DESIGN_OUTPUTS.includes(output));
    if (outputs.length === 0) {
      warnings.push(`design.outputs 为空或全是非法值，已用默认 ${DEFAULT_PROFILE.design.outputs.join(' + ')}；允许 ${DESIGN_OUTPUTS.join(' / ')}`);
      outputs = [...DEFAULT_PROFILE.design.outputs];
    } else if (outputs.length !== raw.outputs.length) {
      warnings.push(`design.outputs 含非法值，已过滤；允许 ${DESIGN_OUTPUTS.join(' / ')}`);
    }
  } else {
    if (raw.outputs !== undefined) {
      warnings.push(`design.outputs 必须是数组，已用默认 ${DEFAULT_PROFILE.design.outputs.join(' + ')}；允许 ${DESIGN_OUTPUTS.join(' / ')}`);
    }
    outputs = [...DEFAULT_PROFILE.design.outputs];
  }
  return { mode, brief: asString(raw.brief, ''), styleRefs, outputs };
}

/**
 * 接口接线约定（交给接线者与验收者读，插件自己不联网）。
 * 非法 source/env 只告警并退回安全缺省：source=none、env=test。
 */
function normalizeApi(raw, warnings) {
  const fallback = { ...DEFAULT_PROFILE.api, allow: [] };
  if (raw === undefined) return fallback;
  if (!isPlainObject(raw)) {
    warnings.push('api 必须是对象，已按默认值处理');
    return fallback;
  }
  let source = asString(raw.source, 'none');
  if (!API_SOURCE_KINDS.includes(source)) {
    warnings.push(`api.source 非法（${source}），已按 none 处理；允许 ${API_SOURCE_KINDS.join(' / ')}`);
    source = 'none';
  }
  let env = asString(raw.env, 'test');
  if (!API_ENVS.includes(env)) {
    warnings.push(`api.env 非法（${env}），已按 test 处理；允许 ${API_ENVS.join(' / ')}`);
    env = 'test';
  }
  const allow = Array.isArray(raw.allow)
    ? raw.allow.filter((entry) => typeof entry === 'string' && entry !== '')
    : [];
  if (raw.allow !== undefined && !Array.isArray(raw.allow)) {
    warnings.push('api.allow 必须是字符串数组，已忽略');
  }
  return {
    source,
    env,
    enabled: raw.enabled === true,
    allow,
    authEnv: asString(raw.authEnv, '').trim(),
  };
}

/**
 * 风格基线：可选图片路径，用于「没有设计稿」时只做风格指标对照。
 * 这里只校验类型与空串；路径是否存在、是否在工作区内由 ui_diff 在运行时校验。
 */
function normalizeStyleBaseline(raw, warnings) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    warnings.push('styleBaseline 必须是字符串路径，已忽略');
    return '';
  }
  const value = raw.trim();
  if (value === '') return '';
  if (value.length > 1024) {
    warnings.push('styleBaseline 路径过长（>1024），已忽略');
    return '';
  }
  return value;
}

function normalizeStringList(raw) {  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (isPlainObject(entry)) {
        const text = entry.text ?? entry.issue ?? entry.id;
        if (typeof text === 'string' && text !== '') return text;
      }
      return undefined;
    })
    .filter((entry) => typeof entry === 'string' && entry !== '');
}

/**
 * 补默认值并校验，返回可直接使用的档案。
 * @param {object} raw 原始 JSON
 * @param {{ fallbackId?: string, path?: string, warnings?: string[] }} [options]
 */
export function normalizeProfile(raw, options = {}) {
  if (!isPlainObject(raw)) throw new Error('档案必须是 JSON 对象');
  const warnings = options.warnings ?? [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`未知档案字段已忽略：${key}`);
  }
  const id = asString(raw.id, '') || asString(options.fallbackId, '') || DEFAULT_PROFILE.id;
  const devices = Array.isArray(raw.devices) && raw.devices.length > 0
    ? raw.devices.map(normalizeDevice)
    : DEFAULT_PROFILE.devices.map((device) => ({ ...device }));
  const profile = {
    id,
    label: asString(raw.label, '') || id,
    baseUrl: asString(raw.baseUrl, ''),
    devices,
    thresholds: normalizeThresholds(raw.thresholds),
    rules: normalizeRules(raw.rules, warnings),
    tokens: normalizeTokens(raw.tokens, warnings),
    baseline: normalizeBaseline(raw.baseline, warnings),
    designSource: normalizeDesignSource(raw.designSource, warnings),
    design: normalizeDesign(raw.design, warnings),
    styleBaseline: normalizeStyleBaseline(raw.styleBaseline, warnings),
    api: normalizeApi(raw.api, warnings),
    knownIssues: normalizeStringList(raw.knownIssues),
    notes: asString(raw.notes, ''),
  };
  return { profile, warnings };
}

/** 档案查找顺序：显式路径 → 工作区 profileDir/<id>.json → 插件内置 profiles/<id>.json。 */
export function findProfilePath(id, { cwd, profileDir = DEFAULT_PROFILE_DIR } = {}) {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('profile 不能为空');
  const trimmed = id.trim();
  const looksLikePath = trimmed.includes('/') || trimmed.includes('\\') || trimmed.toLowerCase().endsWith('.json');
  const searched = [];

  if (looksLikePath) {
    const absolute = resolveWorkspacePath(cwd, trimmed);
    searched.push(absolute);
    if (existsSync(absolute) && statSync(absolute).isFile()) return { path: absolute, searched };
    throw new Error(`找不到档案文件：${trimmed}\n已查找：\n- ${searched.join('\n- ')}`);
  }

  const fileName = trimmed.toLowerCase().endsWith('.json') ? trimmed : `${trimmed}.json`;
  const candidates = [
    join(resolveWorkspacePath(cwd, profileDir), fileName),
    join(PLUGIN_ROOT, 'profiles', fileName),
  ];
  for (const candidate of candidates) {
    searched.push(candidate);
    if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate, searched };
  }
  throw new Error(`找不到项目档案「${trimmed}」\n已查找：\n- ${searched.join('\n- ')}\n可用的内置档案：${listBuiltinProfiles().join(' / ') || '（无）'}`);
}

/** 内置档案 id 列表（仅用于报错提示）。 */
export function listBuiltinProfiles() {
  try {
    return readdirSync(join(PLUGIN_ROOT, 'profiles'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => basename(name, '.json'));
  } catch {
    return [];
  }
}

/**
 * 载入档案。
 * @param {string|object|undefined} source 档案 id、JSON 文件路径、或已解析对象
 * @param {{ cwd?: string, profileDir?: string }} [options]
 * @returns {{ profile: object, path: string|undefined, warnings: string[], searched?: string[] }|null}
 */
export function loadProfile(source, options = {}) {
  if (source === undefined || source === null || source === '') return null;
  const warnings = [];
  if (isPlainObject(source)) {
    const normalized = normalizeProfile(source, { warnings, path: undefined });
    return { profile: normalized.profile, path: undefined, warnings };
  }
  if (typeof source !== 'string') throw new Error('profile 必须是字符串 id、JSON 路径或对象');
  const found = findProfilePath(source, options);
  const raw = readJsonFile(found.path, '项目档案');
  const normalized = normalizeProfile(raw, {
    fallbackId: basename(found.path, '.json'),
    path: found.path,
    warnings,
  });
  return { profile: normalized.profile, path: found.path, warnings, searched: found.searched };
}

/** 取档案的第一个设备档（工具缺省视口）。 */
export function primaryDevice(profile) {
  if (!profile) return { ...DEFAULT_PROFILE.devices[0] };
  const device = profile.devices?.[0];
  if (!device) return { ...DEFAULT_PROFILE.devices[0] };
  return device;
}
