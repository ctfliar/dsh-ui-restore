/**
 * dsh-ui-restore · ui-spec 契约
 *
 * ui-spec 是「期望样式」的中立声明，ui_probe 用它逐属性对比
 * getComputedStyle 的结果。它不绑定任何组件库、也不连接任何服务：
 *
 *   {
 *     "version": 1,
 *     "name": "列表页基线",
 *     "viewport": { "width": 1440, "height": 900, "dpr": 1 },
 *     "tolerance": { "length": 0.5, "number": 0.01, "color": 0 },
 *     "elements": [
 *       {
 *         "selector": ".toolbar .btn-primary",
 *         "label": "主操作按钮",
 *         "properties": {
 *           "backgroundColor": "#2563eb",
 *           "fontSize": "14px",
 *           "paddingLeft": 16
 *         }
 *       }
 *     ]
 *   }
 *
 * 属性名一律使用 getComputedStyle 的驼峰写法；长度可以写数字（按 px 处理）
 * 或带单位的字符串。非法属性、非法值类型都会抛错，不会静默跳过。
 *
 * @module dsh-ui-restore/spec
 */
import { readJsonFile, resolveWorkspacePath } from './paths.js';

export const SPEC_VERSION = 1;
export const SPEC_KEYS = ['version', 'name', 'viewport', 'tolerance', 'elements', 'notes'];

const LENGTH_PROPERTIES = [
  'fontSize', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'gap', 'rowGap', 'columnGap',
  'borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
  'outlineWidth', 'outlineOffset',
  'top', 'right', 'bottom', 'left', 'flexBasis',
];

const COLOR_PROPERTIES = [
  'color', 'backgroundColor', 'borderColor',
  'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
  'outlineColor', 'caretColor', 'textDecorationColor',
];

const NUMBER_PROPERTIES = ['fontWeight', 'opacity', 'zIndex', 'flexGrow', 'flexShrink', 'order'];

const KEYWORD_PROPERTIES = [
  'display', 'position', 'flexDirection', 'flexWrap', 'alignItems', 'justifyContent',
  'alignContent', 'alignSelf', 'justifySelf', 'textAlign', 'textTransform', 'textDecorationLine',
  'overflow', 'overflowX', 'overflowY', 'whiteSpace', 'boxSizing', 'fontStyle', 'visibility',
  'float', 'clear', 'cursor', 'pointerEvents', 'wordBreak', 'overflowWrap', 'objectFit',
  'userSelect', 'textOverflow', 'fontVariantNumeric',
];

const SHADOW_PROPERTIES = ['boxShadow', 'textShadow'];
const FONT_PROPERTIES = ['fontFamily'];
const LENGTH_OR_KEYWORD_PROPERTIES = ['verticalAlign'];

/** 布局关键字，不匹配时按高严重度处理。 */
const LAYOUT_KEYWORDS = new Set(['display', 'position', 'overflow', 'overflowX', 'overflowY', 'flexDirection', 'flexWrap']);

const SHORTHAND_LENGTH_KEYWORDS = new Set([
  'normal', 'auto', 'none', 'inherit', 'initial', 'unset', 'revert', 'revert-layer',
  'fit-content', 'min-content', 'max-content', 'stretch',
]);

const LENGTH_PATTERN = /^-?\d+(\.\d+)?(px|em|rem|%|vw|vh|vmin|vmax|ch|ex|pt)?$/i;
const HEX_PATTERN = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_PATTERN = /^rgba?\(\s*([^)]+)\)$/i;
const HSL_PATTERN = /^hsla?\(\s*([^)]+)\)$/i;

const NAMED_COLORS = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  currentcolor: null,
};

/** 属性 → 校验/比较规则。 */
export const PROPERTY_RULES = Object.freeze(
  Object.fromEntries([
    ...LENGTH_PROPERTIES.map((property) => [property, { kind: 'length', property }]),
    ...COLOR_PROPERTIES.map((property) => [property, { kind: 'color', property }]),
    ...NUMBER_PROPERTIES.map((property) => [property, { kind: 'number', property }]),
    ...KEYWORD_PROPERTIES.map((property) => [property, { kind: 'keyword', property }]),
    ...SHADOW_PROPERTIES.map((property) => [property, { kind: 'shadow', property }]),
    ...FONT_PROPERTIES.map((property) => [property, { kind: 'font', property }]),
    ...LENGTH_OR_KEYWORD_PROPERTIES.map((property) => [property, { kind: 'lengthOrKeyword', property }]),
  ]),
);

export const PROPERTY_NAMES = Object.keys(PROPERTY_RULES);

/** ui-spec 非法时抛出，issues 里是所有问题。 */
export class UiSpecError extends Error {
  constructor(issues) {
    super(`ui-spec 非法：\n- ${issues.join('\n- ')}`);
    this.name = 'UiSpecError';
    this.issues = issues;
  }
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseAlpha(value, fallback = 1) {
  if (value === undefined) return fallback;
  const text = String(value).trim();
  if (text.endsWith('%')) return Math.max(0, Math.min(1, Number.parseFloat(text) / 100));
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function parseRgbComponent(value) {
  const text = String(value).trim();
  if (text.endsWith('%')) return clampByte((Number.parseFloat(text) / 100) * 255);
  return clampByte(Number.parseFloat(text));
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const light = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const table = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[Math.min(5, Math.floor(hue / 60))];
  return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}

/**
 * 把颜色字符串归一化成 {r,g,b,a}；无法识别返回 null。
 * 支持 #rgb/#rgba/#rrggbb/#rrggbbaa、rgb()/rgba()、hsl()/hsla() 和少量常用关键字。
 */
export function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === '') return null;
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, text)) {
    const named = NAMED_COLORS[text];
    return named ? { ...named } : null;
  }
  if (HEX_PATTERN.test(text)) {
    const hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
        a: hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : 1,
      };
    }
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgbMatch = RGB_PATTERN.exec(text);
  if (rgbMatch) {
    const body = rgbMatch[1].trim();
    const [main, alphaPart] = body.includes('/') ? body.split('/') : [body, undefined];
    const parts = main.split(/[,\s]+/).filter((part) => part !== '');
    if (parts.length < 3) return null;
    const alpha = alphaPart !== undefined
      ? parseAlpha(alphaPart)
      : parts.length > 3
        ? parseAlpha(parts[3])
        : 1;
    return {
      r: parseRgbComponent(parts[0]),
      g: parseRgbComponent(parts[1]),
      b: parseRgbComponent(parts[2]),
      a: alpha,
    };
  }
  const hslMatch = HSL_PATTERN.exec(text);
  if (hslMatch) {
    const body = hslMatch[1].trim();
    const [main, alphaPart] = body.includes('/') ? body.split('/') : [body, undefined];
    const parts = main.split(/[,\s]+/).filter((part) => part !== '');
    if (parts.length < 3) return null;
    const hue = Number.parseFloat(parts[0]);
    const sat = Number.parseFloat(parts[1]) / 100;
    const light = Number.parseFloat(parts[2]) / 100;
    if (![hue, sat, light].every((n) => Number.isFinite(n))) return null;
    const rgb = hslToRgb(hue, sat, light);
    const alpha = alphaPart !== undefined
      ? parseAlpha(alphaPart)
      : parts.length > 3
        ? parseAlpha(parts[3])
        : 1;
    return { ...rgb, a: alpha };
  }
  return null;
}

/** 归一化颜色的可读文本。 */
export function formatColor(color) {
  if (!color) return '';
  const { r, g, b, a } = color;
  if (a >= 1) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

function normalizeShadowText(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|hsla?\([^)]*\)/gi, (match) => {
      const color = normalizeColor(match);
      return color ? formatColor(color) : match;
    });
}

function normalizeFontText(value) {
  return String(value)
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter((part) => part !== '')
    .join(',');
}

function normalizeKeyword(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseLength(text) {
  const trimmed = String(text).trim();
  if (SHORTHAND_LENGTH_KEYWORDS.has(trimmed.toLowerCase())) {
    return { keyword: trimmed.toLowerCase() };
  }
  const match = /^(-?\d+(?:\.\d+)?)\s*(px|em|rem|%|vw|vh|vmin|vmax|ch|ex|pt)?$/i.exec(trimmed);
  if (!match) return null;
  return { value: Number.parseFloat(match[1]), unit: (match[2] ?? 'px').toLowerCase() };
}

function lengthToPx(length, pxPerRem = 16) {
  if (length.keyword) return null;
  if (length.unit === 'rem' || length.unit === 'em') return length.value * pxPerRem;
  return length.value;
}

/**
 * 比较单个属性。
 * @returns {{ pass: boolean, delta: number, deltaText: string, expectedText: string, actualText: string }}
 */
export function compareProperty(rule, expected, actual, tolerance = {}) {
  const isLengthKind = rule.kind === 'length' || rule.kind === 'lengthOrKeyword';
  const expectedText = typeof expected === 'number'
    ? isLengthKind ? `${expected}px` : String(expected)
    : String(expected);
  const actualText = actual === undefined || actual === null ? '' : String(actual);
  const lengthEps = typeof tolerance.length === 'number' ? tolerance.length : 0.5;
  const numberEps = typeof tolerance.number === 'number' ? tolerance.number : 0.01;
  const colorEps = typeof tolerance.color === 'number' ? tolerance.color : 0;

  if (rule.kind === 'color') {
    const expectedColor = normalizeColor(expectedText);
    const actualColor = normalizeColor(actualText);
    if (!expectedColor || !actualColor) {
      const pass = normalizeKeyword(expectedText) === normalizeKeyword(actualText);
      return {
        pass,
        delta: 0,
        deltaText: pass ? '' : '无法解析的色彩格式，按字符串比较',
        expectedText,
        actualText,
      };
    }
    const delta = Math.max(
      Math.abs(expectedColor.r - actualColor.r),
      Math.abs(expectedColor.g - actualColor.g),
      Math.abs(expectedColor.b - actualColor.b),
      Math.round(Math.abs(expectedColor.a - actualColor.a) * 255),
    );
    return {
      pass: delta <= colorEps,
      delta,
      deltaText: delta === 0 ? '' : `通道最大差 ${delta}`,
      expectedText,
      actualText,
    };
  }

  if (rule.kind === 'length' || rule.kind === 'lengthOrKeyword') {
    const expectedLength = parseLength(expectedText);
    const actualLength = parseLength(actualText);
    const treatAsKeyword = !expectedLength || (rule.kind === 'lengthOrKeyword' && expectedLength.keyword);
    if (treatAsKeyword || !actualLength) {
      const pass = normalizeKeyword(expectedText) === normalizeKeyword(actualText);
      return { pass, delta: 0, deltaText: pass ? '' : '值不同', expectedText, actualText };
    }
    if (expectedLength.keyword || actualLength.keyword) {
      const pass = expectedLength.keyword === actualLength.keyword;
      return {
        pass,
        delta: 0,
        deltaText: pass ? '' : `关键字不同：${actualLength.keyword ?? actualText}`,
        expectedText,
        actualText,
      };
    }
    if (expectedLength.unit !== 'px' || actualLength.unit !== 'px') {
      const expectedPx = lengthToPx(expectedLength);
      const actualPx = lengthToPx(actualLength);
      if (expectedLength.unit === actualLength.unit && expectedPx !== null && actualPx !== null) {
        const delta = round(actualPx - expectedPx);
        return {
          pass: Math.abs(delta) <= lengthEps,
          delta,
          deltaText: delta === 0 ? '' : `${delta > 0 ? '+' : ''}${delta}px`,
          expectedText,
          actualText,
        };
      }
      const pass = normalizeKeyword(expectedText) === normalizeKeyword(actualText);
      return { pass, delta: 0, deltaText: pass ? '' : '单位不同，按字符串比较', expectedText, actualText };
    }
    const delta = round(actualLength.value - expectedLength.value);
    return {
      pass: Math.abs(delta) <= lengthEps,
      delta,
      deltaText: delta === 0 ? '' : `${delta > 0 ? '+' : ''}${delta}px`,
      expectedText,
      actualText,
    };
  }

  if (rule.kind === 'number') {
    const expectedNumber = typeof expected === 'number' ? expected : Number.parseFloat(expectedText);
    const actualNumber = Number.parseFloat(actualText);
    if (!Number.isFinite(expectedNumber) || !Number.isFinite(actualNumber)) {
      const pass = normalizeKeyword(expectedText) === normalizeKeyword(actualText);
      return { pass, delta: 0, deltaText: pass ? '' : '值不同', expectedText, actualText };
    }
    const delta = round(actualNumber - expectedNumber, 4);
    return {
      pass: Math.abs(delta) <= numberEps,
      delta,
      deltaText: delta === 0 ? '' : `${delta > 0 ? '+' : ''}${delta}`,
      expectedText,
      actualText,
    };
  }

  if (rule.kind === 'shadow') {
    const pass = normalizeShadowText(expectedText) === normalizeShadowText(actualText);
    return { pass, delta: 0, deltaText: pass ? '' : '阴影参数不同', expectedText, actualText };
  }

  if (rule.kind === 'font') {
    const pass = normalizeFontText(expectedText) === normalizeFontText(actualText);
    return { pass, delta: 0, deltaText: pass ? '' : '字体族顺序不同', expectedText, actualText };
  }

  const pass = normalizeKeyword(expectedText) === normalizeKeyword(actualText);
  return { pass, delta: 0, deltaText: pass ? '' : '值不同', expectedText, actualText };
}

/** 给一次比较定严重度：pass | high | medium | low。 */
export function severityOf(property, rule, comparison) {
  if (comparison.pass) return 'pass';
  switch (rule.kind) {
    case 'color':
      return comparison.delta >= 32 ? 'high' : comparison.delta >= 8 ? 'medium' : 'low';
    case 'length':
    case 'lengthOrKeyword':
      if (comparison.delta === 0) return 'low';
      return Math.abs(comparison.delta) >= 8 ? 'high' : Math.abs(comparison.delta) >= 2 ? 'medium' : 'low';
    case 'number':
      return Math.abs(comparison.delta) >= 0.5 ? 'medium' : 'low';
    case 'keyword':
      return LAYOUT_KEYWORDS.has(property) ? 'high' : 'medium';
    case 'font':
      return 'medium';
    default:
      return 'medium';
  }
}

function nearestProperty(name) {
  let best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of PROPERTY_NAMES) {
    const distance = levenshtein(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= 3 ? best : undefined;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array(cols);
  let curr = new Array(cols);
  for (let col = 0; col < cols; col += 1) prev[col] = col;
  for (let row = 1; row < rows; row += 1) {
    curr[0] = row;
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      curr[col] = Math.min(prev[col] + 1, curr[col - 1] + 1, prev[col - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[cols - 1];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateValue(property, rule, value, path, issues) {
  if (rule.kind === 'color') {
    const normalized = typeof value === 'number' ? null : normalizeColor(String(value));
    if (!normalized) {
      issues.push(`${path}.${property} 不是可识别的颜色（支持 #hex / rgb() / rgba() / hsl()）：${JSON.stringify(value)}`);
    }
    return;
  }
  if (rule.kind === 'length') {
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && LENGTH_PATTERN.test(value.trim())) return;
    if (typeof value === 'string' && SHORTHAND_LENGTH_KEYWORDS.has(value.trim().toLowerCase())) return;
    issues.push(`${path}.${property} 期望长度（数字=px 或 12px/1rem 等），收到：${JSON.stringify(value)}`);
    return;
  }
  if (rule.kind === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && Number.isFinite(Number.parseFloat(value))) return;
    issues.push(`${path}.${property} 期望数字，收到：${JSON.stringify(value)}`);
    return;
  }
  if (rule.kind === 'lengthOrKeyword') {
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && (LENGTH_PATTERN.test(value.trim()) || SHORTHAND_LENGTH_KEYWORDS.has(value.trim().toLowerCase()))) return;
    issues.push(`${path}.${property} 期望长度或关键字，收到：${JSON.stringify(value)}`);
    return;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${path}.${property} 期望非空字符串，收到：${JSON.stringify(value)}`);
  }
}

function validateTolerance(raw, issues) {
  if (raw === undefined) return { length: 0.5, number: 0.01, color: 0 };
  if (!isPlainObject(raw)) {
    issues.push('tolerance 必须是对象，例如 { "length": 0.5, "number": 0.01, "color": 0 }');
    return { length: 0.5, number: 0.01, color: 0 };
  }
  const out = { length: 0.5, number: 0.01, color: 0 };
  for (const key of Object.keys(raw)) {
    if (!(key in out)) {
      issues.push(`tolerance.${key} 非法（允许 length / number / color）`);
      continue;
    }
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      issues.push(`tolerance.${key} 必须是非负数字，收到：${JSON.stringify(value)}`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * 校验并归一化 ui-spec；任何非法字段都会抛 UiSpecError。
 * @param {unknown} input
 * @returns {{ version: number, name: string, viewport?: object, tolerance: object, elements: object[], notes: string }}
 */
export function validateSpec(input) {
  const issues = [];
  if (!isPlainObject(input)) throw new UiSpecError(['ui-spec 根节点必须是 JSON 对象']);
  for (const key of Object.keys(input)) {
    if (!SPEC_KEYS.includes(key)) {
      issues.push(`未知字段：${key}（允许：${SPEC_KEYS.join(' / ')}）`);
    }
  }

  let version = SPEC_VERSION;
  if (input.version !== undefined) {
    if (input.version !== SPEC_VERSION) {
      issues.push(`version 只支持 ${SPEC_VERSION}，收到：${JSON.stringify(input.version)}`);
    } else {
      version = input.version;
    }
  }

  const name = input.name === undefined ? '' : String(input.name);
  const notes = input.notes === undefined ? '' : String(input.notes);

  let viewport;
  if (input.viewport !== undefined) {
    if (!isPlainObject(input.viewport)) {
      issues.push('viewport 必须是对象 { width, height, dpr? }');
    } else {
      for (const key of Object.keys(input.viewport)) {
        if (!['width', 'height', 'dpr'].includes(key)) issues.push(`viewport.${key} 非法（允许 width / height / dpr）`);
      }
      const width = input.viewport.width;
      const height = input.viewport.height;
      if (typeof width !== 'number' || width <= 0) issues.push('viewport.width 必须是正数');
      if (typeof height !== 'number' || height <= 0) issues.push('viewport.height 必须是正数');
      if (input.viewport.dpr !== undefined && (typeof input.viewport.dpr !== 'number' || input.viewport.dpr <= 0)) {
        issues.push('viewport.dpr 必须是正数');
      }
      viewport = {
        width: typeof width === 'number' && width > 0 ? width : 1440,
        height: typeof height === 'number' && height > 0 ? height : 900,
        dpr: typeof input.viewport.dpr === 'number' && input.viewport.dpr > 0 ? input.viewport.dpr : 1,
      };
    }
  }

  const tolerance = validateTolerance(input.tolerance, issues);

  const elements = [];
  if (!Array.isArray(input.elements) || input.elements.length === 0) {
    issues.push('elements 必须是非空数组');
  } else {
    input.elements.forEach((element, index) => {
      const path = `elements[${index}]`;
      if (!isPlainObject(element)) {
        issues.push(`${path} 必须是对象 { selector, properties }`);
        return;
      }
      for (const key of Object.keys(element)) {
        if (!['selector', 'properties', 'label', 'note'].includes(key)) {
          issues.push(`${path}.${key} 非法（允许 selector / properties / label / note）`);
        }
      }
      const selector = element.selector;
      if (typeof selector !== 'string' || selector.trim() === '') {
        issues.push(`${path}.selector 必须是非空 CSS 选择器字符串`);
        return;
      }
      if (!isPlainObject(element.properties) || Object.keys(element.properties).length === 0) {
        issues.push(`${path}.properties 必须是非空对象`);
        return;
      }
      const properties = {};
      for (const [property, value] of Object.entries(element.properties)) {
        const rule = PROPERTY_RULES[property];
        if (!rule) {
          const hint = nearestProperty(property);
          issues.push(
            `${path}.properties.${property} 不是受支持的属性${hint ? `（是否想写 ${hint}？）` : ''}；`
            + `完整列表见 schemas/ui-spec.schema.json`,
          );
          continue;
        }
        validateValue(property, rule, value, `${path}.properties`, issues);
        properties[property] = value;
      }
      elements.push({
        selector,
        label: element.label === undefined ? '' : String(element.label),
        note: element.note === undefined ? '' : String(element.note),
        properties,
      });
    });
  }

  if (issues.length > 0) throw new UiSpecError(issues);
  return { version, name, viewport, tolerance, elements, notes };
}

/**
 * 解析 ui-spec 来源，返回 `{ spec, sourcePath }`。
 *
 * 来源路径必须由调用方作为独立元数据持有，**不能写回 spec 本体**：spec 顶层字段
 * 白名单不接受 `path`，写回去会让二次校验把内部字段当成未知字段拒掉。
 *
 * @param {string|object} source 对象、JSON 字符串或 JSON 文件路径
 * @param {{ cwd?: string }} [options]
 * @returns {{ spec: object, sourcePath: string }}
 */
export function readSpecSource(source, { cwd } = {}) {
  if (isPlainObject(source)) return { spec: validateSpec(source), sourcePath: '' };
  if (typeof source !== 'string' || source.trim() === '') {
    throw new UiSpecError(['expected 必须是 ui-spec 对象或 JSON 文件路径']);
  }
  const text = source.trim();
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new UiSpecError([`expected JSON 解析失败：${error.message}`]);
    }
    return { spec: validateSpec(parsed), sourcePath: '' };
  }
  const file = resolveWorkspacePath(cwd, text);
  return { spec: validateSpec(readJsonFile(file, 'ui-spec')), sourcePath: file };
}

/**
 * 兼容入口：只返回校验后的 spec，不携带来源路径。
 * 需要来源路径时用 `readSpecSource`。
 * @param {string|object} source
 * @param {{ cwd?: string }} [options]
 */
export function parseSpecSource(source, { cwd } = {}) {
  return readSpecSource(source, { cwd }).spec;
}

/**
 * 按 ui-spec 对比某个元素的实际计算样式。
 * @param {{ selector: string, label?: string, properties: Record<string, unknown> }} element
 * @param {Record<string, string>} actualStyles
 * @param {{ length?: number, number?: number, color?: number }} tolerance
 */
export function compareElementStyles(element, actualStyles, tolerance = {}) {
  const checks = [];
  for (const [property, expected] of Object.entries(element.properties)) {
    const rule = PROPERTY_RULES[property];
    const actual = actualStyles ? actualStyles[property] : undefined;
    const comparison = compareProperty(rule, expected, actual, tolerance);
    checks.push({
      selector: element.selector,
      label: element.label ?? '',
      property,
      expected: comparison.expectedText,
      actual: comparison.actualText,
      delta: comparison.delta,
      deltaText: comparison.deltaText,
      severity: severityOf(property, rule, comparison),
      pass: comparison.pass,
    });
  }
  return checks;
}

/** 汇总一组检查。 */
export function summarizeChecks(checks) {
  const summary = { total: checks.length, passed: 0, failed: 0, high: 0, medium: 0, low: 0 };
  for (const check of checks) {
    if (check.pass) summary.passed += 1;
    else {
      summary.failed += 1;
      if (check.severity === 'high') summary.high += 1;
      else if (check.severity === 'medium') summary.medium += 1;
      else summary.low += 1;
    }
  }
  return summary;
}
