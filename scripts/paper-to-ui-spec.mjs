#!/usr/bin/env node
/**
 * Paper 设计稿 → ui-spec.json（可选工具，零第三方依赖）
 *
 * 用 node 内置 fetch 走 JSON-RPC over HTTP 调用 Paper MCP：
 *   initialize → notifications/initialized → tools/call
 * 依次调用 get_basic_info / get_tokens / get_tree_summary / get_computed_styles，
 * 把 Paper 的 computed styles 过滤到 ui-spec 白名单，生成可交给 ui_probe(expected) 的契约。
 *
 * 用法：
 *   node scripts/paper-to-ui-spec.mjs --file <fileId> --artboard <nodeId> --out ui-spec.json \
 *     [--url <endpoint>] [--max-nodes 200] [--dry-run]
 *
 * 端点只从 --url 或环境变量 PAPER_MCP_URL 取；源码里不写死任何地址。
 *
 * @module dsh-ui-restore/paper-to-ui-spec
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROPERTY_NAMES, PROPERTY_RULES, validateSpec } from '../lib/spec.js';

export const ENDPOINT_ENV = 'PAPER_MCP_URL';
export const DEFAULT_MAX_NODES = 200;
export const DEFAULT_MAX_DEPTH = 3;
/** get_computed_styles 每批最多多少个 nodeIds。 */
export const STYLE_BATCH_SIZE = 50;
export const DEFAULT_OUT = 'ui-spec.json';
export const USAGE = `用法：
  node scripts/paper-to-ui-spec.mjs --file <fileId> --artboard <nodeId> [--out ui-spec.json]
    [--url <endpoint>] [--max-nodes 200] [--max-depth 3] [--dry-run]

  --file       Paper 文件 id（get_tokens 等 get_* 需要显式传）
  --artboard   目标画板节点 id（get_basic_info.artboards[].id）
  --out        输出 ui-spec.json 路径（默认 ${DEFAULT_OUT}）
  --url        Paper MCP endpoint；缺省读环境变量 ${ENDPOINT_ENV}
  --max-nodes  最多采集多少个节点（默认 ${DEFAULT_MAX_NODES}，超出会截断并 warning）
  --max-depth  get_children BFS 的最大深度（默认 ${DEFAULT_MAX_DEPTH}）
  --dry-run    打印计划；带端点时会只读探测并列出 artboards / 实际调用次数，不落盘

只读：只调用 get_* 工具，不调用 write_html / update_styles / create_artboard /
delete_nodes / set_text_content 等写类工具。`;

const TOOL_NAMES = new Set([
  'get_basic_info',
  'get_tokens',
  'get_tree_summary',
  'get_children',
  'get_computed_styles',
]);

/**
 * 每个工具「业务载荷」的判定键：真实 Paper 的 tools/call 会先返回一段
 * `{ file, contentHash }` 上下文头，再返回业务载荷；这里用键名挑出真正的 payload，
 * 不依赖 block 顺序，也不取「最后一个」。
 */
const TOOL_PAYLOAD_KEYS = Object.freeze({
  get_basic_info: ['artboards', 'fileName', 'pageId', 'rootNodeId', 'artboardCount', 'nodeCount'],
  get_tokens: ['tokens'],
  get_tree_summary: ['summary', 'tree', 'nodes', 'root'],
  get_children: ['children'],
  get_computed_styles: ['styles'],
});

const STYLE_KEY_ALIASES = {
  'font-size': 'fontSize',
  'line-height': 'lineHeight',
  'letter-spacing': 'letterSpacing',
  'word-spacing': 'wordSpacing',
  'text-indent': 'textIndent',
  'font-weight': 'fontWeight',
  'font-family': 'fontFamily',
  'font-style': 'fontStyle',
  'background-color': 'backgroundColor',
  'border-radius': 'borderRadius',
  'border-color': 'borderColor',
  'border-width': 'borderWidth',
  'box-shadow': 'boxShadow',
  'text-shadow': 'textShadow',
  'text-align': 'textAlign',
  'text-transform': 'textTransform',
  'text-decoration-line': 'textDecorationLine',
  'white-space': 'whiteSpace',
  'box-sizing': 'boxSizing',
  'flex-direction': 'flexDirection',
  'flex-wrap': 'flexWrap',
  'align-items': 'alignItems',
  'justify-content': 'justifyContent',
  'align-content': 'alignContent',
  'align-self': 'alignSelf',
  'justify-self': 'justifySelf',
  'row-gap': 'rowGap',
  'column-gap': 'columnGap',
  'min-width': 'minWidth',
  'min-height': 'minHeight',
  'max-width': 'maxWidth',
  'max-height': 'maxHeight',
  'padding-top': 'paddingTop',
  'padding-right': 'paddingRight',
  'padding-bottom': 'paddingBottom',
  'padding-left': 'paddingLeft',
  'margin-top': 'marginTop',
  'margin-right': 'marginRight',
  'margin-bottom': 'marginBottom',
  'margin-left': 'marginLeft',
  'border-top-width': 'borderTopWidth',
  'border-right-width': 'borderRightWidth',
  'border-bottom-width': 'borderBottomWidth',
  'border-left-width': 'borderLeftWidth',
  'border-top-color': 'borderTopColor',
  'border-right-color': 'borderRightColor',
  'border-bottom-color': 'borderBottomColor',
  'border-left-color': 'borderLeftColor',
  'border-top-left-radius': 'borderTopLeftRadius',
  'border-top-right-radius': 'borderTopRightRadius',
  'border-bottom-right-radius': 'borderBottomRightRadius',
  'border-bottom-left-radius': 'borderBottomLeftRadius',
  'outline-width': 'outlineWidth',
  'outline-color': 'outlineColor',
  'outline-offset': 'outlineOffset',
  'text-overflow': 'textOverflow',
  'overflow-wrap': 'overflowWrap',
  'word-break': 'wordBreak',
  'object-fit': 'objectFit',
  'user-select': 'userSelect',
  'pointer-events': 'pointerEvents',
  'font-variant-numeric': 'fontVariantNumeric',
  'vertical-align': 'verticalAlign',
  'caret-color': 'caretColor',
  'text-decoration-color': 'textDecorationColor',
  'flex-basis': 'flexBasis',
  'flex-grow': 'flexGrow',
  'flex-shrink': 'flexShrink',
};

function fail(message) {
  const error = new Error(message);
  error.code = 'PAPER_UI_SPEC_ERROR';
  return error;
}

/** 解析 CLI 参数（`--key value` 与 `--key=value` 都支持）。 */
export function parseArgs(argv) {
  const options = { maxNodes: DEFAULT_MAX_NODES, maxDepth: DEFAULT_MAX_DEPTH, out: DEFAULT_OUT, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const next = () => {
      if (inline !== undefined) return inline;
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw fail(`参数 ${flag} 缺少值`);
      index += 1;
      return value;
    };
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--file') options.file = next();
    else if (flag === '--artboard') options.artboard = next();
    else if (flag === '--out') options.out = next();
    else if (flag === '--url') options.url = next();
    else if (flag === '--max-nodes') {
      const value = Number(next());
      if (!Number.isInteger(value) || value <= 0) throw fail(`--max-nodes 必须是正整数，收到 ${value}`);
      options.maxNodes = value;
    } else if (flag === '--max-depth') {
      const value = Number(next());
      if (!Number.isInteger(value) || value <= 0) throw fail(`--max-depth 必须是正整数，收到 ${value}`);
      options.maxDepth = value;
    } else if (flag === '--') {
      // 忽略分隔符后的内容（没有位置参数）。
      break;
    } else {
      throw fail(`未知参数：${arg}`);
    }
  }
  return options;
}

/** 端点只从 --url 或 PAPER_MCP_URL 取；缺失时给示例值。 */
export function resolveEndpoint(options = {}, env = process.env) {
  const url = options.url ?? env[ENDPOINT_ENV];
  if (typeof url !== 'string' || url.trim() === '') {
    throw fail(`缺少 Paper MCP 端点：请传 --url，或设置环境变量 ${ENDPOINT_ENV}（示例：--url http://<paper-host>:<port>/mcp）。`);
  }
  return url.trim();
}

/** 解析 SSE（text/event-stream）或普通 JSON 响应体。 */
export function parseMcpBody(text, contentType = '') {
  const raw = String(text ?? '').trim();
  if (raw === '') throw fail('Paper MCP 返回了空响应');
  if (!/text\/event-stream/i.test(contentType) && !/^\s*(?:event|data):/m.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      throw fail(`Paper MCP 返回的不是合法 JSON：${raw.slice(0, 200)}`);
    }
  }
  const chunks = [];
  let current = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') {
      if (current.length > 0) chunks.push(current.join('\n'));
      current = [];
    } else if (line.startsWith('data:')) {
      current.push(line.slice('data:'.length).trimStart());
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(chunks[index]);
    } catch {
      // 继续尝试更早的 data 块。
    }
  }
  throw fail(`Paper MCP 的 SSE 响应里没有可解析的 JSON：${raw.slice(0, 200)}`);
}

/** 判断一段载荷是否是 Paper 的上下文头（只有 file/contentHash、没有业务键）。 */
function isContextHeader(payload, businessKeys) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const hasContext = Object.hasOwn(payload, 'file') || Object.hasOwn(payload, 'contentHash');
  const hasBusiness = businessKeys.some((key) => Object.hasOwn(payload, key));
  return hasContext && !hasBusiness;
}

/**
 * 从 tools/call 结果里取出 JSON 载荷。
 *
 * 规则（按优先级）：
 *  1. `structuredContent` 直接使用；
 *  2. 解析**所有** text block（不是只取第一个），非 JSON 块给出可读错误；
 *  3. 跳过只有 `file`/`contentHash` 的上下文头；
 *  4. 按工具的业务键选块（get_basic_info→artboards/fileName、get_tokens→tokens、
 *     get_tree_summary→summary、get_children→children、get_computed_styles→styles）；
 *  5. 多个业务块时浅合并并写 warning，不假设顺序。
 * 找不到业务块时抛「返回里没有 <业务键>」，绝不静默返回空结果。
 *
 * @param {object} result tools/call 的 result
 * @param {string} [toolName] 工具名；省略时退化为「第一个非上下文头块」
 * @param {string[]} [warnings] 合并等非致命提示的收集器
 * @returns {any} 选中的 JSON 载荷
 */
export function extractToolPayload(result, toolName = undefined, warnings = []) {
  if (result === undefined || result === null) throw fail('Paper MCP 工具没有返回结果');
  if (result.isError === true) {
    const detail = Array.isArray(result.content)
      ? result.content.map((item) => item?.text ?? '').join(' ').trim()
      : '';
    throw fail(`Paper MCP 工具报错：${detail || '（无错误详情）'}`);
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;

  const blocks = [];
  const skipped = [];
  if (Array.isArray(result.content)) {
    result.content.forEach((item, index) => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return;
      const text = item.text.trim();
      if (text === '') return;
      try {
        blocks.push({ index, payload: JSON.parse(text) });
      } catch {
        skipped.push(`block[${index}] 不是 JSON：${text.slice(0, 80)}`);
      }
    });
  }
  if (skipped.length > 0) {
    warnings.push(`Paper MCP ${toolName ?? 'tool'} 跳过 ${skipped.length} 个非 JSON text block（${skipped.join('；')}）。`);
  }
  if (blocks.length === 0) {
    throw fail(`Paper MCP 工具返回里没有可解析的 JSON text block：${skipped.join('；') || JSON.stringify(result).slice(0, 200)}`);
  }

  const businessKeys = toolName === undefined ? [] : (TOOL_PAYLOAD_KEYS[toolName] ?? []);
  const payloads = blocks.map((block) => block.payload);
  if (businessKeys.length === 0) {
    // 没有工具上下文（或未知工具）：返回第一个非上下文头块；全是头时退回第一块。
    return payloads.find((payload) => !isContextHeader(payload, [])) ?? payloads[0];
  }

  const candidates = payloads.filter((payload) => !isContextHeader(payload, businessKeys)
    && businessKeys.some((key) => Object.hasOwn(payload, key)));
  if (candidates.length === 0) {
    throw fail(`Paper MCP 返回里没有 ${businessKeys[0]}（tool=${toolName}）：只拿到 ${blocks.map((block) => `block[${block.index}]`).join('、')} 的上下文头，业务载荷缺失。`);
  }
  if (candidates.length === 1) return candidates[0];
  const merged = Object.assign({}, ...candidates);
  warnings.push(`Paper MCP ${toolName} 返回了 ${candidates.length} 段业务载荷，已按出现顺序浅合并（后者覆盖前者）。`);
  return merged;
}

/** 创建最小 MCP 客户端：initialize → notifications/initialized → tools/call。 */
export function createMcpClient({ url, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof fetchImpl !== 'function') throw fail('当前 Node 没有可用的 fetch（需要 Node >= 20）。');
  let nextId = 1;
  let sessionId;

  async function rpc(body) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : error.message;
      throw fail(`无法连接 Paper MCP（${url}）：${reason}。确认 Paper 已启动且端点可访问。`);
    } finally {
      clearTimeout(timer);
    }
    const sid = response.headers?.get?.('mcp-session-id');
    if (sid) sessionId = sid;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw fail(`Paper MCP 返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`);
    }
    if (body.id === undefined) return undefined;
    const payload = parseMcpBody(await response.text(), response.headers?.get?.('content-type') ?? '');
    if (payload.error !== undefined) {
      throw fail(`Paper MCP 错误：${payload.error?.message ?? JSON.stringify(payload.error)}`);
    }
    return payload.result;
  }

  const warnings = [];
  return {
    /** 本次客户端的非致命提示（例如多段业务载荷浅合并）。 */
    warnings,
    async initialize() {
      await rpc({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'dsh-ui-restore-paper-to-ui-spec', version: '0.1.0' },
        },
      });
      await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    async callTool(name, args = {}) {
      if (!TOOL_NAMES.has(name)) throw fail(`拒绝调用非只读工具：${name}`);
      const result = await rpc({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      return extractToolPayload(result, name, warnings);
    },
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** 从 get_basic_info 提取 artboards（兼容 artboards 字段在根部或 result 内）。 */
export function normalizeArtboards(info) {
  const payload = info ?? {};
  const artboards = payload.artboards ?? payload.result?.artboards ?? payload.file?.artboards ?? [];
  return asArray(artboards).map((artboard) => ({
    id: String(artboard.id ?? artboard.nodeId ?? ''),
    name: artboard.name ?? artboard.title ?? '',
    width: Number(artboard.width),
    height: Number(artboard.height),
  })).filter((artboard) => artboard.id !== '' && Number.isFinite(artboard.width) && Number.isFinite(artboard.height));
}

function normalizeTreeInput(tree) {
  if (Array.isArray(tree)) return tree;
  if (tree === undefined || tree === null) return [];
  if (tree.nodes !== undefined) return tree.nodes;
  if (tree.root !== undefined) return [tree.root];
  if (tree.tree !== undefined) return normalizeTreeInput(tree.tree);
  return [tree];
}

/** 深度优先收集节点（id/name/type/selector），超过 maxNodes 时返回截断标记。 */
export function collectTreeNodes(tree, maxNodes = DEFAULT_MAX_NODES) {
  const collected = [];
  let truncated = false;
  const visit = (node) => {
    if (node === undefined || node === null) return;
    if (collected.length >= maxNodes) {
      truncated = true;
      return;
    }
    if (node.id !== undefined) {
      collected.push({
        id: String(node.id),
        name: node.name ?? node.title ?? '',
        type: node.type ?? node.kind ?? '',
        ...(typeof node.selector === 'string' ? { selector: node.selector } : {}),
      });
    }
    for (const child of asArray(node.children ?? node.nodes)) visit(child);
  };
  for (const node of normalizeTreeInput(tree)) visit(node);
  return { nodes: collected, truncated };
}

/** get_children 的载荷归一：`{ children: [...] }` 或裸数组。 */
export function childrenOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === 'object' && Array.isArray(payload.children)) return payload.children;
  return [];
}

/**
 * 从 artboard 开始按 `get_children` 逐层 BFS 采集节点。
 *
 * Paper 0.5.19 的 `get_tree_summary` 只返回文本树（`{ summary: "Frame ..." }`），不能用来取节点；
 * 这里按真实行为设计：根节点入队，逐层取 children，记录 id/name/component/childCount/depth/parentId，
 * 到 `maxNodes` 或 `maxDepth` 即停。某个节点的 get_children 失败只跳过该分支并写 warning。
 *
 * @returns {{nodes: Array<object>, truncated: boolean, childrenCalls: number}}
 */
export async function collectNodesBfs({
  client,
  fileId,
  rootId,
  rootName = '',
  rootComponent = 'artboard',
  maxNodes = DEFAULT_MAX_NODES,
  maxDepth = DEFAULT_MAX_DEPTH,
  warnings = [],
} = {}) {
  const nodes = [];
  let truncated = false;
  let childrenCalls = 0;
  const queue = [{ id: String(rootId), parentId: null, depth: 0, name: rootName, component: rootComponent }];
  while (queue.length > 0 && nodes.length < maxNodes) {
    const current = queue.shift();
    const record = {
      id: current.id,
      name: current.name,
      component: current.component,
      childCount: 0,
      depth: current.depth,
      parentId: current.parentId,
    };
    nodes.push(record);
    if (current.depth >= maxDepth) continue;
    childrenCalls += 1;
    let payload;
    try {
      payload = await client.callTool('get_children', { fileId, nodeId: current.id });
    } catch (error) {
      warnings.push(`get_children(${current.id}) 失败：${error.message}，已跳过该分支。`);
      continue;
    }
    const children = childrenOf(payload);
    record.childCount = children.length;
    for (const child of children) {
      if (child?.id === undefined) continue;
      if (nodes.length + queue.length >= maxNodes) {
        truncated = true;
        break;
      }
      queue.push({
        id: String(child.id),
        parentId: current.id,
        depth: current.depth + 1,
        name: child.name ?? '',
        component: child.component ?? child.type ?? '',
      });
    }
  }
  if (queue.length > 0) truncated = true;
  return { nodes, truncated, childrenCalls };
}

/** 把数组切成固定大小的批。 */
export function chunk(list, size) {
  const batches = [];
  for (let index = 0; index < list.length; index += size) batches.push(list.slice(index, index + size));
  return batches;
}

const PROPERTY_SET = new Set(PROPERTY_NAMES);

/** Paper 的 CSS 属性名（kebab-case 或 camelCase）→ ui-spec 白名单键。 */
export function toUiSpecPropertyName(key) {
  const text = String(key ?? '').trim();
  if (PROPERTY_SET.has(text)) return text;
  if (STYLE_KEY_ALIASES[text] !== undefined) return STYLE_KEY_ALIASES[text];
  const camel = text.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return PROPERTY_SET.has(camel) ? camel : undefined;
}

/** 单值归一：长度缺单位补 px，数字属性转 number，颜色 hex 小写。 */
const LENGTH_LITERAL_PATTERN = /^-?\d+(?:\.\d+)?(?:px|rem|em)$/i;
const COLOR_LITERAL_PATTERN = /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;
const CSS_EXPRESSION_PATTERN = /\b(?:calc|var|env|clamp)\(/i;

/**
 * 单值归一（B8）：Paper 的 computed styles 里常有 `calc(50% + 0px)`、`var(--x)`、
 * `auto`、百分比等 ui-spec 不接受的值。这里按属性类型过滤：
 *  - length：只接受有限数字或 px/rem/em 字面量；表达式 / 百分比 / 关键字 → undefined（跳过）
 *  - color：只接受 #hex / rgb()/rgba()/hsl()/hsla()；var()/currentColor/transparent → undefined
 *  - keyword：保留关键字字符串；含 calc()/var()/env() → undefined
 *  - number：数字/数字字符串转 number；关键字（如 bold）保留；表达式 → undefined
 *  - 其它（shadow / font / lengthOrKeyword）：原样保留，避免过度过滤
 * 返回 undefined 表示跳过（调用方负责计入 stats.skipped）。
 */
export function normalizeStyleValue(property, value) {
  const rule = PROPERTY_RULES[property];
  if (rule === undefined || value === undefined || value === null) return undefined;

  if (rule.kind === 'length') {
    if (typeof value === 'number') return Number.isFinite(value) ? `${value}px` : undefined;
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (text === '') return undefined;
    if (LENGTH_LITERAL_PATTERN.test(text)) return text.toLowerCase();
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return `${text}px`;
    return undefined;
  }

  if (rule.kind === 'color') {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (text === '' || CSS_EXPRESSION_PATTERN.test(text)) return undefined;
    if (!COLOR_LITERAL_PATTERN.test(text)) return undefined;
    return /^#/i.test(text) ? text.toLowerCase() : text;
  }

  if (rule.kind === 'keyword') {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (text === '' || CSS_EXPRESSION_PATTERN.test(text)) return undefined;
    return text;
  }

  if (rule.kind === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (text === '' || CSS_EXPRESSION_PATTERN.test(text)) return undefined;
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
    return text;
  }

  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/** 归一化 get_computed_styles 返回：数组 / {nodes} / {styles: map} / 直接 map 都接受。 */
export function normalizeComputedStyles(payload) {
  const map = new Map();
  const consume = (entry) => {
    if (entry === undefined || entry === null) return;
    const id = entry.nodeId ?? entry.id ?? entry.node?.id;
    const styles = entry.styles ?? entry.computedStyles ?? entry.style;
    if (id !== undefined && styles !== undefined) map.set(String(id), styles);
  };
  const value = payload ?? {};
  if (Array.isArray(value)) {
    value.forEach(consume);
  } else if (Array.isArray(value.nodes)) {
    value.nodes.forEach(consume);
  } else if (value.styles !== undefined && typeof value.styles === 'object' && !Array.isArray(value.styles)) {
    for (const [id, styles] of Object.entries(value.styles)) map.set(String(id), styles);
  } else if (value.styles === undefined && value.nodeId === undefined && value.id === undefined) {
    for (const [id, styles] of Object.entries(value)) {
      if (styles !== null && typeof styles === 'object' && !Array.isArray(styles)) map.set(String(id), styles);
    }
  } else {
    consume(value);
  }
  return map;
}

/** 过滤 + 归一化单个节点的 computed styles。 */
export function filterStyles(styles, metrics = undefined) {
  const properties = {};
  for (const [key, value] of Object.entries(styles ?? {})) {
    const property = toUiSpecPropertyName(key);
    if (property === undefined) continue;
    const normalized = normalizeStyleValue(property, value);
    if (normalized === undefined) {
      if (metrics !== undefined) {
        metrics.skipped += 1;
        metrics.skippedByProp[property] = (metrics.skippedByProp[property] ?? 0) + 1;
      }
      continue;
    }
    if (metrics !== undefined) metrics.collected += 1;
    properties[property] = normalized;
  }
  return properties;
}

/** 由 artboard / 节点 / computed styles 组装 ui-spec，并做 schema 级校验。 */
export function buildUiSpec({ file, artboard, nodes, styles, tokens = [], maxNodes = DEFAULT_MAX_NODES, metrics = undefined }) {
  const elements = [];
  for (const node of nodes) {
    if (elements.length >= maxNodes) break;
    const properties = filterStyles(styles.get(node.id), metrics);
    if (Object.keys(properties).length === 0) continue;
    elements.push({
      selector: node.selector ?? `[data-node-id="${node.id}"]`,
      label: node.name || node.id,
      note: `Paper node ${node.id}${node.name ? `（${node.name}）` : ''}；selector 由画师按页面结构映射后替换。`,
      properties,
    });
  }
  if (elements.length === 0) {
    throw fail('没有可生成的元素：目标节点没有 computed styles，或所有属性都不在 ui-spec 白名单内。');
  }
  const tokenCount = toTokenArray(tokens).length;
  const notes = [
    '由 Paper MCP 直读生成：get_basic_info → get_tokens → get_children（BFS）→ get_computed_styles（分批）。',
    'Paper node.id 与页面 selector 的映射由画师声明并写进交接；当前 selector 是 [data-node-id="…"] 占位。',
    tokenCount === 0
      ? '该设计稿没有 token（get_tokens 返回空），本契约只写元素级 computed styles。'
      : `get_tokens 返回 ${tokenCount} 个 token；本契约只写元素级 computed styles，token 请按项目规范落到变量文件。`,
  ].join(' ');
  const spec = {
    version: 1,
    name: `Paper: ${file?.name ?? 'design'} / ${artboard.name || artboard.id}`,
    viewport: { width: artboard.width, height: artboard.height, dpr: 1 },
    notes,
    elements,
  };
  validateSpec(spec);
  return spec;
}

function toTokenArray(payload) {
  if (Array.isArray(payload)) return payload;
  return asArray(payload?.tokens ?? []);
}

/** 一次完整转换：连接信息由调用方传入 client，方便离线单测。 */
export async function convert({ client, fileId, artboardId, maxNodes = DEFAULT_MAX_NODES, maxDepth = DEFAULT_MAX_DEPTH, info: preloadedInfo = undefined }) {
  const info = preloadedInfo ?? await client.callTool('get_basic_info', {});
  const artboards = normalizeArtboards(info);
  const artboard = artboards.find((candidate) => candidate.id === String(artboardId));
  if (artboard === undefined) {
    throw fail(`artboard 不存在：${artboardId}；可用 artboard：${artboards.map((item) => `${item.id}（${item.name}）`).join('、') || '（get_basic_info 没有返回）'}`);
  }
  const tokens = await client.callTool('get_tokens', { fileId });
  const warnings = [...(client.warnings ?? [])];

  // 采集节点：只用 get_children 逐层 BFS。get_tree_summary 在真实 Paper 里只有文本树，
  // 不参与建 ui-spec（仅在 --dry-run 概览时使用）。
  const collected = await collectNodesBfs({
    client,
    fileId,
    rootId: artboard.id,
    rootName: artboard.name,
    maxNodes,
    maxDepth,
    warnings,
  });
  if (collected.nodes.length === 0) {
    throw fail(`get_children 没有返回节点：fileId=${fileId} artboard=${artboard.id}`);
  }
  if (collected.nodes.length === 1 && collected.nodes[0].childCount === 0) {
    throw fail(`get_children 返回空：artboard ${artboard.id}（${artboard.name}）没有任何子节点；确认 fileId / artboard id 与 Paper 当前打开的文件。`);
  }

  // 样式按批取（每批 ≤ STYLE_BATCH_SIZE）；单批失败只跳过该批并 warning。
  const styles = new Map();
  const nodeIds = collected.nodes.map((node) => node.id);
  let styleCalls = 0;
  for (const batch of chunk(nodeIds, STYLE_BATCH_SIZE)) {
    styleCalls += 1;
    try {
      const stylesPayload = await client.callTool('get_computed_styles', { fileId, nodeIds: batch });
      for (const [nodeId, nodeStyles] of normalizeComputedStyles(stylesPayload)) styles.set(nodeId, nodeStyles);
    } catch (error) {
      warnings.push(`get_computed_styles 第 ${styleCalls} 批（${batch.length} 个节点）失败：${error.message}，已跳过该批。`);
    }
  }

  const metrics = { collected: 0, skipped: 0, skippedByProp: {} };
  const spec = buildUiSpec({
    file: info?.file ?? { name: info?.fileName },
    artboard,
    nodes: collected.nodes,
    styles,
    tokens,
    maxNodes,
    metrics,
  });
  const styledCount = collected.nodes.filter((node) => Object.keys(filterStyles(styles.get(node.id))).length > 0).length;
  if (metrics.skipped > 0) {
    const top = Object.entries(metrics.skippedByProp)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([property, count]) => `${property}×${count}`)
      .join('、');
    warnings.push(`已跳过 ${metrics.skipped} 个无法写入 ui-spec 的样式值（${top}）；calc()/var()/百分比/auto 等表达式不参与契约。`);
  }
  if (collected.truncated) {
    warnings.push(`节点数超过 --max-nodes=${maxNodes} 或层级超过 --max-depth=${maxDepth}（已采集 ${collected.nodes.length} 个节点，有样式 ${styledCount} 个），已截断；可调大上限。`);
  }
  return {
    spec,
    warnings,
    stats: {
      artboard: { id: artboard.id, name: artboard.name, width: artboard.width, height: artboard.height },
      nodes: collected.nodes.length,
      elements: spec.elements.length,
      tokens: toTokenArray(tokens).length,
      childrenCalls: collected.childrenCalls,
      styleCalls,
      maxDepth,
      truncated: collected.truncated,
      collected: metrics.collected,
      skipped: metrics.skipped,
      skippedByProp: metrics.skippedByProp,
    },
  };
}

/** CLI 末尾的一行摘要（也便于把 stats 贴进任务/报告）。 */
function statsLine(stats) {
  return `summary: nodes=${stats.nodes} elements=${stats.elements} childrenCalls=${stats.childrenCalls} styleCalls=${stats.styleCalls} collected=${stats.collected ?? 0} skipped=${stats.skipped ?? 0} truncated=${stats.truncated === true}`;
}

/** CLI 入口；返回进程退出码（0 成功 / 1 运行失败 / 2 用法错误）。 */
export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`参数错误：${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const missing = [];
  if (options.file === undefined) missing.push('--file');
  if (options.artboard === undefined) missing.push('--artboard');
  if (missing.length > 0) {
    console.error(`缺少参数：${missing.join('、')}`);
    console.error(USAGE);
    return 2;
  }
  const outPath = resolve(options.out);
  const rawEndpoint = options.url ?? env[ENDPOINT_ENV];
  const endpointProvided = typeof rawEndpoint === 'string' && rawEndpoint.trim() !== '';
  let endpoint;
  if (options.dryRun && !endpointProvided) {
    endpoint = `（未设置 ${ENDPOINT_ENV}；实际执行时需要）`;
  } else {
    try {
      endpoint = resolveEndpoint(options, env);
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }
  if (options.dryRun) {
    const plan = {
      dryRun: true,
      endpoint,
      fileId: options.file,
      artboardId: options.artboard,
      out: outPath,
      maxNodes: options.maxNodes,
      maxDepth: options.maxDepth,
      plan: [
        'initialize',
        'tools/call get_basic_info',
        'tools/call get_tokens',
        `tools/call get_children × N（BFS，max-depth=${options.maxDepth}，max-nodes=${options.maxNodes}）`,
        'tools/call get_computed_styles × M（每批 ≤ 50 个 nodeIds）',
        `write ${outPath}`,
      ],
    };
    if (endpointProvided) {
      // dry-run 做只读探测：列出 artboards、确认 artboard、打印 tree summary 概览与真实调用次数（不落盘）。
      try {
        const probeClient = createMcpClient({ url: endpoint, fetchImpl });
        await probeClient.initialize();
        const info = await probeClient.callTool('get_basic_info', {});
        const artboards = normalizeArtboards(info);
        plan.artboards = artboards;
        plan.selectedArtboard = artboards.find((candidate) => candidate.id === String(options.artboard)) ?? null;
        if (plan.selectedArtboard === null) {
          console.error(`artboard 不存在：${options.artboard}；可用 artboard：${artboards.map((item) => `${item.id}（${item.name}）`).join('、') || '（get_basic_info 没有返回）'}`);
          return 1;
        }
        try {
          const overviewPayload = await probeClient.callTool('get_tree_summary', { fileId: options.file, nodeId: options.artboard });
          const overview = overviewPayload?.summary !== undefined ? overviewPayload.summary : overviewPayload;
          plan.treeSummary = typeof overview === 'string' ? overview.slice(0, 800) : JSON.stringify(overview).slice(0, 800);
        } catch (error) {
          plan.treeSummary = `读取概览失败：${error.message}`;
        }
        const probe = await convert({
          client: probeClient,
          fileId: options.file,
          artboardId: options.artboard,
          maxNodes: options.maxNodes,
          maxDepth: options.maxDepth,
          info,
        });
        plan.plan = [
          'initialize',
          'tools/call get_basic_info',
          'tools/call get_tokens',
          `tools/call get_children × ${probe.stats.childrenCalls}`,
          `tools/call get_computed_styles × ${probe.stats.styleCalls}（每批 ≤ 50 个 nodeIds）`,
          `write ${outPath}`,
        ];
        plan.stats = probe.stats;
        plan.elements = probe.spec.elements.length;
        if (probe.warnings.length > 0) plan.warnings = probe.warnings;
      } catch (error) {
        plan.paperProbe = `无法读取 Paper（只打印计划）：${error.message}`;
      }
    }
    console.log(JSON.stringify(plan, null, 2));
    if (plan.stats !== undefined) console.log(statsLine(plan.stats));
    return 0;
  }
  const client = createMcpClient({ url: endpoint, fetchImpl });
  try {
    await client.initialize();
    const result = await convert({ client, fileId: options.file, artboardId: options.artboard, maxNodes: options.maxNodes, maxDepth: options.maxDepth });
    writeFileSync(outPath, `${JSON.stringify(result.spec, null, 2)}\n`, 'utf8');
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    console.log(JSON.stringify({
      out: outPath,
      elements: result.spec.elements.length,
      viewport: result.spec.viewport,
      tokens: result.stats.tokens,
      childrenCalls: result.stats.childrenCalls,
      styleCalls: result.stats.styleCalls,
      maxDepth: result.stats.maxDepth,
      truncated: result.stats.truncated,
      collected: result.stats.collected,
      skipped: result.stats.skipped,
      skippedByProp: result.stats.skippedByProp,
      warnings: result.warnings,
    }, null, 2));
    console.log(statsLine(result.stats));
    return 0;
  } catch (error) {
    console.error(`生成失败：${error.message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
