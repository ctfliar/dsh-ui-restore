/**
 * dsh-ui-restore · 样式探针
 *
 * 两种模式：
 * 1. 无 expected（审计）：横向溢出、硬编码颜色、字号/间距分布、图片缺 alt、
 *    缺可见焦点、可疑空态。
 * 2. 有 expected（ui-spec 契约）：逐元素逐属性对比 getComputedStyle，输出
 *    { property, expected, actual, delta, severity }。非法字段直接报错。
 *
 * 页面内的采集函数必须自包含（page.evaluate 只传函数体，不共享模块作用域）。
 *
 * @module dsh-ui-restore/probe
 */
import { normalizeTarget, openTarget, withPage } from './browser.js';
import { compareElementStyles, readSpecSource, summarizeChecks } from './spec.js';

/**
 * 页面内采集：结构、溢出、颜色与字号分布、无 alt、焦点、空态。
 * @param {{ scope?: string, limit?: number }} options
 */
function pageAudit(options) {
  // 注意：本函数会被 page.evaluate 序列化后在页面里执行，不能引用模块作用域变量，
  // 所有常量必须写在函数体内。
  const MAX_ELEMENTS = 5000;
  const limit = options && Number.isFinite(options.limit) ? options.limit : 20;
  const scopeSelector = options && typeof options.scope === 'string' ? options.scope : '';
  const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
  if (!root) return { error: `scope 没有匹配元素：${scopeSelector}` };

  const cssPath = (element) => {
    if (!element || element.nodeType !== 1) return '';
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let selector = node.tagName.toLowerCase();
      const classes = Array.from(node.classList).filter((name) => !name.startsWith('__')).slice(0, 2);
      if (classes.length > 0) selector += `.${classes.map((name) => CSS.escape(name)).join('.')}`;
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (sameTag.length > 1) selector += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(selector);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  // selector 只在真的记录问题时才计算（惰性 getter）：
  // 大页面（数千元素）里 cssPath 的 nth-of-type 扫描是 O(E×S)，无条件计算会让审计探针从毫秒级涨到秒级。
  const describe = (element) => ({
    get selector() { return cssPath(element); },
    tag: element.tagName.toLowerCase(),
    text: (element.innerText || element.textContent || '').trim().slice(0, 40),
  });

  const styleOf = (element) => window.getComputedStyle(element);
  const isVisible = (element, style) => {
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const elements = root === document.body ? [] : [root];
  let current = walker.nextNode();
  while (current && elements.length < MAX_ELEMENTS) {
    elements.push(current);
    current = walker.nextNode();
  }

  const overflow = [];
  const outsideViewport = [];
  const imagesWithoutAlt = [];
  const focusRisks = [];
  const emptyStates = [];
  const hardcodedColors = [];
  const palette = new Map();
  const fontSizes = new Map();
  const spacing = new Map();
  const emptySeen = new Set();

  const bump = (map, key) => {
    if (!key || key === 'rgba(0, 0, 0, 0)' || key === 'transparent') return;
    map.set(key, (map.get(key) || 0) + 1);
  };

  const interactiveSelector = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="tab"]';

  for (const element of elements) {
    const style = styleOf(element);
    if (!isVisible(element, style)) continue;
    const rect = element.getBoundingClientRect();
    const description = describe(element);

    if (rect.right > window.innerWidth + 1 || rect.left < -1) {
      if (outsideViewport.length < limit) {
        outsideViewport.push({
          ...description,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          viewportWidth: window.innerWidth,
        });
      }
    }

    const overflowX = element.scrollWidth - element.clientWidth;
    const overflowY = element.scrollHeight - element.clientHeight;
    if (overflowX > 1 || overflowY > 1) {
      if (overflow.length < limit) {
        overflow.push({
          ...description,
          axis: overflowX > 1 ? 'x' : 'y',
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          overflowX,
          overflowY,
        });
      }
    }

    const inline = element.getAttribute('style');
    if (inline && /(?:^|;)\s*(?:color|background|background-color|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color)\s*:[^;]*(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(inline)) {
      if (hardcodedColors.length < limit) {
        hardcodedColors.push({ ...description, inline: inline.trim().slice(0, 120) });
      }
    }

    bump(palette, style.color);
    bump(palette, style.backgroundColor);
    bump(fontSizes, style.fontSize);
    for (const property of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'gap']) {
      const value = style[property];
      if (value && value !== '0px' && value !== 'normal' && value !== 'auto') bump(spacing, value);
    }

    if (element.tagName === 'IMG') {
      const alt = element.getAttribute('alt');
      const decorative = element.getAttribute('aria-hidden') === 'true' || element.getAttribute('role') === 'presentation';
      if ((alt === null || alt.trim() === '') && !decorative) {
        if (imagesWithoutAlt.length < limit) {
          imagesWithoutAlt.push({ ...description, src: String(element.getAttribute('src') || '').slice(0, 120) });
        }
      }
    }

    if (element.matches(interactiveSelector)) {
      const outlineNone = style.outlineStyle === 'none' || style.outlineWidth === '0px' || style.outlineColor === 'rgba(0, 0, 0, 0)';
      const hasShadow = style.boxShadow && style.boxShadow !== 'none';
      if (outlineNone && !hasShadow) {
        if (focusRisks.length < limit) {
          focusRisks.push({ ...description, outline: `${style.outlineStyle} ${style.outlineWidth}`, boxShadow: style.boxShadow || 'none' });
        }
      }
    }

    const area = rect.width * rect.height;
    const tags = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'UL', 'OL', 'TABLE', 'TBODY', 'TR', 'TD']);
    if (tags.has(element.tagName) && area > 5000 && (element.textContent || '').trim() === '') {
      const hasMedia = element.querySelector('img, svg, canvas, video, input, button, select, textarea, [role], template');
      const hidden = element.matches('[aria-hidden="true"], script, style, noscript, template');
      let ancestorSeen = false;
      let parent = element.parentElement;
      while (parent) {
        if (emptySeen.has(parent)) {
          ancestorSeen = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!hasMedia && !hidden && !ancestorSeen) {
        emptySeen.add(element);
        if (emptyStates.length < limit) {
          emptyStates.push({
            ...description,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            area: Math.round(area),
          });
        }
      }
    }
  }

  const topEntries = (map, count = 12) => Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([value, occurrences]) => ({ value, count: occurrences }));

  return {
    title: document.title,
    url: location.href,
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    },
    elementsScanned: elements.length,
    truncated: elements.length >= MAX_ELEMENTS,
    overflow,
    outsideViewport,
    palette: topEntries(palette),
    fontSizes: topEntries(fontSizes),
    spacing: topEntries(spacing),
    hardcodedColors,
    imagesWithoutAlt,
    focusRisks,
    emptyStates,
  };
}

/**
 * 页面内采集：按 ui-spec 读取指定元素的计算样式。
 * @param {{ selector: string, properties: string[] }[]} entries
 */
function pageReadStyles(entries) {
  const readOne = (entry) => {
    let element = null;
    try {
      element = document.querySelector(entry.selector);
    } catch {
      return { selector: entry.selector, found: false, invalid: true, styles: {} };
    }
    if (!element) return { selector: entry.selector, found: false, styles: {} };
    const style = window.getComputedStyle(element);
    const styles = {};
    for (const property of entry.properties) styles[property] = style[property] ?? '';
    const rect = element.getBoundingClientRect();
    return {
      selector: entry.selector,
      found: true,
      styles,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  };
  return {
    title: document.title,
    url: location.href,
    entries: entries.map(readOne),
  };
}

function roundViewport(width, height, dpr) {
  return {
    width: Math.round(width),
    height: Math.round(height),
    dpr,
  };
}

/**
 * 审计模式探针（无 expected）。
 */
export async function runAudit(options) {
  const { config = {}, cwd, url, width, height, dpr = 1, selector, waitMs, limit } = options;
  const target = normalizeTarget(url, cwd);
  const raw = await withPage(config, { width, height, dpr }, async (page) => {
    await openTarget(page, target, config, waitMs);
    return page.evaluate(pageAudit, { scope: selector ?? '', limit: limit ?? 20 });
  }, { launcher: options.launcher });
  return buildAuditResult(raw, { width, height, dpr });
}

/**
 * 把页面内采集结果转成审计结论（纯函数，便于在无浏览器环境验证）。
 * @param {object} raw pageAudit 的返回值
 * @param {{ width: number, height: number, dpr?: number }} viewport
 */
export function buildAuditResult(raw, viewport) {
  if (raw.error) throw new Error(raw.error);
  const dpr = viewport.dpr ?? 1;

  const issues = [];
  const push = (issue) => issues.push(issue);

  if (raw.viewport.horizontalScroll) {
    push({
      kind: 'overflow',
      severity: 'high',
      selector: 'html',
      detail: `页面出现横向滚动：scrollWidth ${raw.viewport.scrollWidth} > innerWidth ${raw.viewport.innerWidth}`,
    });
  }
  for (const item of raw.outsideViewport) {
    const exceeded = Math.max(0, item.right - item.viewportWidth, -item.left);
    push({
      kind: 'overflow',
      severity: exceeded > 8 ? 'high' : 'medium',
      selector: item.selector,
      detail: `元素越出视口 ${Math.round(exceeded)}px（left ${item.left}, right ${item.right}, viewport ${item.viewportWidth}）`,
    });
  }
  for (const item of raw.overflow) {
    const exceeded = Math.max(item.overflowX, item.overflowY);
    push({
      kind: 'overflow',
      severity: exceeded > 8 ? 'high' : 'medium',
      selector: item.selector,
      detail: `内容在 ${item.axis} 轴溢出 ${exceeded}px（scroll ${item.scrollWidth}x${item.scrollHeight} > client ${item.clientWidth}x${item.clientHeight}）`,
    });
  }
  for (const item of raw.imagesWithoutAlt) {
    push({ kind: 'alt', severity: 'medium', selector: item.selector, detail: `图片缺少 alt：${item.src}` });
  }
  for (const item of raw.focusRisks) {
    push({ kind: 'focus', severity: 'low', selector: item.selector, detail: `可交互元素没有可见焦点样式（outline ${item.outline}, box-shadow ${item.boxShadow}）` });
  }
  for (const item of raw.emptyStates) {
    push({ kind: 'empty', severity: 'low', selector: item.selector, detail: `大块空白容器（${item.width}x${item.height}）没有文本或空态提示` });
  }
  for (const item of raw.hardcodedColors) {
    push({ kind: 'hardcoded', severity: 'low', selector: item.selector, detail: `内联硬编码颜色：${item.inline}` });
  }

  return {
    mode: 'audit',
    url: raw.url,
    title: raw.title,
    viewport: roundViewport(viewport.width, viewport.height, dpr),
    audit: {
      elementsScanned: raw.elementsScanned,
      truncated: raw.truncated,
      palette: raw.palette,
      fontSizes: raw.fontSizes,
      spacing: raw.spacing,
      imagesWithoutAlt: raw.imagesWithoutAlt.length,
      focusRisks: raw.focusRisks.length,
      emptyStates: raw.emptyStates.length,
      hardcodedColors: raw.hardcodedColors.length,
      overflow: raw.overflow.length + raw.outsideViewport.length,
      horizontalScroll: raw.viewport.horizontalScroll,
    },
    issues,
    summary: summarizeIssues(issues),
  };
}

/**
 * 契约模式探针（有 expected）。
 */
export async function runSpecProbe(options) {
  const {
    config = {},
    cwd,
    url,
    expected,
    spec: providedSpec,
    specPath = '',
    width,
    height,
    dpr = 1,
    waitMs,
  } = options;
  // 工具入口已经解析过的 spec 直接复用，避免二次 parse + 校验把内部元数据当未知字段。
  const { spec, sourcePath } = providedSpec
    ? { spec: providedSpec, sourcePath: specPath }
    : readSpecSource(expected, { cwd });
  const viewportWidth = Number.isFinite(width) ? width : spec.viewport?.width ?? 1440;
  const viewportHeight = Number.isFinite(height) ? height : spec.viewport?.height ?? 900;
  const viewportDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : spec.viewport?.dpr ?? 1;
  const target = normalizeTarget(url, cwd);
  const entries = spec.elements.map((element) => ({
    selector: element.selector,
    properties: Object.keys(element.properties),
  }));

  const raw = await withPage(config, { width: viewportWidth, height: viewportHeight, dpr: viewportDpr }, async (page) => {
    await openTarget(page, target, config, waitMs);
    return page.evaluate(pageReadStyles, entries);
  }, { launcher: options.launcher });

  return buildSpecResult(raw, spec, { width: viewportWidth, height: viewportHeight, dpr: viewportDpr }, sourcePath);
}

/**
 * 把页面内采集的计算样式转成契约结论（纯函数）。
 * @param {object} raw pageReadStyles 的返回值
 * @param {object} spec 已校验的 ui-spec
 * @param {{ width: number, height: number, dpr?: number }} viewport
 * @param {string} [sourcePath] ui-spec 来源文件路径（仅作报告元数据，不进入 spec 校验）
 */
export function buildSpecResult(raw, spec, viewport, sourcePath = '') {
  const dpr = viewport.dpr ?? 1;
  const checks = [];
  const selectorMisses = [];
  const rects = {};
  const entries = raw.entries ?? [];
  entries.forEach((result, index) => {
    const element = spec.elements[index];
    if (!element) return;
    if (!result.found) {
      selectorMisses.push({
        selector: element.selector,
        label: element.label ?? '',
        invalid: result.invalid === true,
      });
      return;
    }
    rects[element.selector] = result.rect;
    checks.push(...compareElementStyles(element, result.styles, spec.tolerance));
  });

  return {
    mode: 'spec',
    url: raw.url,
    title: raw.title,
    viewport: roundViewport(viewport.width, viewport.height, dpr),
    spec: {
      name: spec.name ?? '',
      path: sourcePath,
      elements: spec.elements.length,
      tolerance: spec.tolerance,
    },
    checks,
    selectorMisses,
    rects,
    summary: {
      ...summarizeChecks(checks),
      selectorMisses: selectorMisses.length,
    },
  };
}

/** 把审计问题汇总成计数。 */
export function summarizeIssues(issues) {
  const summary = { total: issues.length, high: 0, medium: 0, low: 0 };
  for (const issue of issues) {
    if (issue.severity === 'high') summary.high += 1;
    else if (issue.severity === 'medium') summary.medium += 1;
    else summary.low += 1;
  }
  return summary;
}

/** 统一入口：有 spec/expected 走契约模式，否则走审计模式。 */
export async function runProbe(options) {
  const hasSpec = options.spec !== undefined && options.spec !== null;
  const hasExpected = options.expected !== undefined && options.expected !== null && options.expected !== '';
  if (hasSpec || hasExpected) {
    return runSpecProbe(options);
  }
  if (!Number.isFinite(options.width) || !Number.isFinite(options.height)) {
    throw new Error('审计模式需要 width/height（可从档案 devices[0] 取值）');
  }
  return runAudit(options);
}

/** 页面采集函数的语法自检（供 selftest 在无浏览器环境校验）。 */
export function auditExpressionSource() {
  return [pageAudit.toString(), pageReadStyles.toString()];
}
