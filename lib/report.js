/**
 * dsh-ui-restore · 验收报告（Markdown + 单文件 HTML）
 *
 * 报告只消费本地文件：
 * - run 目录（meta.json + 约定命名的 PNG / diff.json / probe.json）
 * - 或本次各工具产物路径
 *
 * HTML 是单文件静态页：没有 <script>、没有外链、没有 CDN、没有 base64 大图；
 * 三张图用同目录相对路径引用。表格在生成阶段按严重度排序（静态可排序），
 * 页面本体可由鼠标双击直接打开，窗口变窄时自适应。
 *
 * @module dsh-ui-restore/report
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DEFAULT_RUN_ROOT,
  PACKAGE,
  PLUGIN_ROOT,
  TOOL_NAME,
  TOOL_VERSION,
  ensureDir,
  materializeImage,
  mergeMeta,
  readJsonFile,
  readMeta,
  relOrAbs,
  resolveWorkspacePath,
  stamp,
} from './paths.js';
import { readPngSize } from './diff.js';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, pass: 3 };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 读取报告文案（zh 默认，en 备用）；文件缺失时用 zh 的兜底常量。 */
export function loadLocale(locale = 'zh') {
  const file = join(PLUGIN_ROOT, 'locale', `${locale}.json`);
  const fallback = join(PLUGIN_ROOT, 'locale', 'zh.json');
  for (const candidate of [file, fallback]) {
    if (existsSync(candidate)) {
      try {
        return readJsonFile(candidate, '报告文案');
      } catch {
        // 落到下一个候选
      }
    }
  }
  return { title: 'UI 还原验收报告', labels: {}, nav: {}, severity: {}, mode: {}, fixHints: {}, footer: '' };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeMd(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** 极简模板填充：{key} → 值，未知占位符原样保留。 */
function fillTemplate(template, values = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** 显式 mode 与档案设计源冲突时的提示（zh 兜底，可由 locale 覆盖）。 */
const MODE_CONFLICT_TEMPLATE = 'ui_report 收到 mode={requested}，与档案 designSource={kind} 冲突；已按档案记为 {effective}。';

function fmt(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  if (Number.isInteger(number)) return String(number);
  return String(Number(number.toFixed(digits)));
}

function pct(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function timestampText(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function severityRank(severity) {
  return SEVERITY_ORDER[severity] ?? 9;
}

function sortChecks(checks) {
  return [...checks].sort((a, b) => {
    const rank = severityRank(a.severity) - severityRank(b.severity);
    if (rank !== 0) return rank;
    return Math.abs(Number(b.delta) || 0) - Math.abs(Number(a.delta) || 0);
  });
}

function sortIssues(issues) {
  return [...issues].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

function scoreTone(score, threshold) {
  if (!Number.isFinite(Number(score))) return 'unknown';
  if (Number(score) >= Number(threshold)) return 'good';
  if (Number(score) >= Number(threshold) - 0.05) return 'warn';
  return 'bad';
}

function readJsonIfExists(file, label) {
  if (!file || !existsSync(file)) return undefined;
  return readJsonFile(file, label);
}

/** 从 run 目录里按约定找产物。 */
function discoverRunArtifacts(runDir, meta) {
  const find = (...names) => {
    for (const name of names) {
      const file = join(runDir, name);
      if (existsSync(file)) return file;
    }
    return undefined;
  };
  const fromMeta = (key) => {
    const value = meta.artifacts?.[key];
    if (typeof value !== 'string' || value === '') return undefined;
    const file = resolve(runDir, value);
    return existsSync(file) ? file : undefined;
  };
  return {
    design: fromMeta('design') ?? find('design.png', 'design.jpg', 'design.jpeg'),
    shot: fromMeta('shot') ?? find('shot.png', 'shot.jpg', 'shot.jpeg'),
    diff: fromMeta('diff') ?? find('diff.png'),
    sideBySide: fromMeta('sideBySide') ?? find('side-by-side.png'),
    diffJson: fromMeta('diffJson') ?? find('diff.json'),
    probeJson: fromMeta('probeJson') ?? find('probe.json'),
  };
}

/**
 * 生成修复清单：差异区域 + 属性差异 + 审计问题，按优先级排序。
 */
export function buildFixList(model, locale) {
  const hints = locale.fixHints ?? {};
  const fixes = [];
  const checks = sortChecks((model.probe?.checks ?? []).filter((check) => !check.pass));
  for (const check of checks) {
    if (check.severity === 'low' && fixes.length >= 12) continue;
    const ruleKind = guessRuleKind(check.property);
    fixes.push({
      priority: check.severity,
      source: 'ui_probe',
      target: `${check.selector} · ${check.property}`,
      action: `${hints[ruleKind] ?? hints.region ?? ''} 期望 ${check.expected}，实际 ${check.actual}${check.deltaText ? `（${check.deltaText}）` : ''}`.trim(),
    });
  }
  const regionList = [...(model.regions ?? [])].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.pixels - a.pixels,
  );
  const regionLimit = 5;
  for (const region of regionList.slice(0, regionLimit)) {
    fixes.push({
      priority: region.severity,
      source: 'ui_diff',
      target: `区域 #${region.index}（${region.x},${region.y} ${region.width}x${region.height}）`,
      action: `${hints.region ?? ''} 该区域差异 ${region.pixels} px（占比 ${pct(region.ratio)}）。`.trim(),
    });
  }
  if (regionList.length > regionLimit) {
    fixes.push({
      priority: 'low',
      source: 'ui_diff',
      target: `其余 ${regionList.length - regionLimit} 个区域`,
      action: '面积较小的区域先按区域表核对；若差异呈整体位移，优先修布局根因，不要逐块硬调。',
    });
  }
  const issueList = sortIssues(model.probe?.issues ?? []);
  for (const issue of issueList.slice(0, 10)) {
    fixes.push({
      priority: issue.severity,
      source: 'ui_probe',
      target: issue.selector,
      action: `${hints[issue.kind] ?? ''} ${issue.detail}`.trim(),
    });
  }
  if (issueList.length > 10) {
    fixes.push({
      priority: 'low',
      source: 'ui_probe',
      target: `其余 ${issueList.length - 10} 条探测发现`,
      action: '按「探测发现」表逐项处理，优先高严重度。',
    });
  }
  return fixes.slice(0, 24);
}

const LENGTH_LIKE = new Set([
  'fontSize', 'lineHeight', 'letterSpacing', 'width', 'height', 'minWidth', 'minHeight',
  'maxWidth', 'maxHeight', 'gap', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'borderRadius', 'borderTopLeftRadius',
  'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius', 'borderTopWidth',
  'borderLeftWidth', 'verticalAlign',
]);
const COLOR_LIKE = new Set(['color', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor']);

function guessRuleKind(property) {
  if (COLOR_LIKE.has(property)) return 'color';
  if (LENGTH_LIKE.has(property)) return 'length';
  if (property === 'boxShadow' || property === 'textShadow') return 'shadow';
  if (property === 'fontFamily') return 'font';
  if (property === 'opacity' || property === 'fontWeight' || property === 'zIndex') return 'number';
  return 'keyword';
}

/** 内联 SVG 分数曲线（不依赖 JS 与外部资源）。 */
export function renderScoreChart(history, threshold, locale) {
  const points = (history ?? [])
    .map((entry, index) => ({ round: Number.isFinite(entry.round) ? entry.round : index + 1, score: Number(entry.score) }))
    .filter((entry) => Number.isFinite(entry.score));
  const width = 760;
  const height = 240;
  const padding = { top: 24, right: 28, bottom: 40, left: 56 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  if (points.length === 0) {
    return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(locale.labels?.score ?? 'score')}">
  <text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="chart-empty">${escapeHtml(locale.labels?.empty ?? 'no data')}</text>
</svg>`;
  }

  const values = points.map((point) => point.score);
  const low = Math.max(0, Math.min(...values, threshold) - 0.03);
  const high = 1;
  const span = Math.max(0.02, high - low);
  const xFor = (index) => (points.length === 1 ? padding.left + innerWidth / 2 : padding.left + (innerWidth * index) / (points.length - 1));
  const yFor = (value) => padding.top + innerHeight - ((Math.max(low, Math.min(high, value)) - low) / span) * innerHeight;

  const polyline = points.map((point, index) => `${xFor(index).toFixed(1)},${yFor(point.score).toFixed(1)}`).join(' ');
  const dots = points.map((point, index) => {
    const x = xFor(index).toFixed(1);
    const y = yFor(point.score).toFixed(1);
    const tone = scoreTone(point.score, threshold);
    return `<g><circle cx="${x}" cy="${y}" r="4" class="dot ${tone}"/><text x="${x}" y="${Number(y) - 10}" text-anchor="middle" class="dot-label">${fmt(point.score, 3)}</text><text x="${x}" y="${height - 14}" text-anchor="middle" class="axis-label">R${point.round}</text></g>`;
  }).join('');
  const thresholdY = yFor(threshold);
  const ticks = [low, (low + high) / 2, high].map((value) => {
    const y = yFor(value).toFixed(1);
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="grid"/><text x="${padding.left - 10}" y="${Number(y) + 4}" text-anchor="end" class="axis-label">${(value * 100).toFixed(0)}%</text>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(locale.labels?.score ?? 'score')}">
  ${ticks}
  <line x1="${padding.left}" y1="${thresholdY.toFixed(1)}" x2="${width - padding.right}" y2="${thresholdY.toFixed(1)}" class="threshold"/>
  <text x="${width - padding.right}" y="${(thresholdY - 6).toFixed(1)}" text-anchor="end" class="threshold-label">${escapeHtml(locale.labels?.threshold ?? 'pass line')} ${pct(threshold)}</text>
  <polyline points="${polyline}" class="line"/>
  ${dots}
</svg>`;
}

function severityBadge(severity, locale) {
  const text = locale.severity?.[severity] ?? severity;
  return `<span class="badge sev-${escapeHtml(severity)}">${escapeHtml(text)}</span>`;
}

function imagePanel(title, file, meta, emptyText) {
  if (!file) {
    return `<figure class="panel"><figcaption>${escapeHtml(title)}<span class="muted">${escapeHtml(emptyText)}</span></figcaption><div class="placeholder">${escapeHtml(emptyText)}</div></figure>`;
  }
  const dimension = meta ? `${meta.width ?? ''}×${meta.height ?? ''}` : '';
  return `<figure class="panel">
  <figcaption>${escapeHtml(title)}<span class="muted">${escapeHtml(dimension)} · ${escapeHtml(file)}</span></figcaption>
  <a href="${escapeHtml(file)}" title="${escapeHtml(file)}"><img src="${escapeHtml(file)}" alt="${escapeHtml(title)}" /></a>
</figure>`;
}

function renderRegionsTable(regions, locale) {
  const labels = locale.labels ?? {};
  if (!regions || regions.length === 0) {
    return `<p class="muted">${escapeHtml(labels.empty ?? 'no data')}</p>`;
  }
  const rows = [...regions]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.pixels - a.pixels)
    .map((region) => `<tr data-severity="${escapeHtml(region.severity)}">
      <td>#${region.index}</td>
      <td>${region.x}, ${region.y}</td>
      <td>${region.width}×${region.height}</td>
      <td>${region.pixels}</td>
      <td>${pct(region.ratio)}</td>
      <td>${severityBadge(region.severity, locale)}</td>
    </tr>`)
    .join('');
  return `<table class="data sortable" data-sort="severity">
  <thead><tr><th data-sort-key="index">${escapeHtml(labels.id ?? '#')}</th><th data-sort-key="x">${escapeHtml(labels.regions ?? 'Region')} X,Y</th><th data-sort-key="size">${escapeHtml(labels.width ?? 'W')}×${escapeHtml(labels.height ?? 'H')}</th><th data-sort-key="pixels">${escapeHtml(labels.pixels ?? 'Pixels')}</th><th data-sort-key="ratio">${escapeHtml(labels.area ?? 'Share')}</th><th data-sort-key="severity">${escapeHtml(labels.severity ?? 'Severity')}</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderChecksTable(checks, locale) {
  const labels = locale.labels ?? {};
  const list = sortChecks(checks ?? []);
  if (list.length === 0) return `<p class="muted">${escapeHtml(labels.empty ?? 'no data')}</p>`;
  const rows = list.map((check) => `<tr class="${check.pass ? 'pass-row' : 'fail-row'}" data-severity="${escapeHtml(check.severity)}">
      <td><code>${escapeHtml(check.selector)}</code>${check.label ? `<span class="muted"> ${escapeHtml(check.label)}</span>` : ''}</td>
      <td><code>${escapeHtml(check.property)}</code></td>
      <td>${escapeHtml(check.expected)}</td>
      <td>${escapeHtml(check.actual === '' ? '（空）' : check.actual)}</td>
      <td>${escapeHtml(check.deltaText || (check.delta ? String(check.delta) : '—'))}</td>
      <td>${check.pass ? `<span class="badge pass">${escapeHtml(labels.pass ?? 'pass')}</span>` : severityBadge(check.severity, locale)}</td>
    </tr>`).join('');
  return `<table class="data sortable" data-sort="severity">
  <thead><tr><th data-sort-key="selector">${escapeHtml(labels.selector ?? 'Selector')}</th><th data-sort-key="property">${escapeHtml(labels.property ?? 'Property')}</th><th data-sort-key="expected">${escapeHtml(labels.expected ?? 'Expected')}</th><th data-sort-key="actual">${escapeHtml(labels.actual ?? 'Actual')}</th><th data-sort-key="delta">${escapeHtml(labels.delta ?? 'Delta')}</th><th data-sort-key="severity">${escapeHtml(labels.result ?? 'Result')}</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function distributionRow(title, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const text = entries.slice(0, 8).map((entry) => `${entry.value}×${entry.count}`).join(' · ');
  return `<div class="fixture-row"><dt>${escapeHtml(title)}</dt><dd>${escapeHtml(text)}</dd></div>`;
}

function renderIssuesTable(issues, locale) {
  const labels = locale.labels ?? {};
  const list = sortIssues(issues ?? []);
  if (list.length === 0) return `<p class="muted">${escapeHtml(labels.empty ?? 'no data')}</p>`;
  const rows = list.map((issue) => `<tr data-severity="${escapeHtml(issue.severity)}">
      <td>${escapeHtml(issue.kind)}</td>
      <td><code>${escapeHtml(issue.selector)}</code></td>
      <td>${escapeHtml(issue.detail)}</td>
      <td>${severityBadge(issue.severity, locale)}</td>
    </tr>`).join('');
  return `<table class="data sortable" data-sort="severity">
  <thead><tr><th data-sort-key="kind">${escapeHtml(labels.kind ?? 'Kind')}</th><th data-sort-key="selector">${escapeHtml(labels.selector ?? 'Selector')}</th><th data-sort-key="detail">${escapeHtml(labels.detail ?? 'Detail')}</th><th data-sort-key="severity">${escapeHtml(labels.severity ?? 'Severity')}</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderFixes(fixes, locale) {  if (!fixes || fixes.length === 0) return `<p class="muted">${escapeHtml(locale.labels?.empty ?? 'no data')}</p>`;
  const items = fixes.map((fix) => `<li>
    ${severityBadge(fix.priority, locale)}
    <strong>${escapeHtml(fix.target)}</strong>
    <span class="muted">[${escapeHtml(fix.source)}]</span>
    <div>${escapeHtml(fix.action)}</div>
  </li>`).join('');
  return `<ol class="fixes">${items}</ol>`;
}

function renderFixture(model, locale) {
  const labels = locale.labels ?? {};
  const profile = model.profile ?? {};
  const designSource = profile.designSource ?? { kind: 'none' };
  const designRef = [designSource.mcpServer, designSource.artboard, designSource.path, designSource.note]
    .filter((value) => typeof value === 'string' && value !== '')
    .join(' · ');
  const rows = [
    [labels.tool ?? 'Tool', `${TOOL_NAME}@${TOOL_VERSION}`],
    [labels.node ?? 'Node', model.node ?? '—'],
    [labels.generatedAt ?? 'Generated', timestampText(model.generatedAt)],
    [labels.profile ?? 'Profile', profile.id ? `${profile.id}（${profile.label ?? ''}）` : '—'],
    [labels.profilePath ?? 'Profile path', profile.path ?? '—'],
    [labels.designKind ?? 'Design source', designSource.kind ?? 'none'],
    [labels.designRef ?? 'Design reference', designRef || '—'],
    // 本次实际视口、档案设备档、差异画布是三件事，分开列出，避免 1280 与 1440 混写。
    [labels.viewportActual ?? '本次视口（截图/探针）', model.viewport
      ? `${model.viewport.width ?? '—'}×${model.viewport.height ?? '—'} @${model.viewport.dpr ?? 1}x`
      : '—'],
    [labels.profileDevice ?? '档案设备档', profile.device
      ? `${profile.device.id} · ${profile.device.width}×${profile.device.height} @${profile.device.dpr ?? 1}x`
      : '—'],
    ...(model.canvas ? [[labels.diffCanvas ?? '差异画布', `${model.canvas.width}×${model.canvas.height}`]] : []),
    [labels.threshold ?? 'Pass line', pct(model.threshold)],
    [labels.tolerance ?? 'Pixel tolerance', String(model.tolerance ?? '—')],
    [labels.scale ?? 'Scale', fmt(model.scale, 3)],
    [labels.url ?? 'URL', model.url ?? '—'],
    [labels.knownIssues ?? 'Known issues', String((profile.knownIssues ?? []).length)],
    [labels.notes ?? 'Notes', profile.notes || '—'],
  ];
  const items = rows.map(([key, value]) => `<div class="fixture-row"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  const artifacts = Object.entries(model.artifacts ?? {})
    .map(([key, value]) => `<div class="fixture-row"><dt>${escapeHtml(key)}</dt><dd><code>${escapeHtml(value)}</code></dd></div>`)
    .join('');
  const known = (profile.knownIssues ?? []).length > 0
    ? `<ul class="known-issues">${profile.knownIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
    : '';
  return `<dl class="fixture">${items}</dl>${known}
  <h3>${escapeHtml(locale.labels?.artifact ?? 'Artifacts')}</h3>
  <dl class="fixture">${artifacts}</dl>`;
}

/** 审计运行的显式声明：只做了审计探针，没有可对照的设计稿 / ui-spec（T6-L1）。 */
function auditDisclosure(model) {
  return model.locale === 'en'
    ? 'No design comparison in this audit run; only audit probes ran (ui_probe without expected), so there is no design image or ui-spec to compare against.'
    : '本次未做设计比对（审计运行）；本次只跑了审计探针（ui_probe 不带 expected），没有可对照的设计稿或 ui-spec。';
}

/** 风格指标的行数据（参考 / 产出 / 差异）；没有 style 数据时返回空数组。 */
function styleRows(style, locale) {
  const labels = locale.labels ?? {};
  const deltas = style?.deltas ?? {};
  const reference = style?.reference ?? {};
  const output = style?.output ?? {};
  const absolute = (a, b) => (Number.isFinite(Number(a)) && Number.isFinite(Number(b))
    ? Math.abs(Number(a) - Number(b))
    : undefined);
  return [
    { key: 'paletteDistance', label: labels.stylePaletteDistance ?? '色板距离', reference: '—', output: '—', delta: fmt(deltas.paletteDistance) },
    { key: 'luma', label: labels.styleLuma ?? '明度', reference: fmt(reference.meanLuma), output: fmt(output.meanLuma), delta: fmt(deltas.luma) },
    { key: 'sat', label: labels.styleSat ?? '饱和度', reference: fmt(reference.meanSat), output: fmt(output.meanSat), delta: fmt(deltas.sat) },
    { key: 'edgeDensity', label: labels.styleEdge ?? '边缘密度', reference: fmt(reference.edgeDensity), output: fmt(output.edgeDensity), delta: fmt(deltas.edgeDensity) },
    { key: 'fillRatio', label: labels.styleFill ?? '填充率', reference: fmt(reference.fillRatio), output: fmt(output.fillRatio), delta: fmt(deltas.fillRatio) },
    { key: 'flatRatio', label: labels.styleFlat ?? '主色覆盖率', reference: fmt(reference.flatRatio), output: fmt(output.flatRatio), delta: fmt(absolute(reference.flatRatio, output.flatRatio)) },
    { key: 'colorCount', label: labels.styleColorCount ?? '颜色数', reference: fmt(reference.colorCount), output: fmt(output.colorCount), delta: fmt(absolute(reference.colorCount, output.colorCount)) },
  ];
}

function stylePaletteText(palette) {
  return (palette ?? [])
    .map((entry) => `${entry.color} ${pct(entry.ratio)}`)
    .join(' · ');
}

function renderStyleTable(style, locale) {
  const labels = locale.labels ?? {};
  const rows = styleRows(style, locale).map((row) => `<tr>
      <td>${escapeHtml(row.label)}</td>
      <td>${escapeHtml(row.reference)}</td>
      <td>${escapeHtml(row.output)}</td>
      <td>${escapeHtml(row.delta)}</td>
    </tr>`).join('');
  return `<table class="data" data-sort="none">
  <thead><tr><th>${escapeHtml(labels.styleMetric ?? '指标')}</th><th>${escapeHtml(labels.styleReference ?? '参考')}</th><th>${escapeHtml(labels.styleOutput ?? '产出')}</th><th>${escapeHtml(labels.styleDelta ?? '差异')}</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderStylePalette(title, palette) {
  if (!Array.isArray(palette) || palette.length === 0) return '';
  const chips = palette.map((entry) => `<span class="swatch" style="background:${escapeHtml(entry.color)}" title="${escapeHtml(entry.color)}"></span><code>${escapeHtml(entry.color)}</code> <span class="muted">${pct(entry.ratio)}</span>`).join(' &nbsp; ');
  return `<p class="palette-line"><span class="muted">${escapeHtml(title)}</span> ${chips}</p>`;
}

/** 报告「风格指标」段：只展示证据，不输出 pass/fail；没有数据时整段省略。 */
function renderStyleSection(style, locale) {
  if (!style || !style.reference || !style.output) return '';
  const labels = locale.labels ?? {};
  const notes = (style.notes ?? []).map((note) => `<li>${escapeHtml(note)}</li>`).join('');
  const referencePalette = (style.reference.contentPalette ?? style.reference.palette ?? []).slice(0, 8);
  const outputPalette = (style.output.contentPalette ?? style.output.palette ?? []).slice(0, 8);
  return `<h2 id="style">${escapeHtml(locale.nav?.style ?? '风格指标')}</h2>
<p class="note">${escapeHtml(labels.styleHint ?? '风格指标只作证据，不参与 pass/fail 判定。')}</p>
<div class="cards">
  <div class="card"><div class="card-label">${escapeHtml(labels.styleScore ?? '风格分')}</div><div class="card-value">${escapeHtml(fmt(style.score))}</div><div class="card-sub">${escapeHtml(labels.stylePaletteDistance ?? '色板距离')} ${escapeHtml(fmt(style.deltas?.paletteDistance))}</div></div>
  <div class="card"><div class="card-label">${escapeHtml(labels.stylePaletteDistance ?? '色板距离')}</div><div class="card-value">${escapeHtml(fmt(style.deltas?.paletteDistance))}</div><div class="card-sub">${escapeHtml(`${labels.styleReference ?? '参考'} ${referencePalette.length} · ${labels.styleOutput ?? '产出'} ${outputPalette.length}`)}</div></div>
</div>
${renderStyleTable(style, locale)}
${renderStylePalette(labels.styleReference ?? '参考色板', referencePalette)}
${renderStylePalette(labels.styleOutput ?? '产出色板', outputPalette)}
${notes ? `<ul class="style-notes">${notes}</ul>` : ''}`;
}

function markdownStyleLines(style, locale) {
  const labels = locale.labels ?? {};
  const lines = [];
  lines.push(`## ${locale.nav?.style ?? '风格指标'}`, '');
  lines.push(`> ${labels.styleHint ?? '风格指标只作证据，不参与 pass/fail 判定。'}`, '');
  lines.push(`- ${labels.styleScore ?? '风格分'}: **${fmt(style.score)}**`);
  lines.push('');
  lines.push(`| ${labels.styleMetric ?? '指标'} | ${labels.styleReference ?? '参考'} | ${labels.styleOutput ?? '产出'} | ${labels.styleDelta ?? '差异'} |`);
  lines.push('| --- | --- | --- | --- |');
  for (const row of styleRows(style, locale)) {
    lines.push(`| ${escapeMd(row.label)} | ${escapeMd(row.reference)} | ${escapeMd(row.output)} | ${escapeMd(row.delta)} |`);
  }
  lines.push('');
  const referencePalette = stylePaletteText((style.reference?.contentPalette ?? style.reference?.palette ?? []).slice(0, 10));
  const outputPalette = stylePaletteText((style.output?.contentPalette ?? style.output?.palette ?? []).slice(0, 10));
  if (referencePalette) lines.push(`- ${labels.styleReference ?? '参考色板'}: ${referencePalette}`);
  if (outputPalette) lines.push(`- ${labels.styleOutput ?? '产出色板'}: ${outputPalette}`);
  if ((style.notes ?? []).length > 0) {
    lines.push('', ...style.notes.map((note) => `- ${note}`));
  }
  lines.push('');
  return lines;
}

function renderHtml(model, locale) {
  const labels = locale.labels ?? {};
  const nav = locale.nav ?? {};
  const modeText = locale.mode?.[model.mode] ?? model.mode;
  const tone = scoreTone(model.score, model.threshold);
  const scoreText = Number.isFinite(Number(model.score)) ? `${(Number(model.score) * 100).toFixed(2)}%` : '—';
  const rounds = (model.history ?? []).length || (Number.isFinite(Number(model.score)) ? 1 : 0);
  const checkSummary = model.probe?.summary ?? {};
  const regionSummary = (model.regions ?? []).reduce((acc, region) => {
    acc[region.severity] = (acc[region.severity] ?? 0) + 1;
    return acc;
  }, {});

  const card = (label, value, extra = '', valueClass = '') => `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value ${valueClass}">${value}</div>${extra}</div>`;
  const probeLine = (() => {
    const probe = model.probe;
    if (!probe) return labels.empty ?? '';
    if (probe.mode === 'spec') {
      const s = probe.summary ?? {};
      const misses = s.selectorMisses ? ` · 选择器缺失 ${s.selectorMisses}` : '';
      return `契约模式 · 检查 ${s.total ?? 0} 项 · 通过 ${s.passed ?? 0} · 未通过 ${s.failed ?? 0}（高 ${s.high ?? 0} / 中 ${s.medium ?? 0} / 低 ${s.low ?? 0}）${misses}`;
    }
    const s = probe.summary ?? {};
    return `审计模式 · 问题 ${s.total ?? 0} 条（高 ${s.high ?? 0} / 中 ${s.medium ?? 0} / 低 ${s.low ?? 0}）`;
  })();

  return `<!doctype html>
<html lang="${model.locale === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(model.title)}</title>
<style>
:root{
  --bg:#f6f8fb; --panel:#ffffff; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0;
  --good:#15803d; --warn:#b45309; --bad:#b91c1c; --brand:#2563eb;
  --high:#b91c1c; --medium:#b45309; --low:#475569; --pass:#15803d;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink)}
body{font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--brand)}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 64px}
header.top{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:22px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:16px;margin:34px 0 12px;padding-top:6px;border-top:1px solid var(--line)}
h3{font-size:13px;margin:18px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted)}
.sub{color:var(--muted);font-size:13px}
nav.toc{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 4px}
nav.toc a{font-size:12px;text-decoration:none;border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:4px 10px;color:var(--ink)}
nav.toc a:hover{border-color:var(--brand);color:var(--brand)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card-label{font-size:12px;color:var(--muted);letter-spacing:.02em}
.card-value{font-size:20px;font-weight:600;margin-top:4px;word-break:break-all}
.card-value.good{color:var(--good)} .card-value.warn{color:var(--warn)} .card-value.bad{color:var(--bad)}
.card-sub{font-size:12px;color:var(--muted);margin-top:4px}
.chart{width:100%;height:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:6px 4px}
.chart .grid{stroke:#eef2f7;stroke-width:1}
.chart .axis-label{fill:#94a3b8;font-size:11px}
.chart .line{fill:none;stroke:#2563eb;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.chart .dot.good{fill:#15803d} .chart .dot.warn{fill:#b45309} .chart .dot.bad{fill:#b91c1c} .chart .dot.unknown{fill:#64748b}
.chart .dot-label{fill:#334155;font-size:11px;font-weight:600}
.chart .threshold{stroke:#b91c1c;stroke-width:1.5;stroke-dasharray:6 5;opacity:.7}
.chart .threshold-label{fill:#b91c1c;font-size:11px}
.chart .chart-empty{fill:#94a3b8;font-size:13px}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.panel{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px}
.panel figcaption{font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}
.panel img{width:100%;height:auto;display:block;border-radius:6px;background:#f8fafc;border:1px solid #eef2f7}
.panel a{display:block}
.placeholder{min-height:160px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:6px;color:var(--muted);font-size:12px;text-align:center;padding:16px;background:#fbfcfe}
table.data{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
table.data th,table.data td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
table.data th{background:#f8fafc;font-weight:600;font-size:12px;color:#475569;white-space:nowrap}
table.data tr:last-child td{border-bottom:none}
table.data tr.fail-row td{background:#fffdfd}
table.data code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f1f5f9;padding:1px 4px;border-radius:4px}
.badge{display:inline-block;font-size:11px;line-height:1.7;border-radius:999px;padding:0 8px;border:1px solid transparent;white-space:nowrap}
.badge.sev-high{background:#fef2f2;color:var(--high);border-color:#fecaca}
.badge.sev-medium{background:#fffbeb;color:var(--medium);border-color:#fde68a}
.badge.sev-low{background:#f1f5f9;color:var(--low);border-color:#e2e8f0}
.badge.pass{background:#f0fdf4;color:var(--pass);border-color:#bbf7d0}
ol.fixes{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px 14px 34px;margin:0}
ol.fixes li{margin:8px 0}
ol.fixes strong{font-weight:600}
dl.fixture{display:block;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0}
.fixture-row{display:grid;grid-template-columns:max-content 1fr;gap:2px 18px;padding:2px 0}
dl.fixture dt{color:var(--muted);font-size:12px}
dl.fixture dd{margin:0;word-break:break-all}
ul.known-issues{margin:10px 0 0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px 12px 30px}
footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between}
.note{font-size:12px;color:var(--muted);margin:6px 0 12px}
.palette-line{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0;font-size:12px}
.swatch{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid rgba(15,23,42,.18);vertical-align:-1px;margin-right:4px}
ul.style-notes{margin:10px 0 0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px 12px 30px;font-size:12px;color:#334155}
ul.style-notes li{margin:4px 0}
@media (max-width:640px){
  .wrap{padding:18px 12px 40px}
  h1{font-size:18px}
  .card-value{font-size:17px}
  table.data{display:block;overflow-x:auto;white-space:nowrap}
  dl.fixture{grid-template-columns:1fr}
}
@media print{
  body{background:#fff}
  nav.toc{display:none}
  .panel img{max-height:320px;object-fit:contain}
}
</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <div>
    <h1>${escapeHtml(model.title)}</h1>
    <div class="sub">${escapeHtml(labels.generatedAt ?? 'Generated')}: ${timestampText(model.generatedAt)} · ${escapeHtml(TOOL_NAME)}@${escapeHtml(TOOL_VERSION)} · ${escapeHtml(labels.mode ?? 'Mode')}: ${escapeHtml(modeText)}</div>
  </div>
  <div class="sub">${escapeHtml(labels.url ?? 'URL')}: <span>${escapeHtml(model.url ?? '—')}</span></div>
</header>

<nav class="toc">
  <a href="#overview">${escapeHtml(nav.overview ?? 'Overview')}</a>
  <a href="#score">${escapeHtml(nav.score ?? 'Score')}</a>
  <a href="#images">${escapeHtml(nav.images ?? 'Images')}</a>
  ${model.style ? `<a href="#style">${escapeHtml(nav.style ?? '风格指标')}</a>` : ''}
  <a href="#regions">${escapeHtml(nav.regions ?? 'Regions')}</a>
  <a href="#checks">${escapeHtml(nav.checks ?? 'Checks')}</a>
  <a href="#issues">${escapeHtml(nav.issues ?? 'Issues')}</a>
  <a href="#fixes">${escapeHtml(nav.fixes ?? 'Fixes')}</a>
  <a href="#fixture">${escapeHtml(nav.fixture ?? 'Fixture')}</a>
</nav>

<h2 id="overview">${escapeHtml(nav.overview ?? 'Overview')}</h2>
<div class="cards">
  ${card(labels.score ?? 'Fidelity', escapeHtml(scoreText), `<div class="card-sub">${escapeHtml(labels.threshold ?? 'Pass line')} ${pct(model.threshold)} · ${escapeHtml(labels.diffRatio ?? 'Diff ratio')} ${pct(model.diffRatio)}</div>`, tone)}
  ${card(labels.rounds ?? 'Rounds', String(rounds), `<div class="card-sub">${escapeHtml(labels.history ?? 'Round scores')}: ${escapeHtml((model.history ?? []).map((entry) => fmt(entry.score, 3)).join(' → ') || '—')}</div>`)}
  ${card(labels.mode ?? 'Mode', escapeHtml(modeText), `<div class="card-sub">${escapeHtml(labels.designKind ?? 'Design source')}: ${escapeHtml(model.profile?.designSource?.kind ?? 'none')}</div>`)}
  ${card(labels.regions ?? 'Regions', String((model.regions ?? []).length), `<div class="card-sub">${escapeHtml(labels.severity ?? 'Severity')}: 高 ${regionSummary.high ?? 0} · 中 ${regionSummary.medium ?? 0} · 低 ${regionSummary.low ?? 0}</div>`)}
  ${card(labels.checks ?? 'Property diffs', `${checkSummary.failed ?? 0} / ${checkSummary.total ?? 0}`, `<div class="card-sub">${escapeHtml(labels.profile ?? 'Profile')}: ${escapeHtml(model.profile?.id ?? '—')} · ${escapeHtml(labels.viewport ?? 'Viewport')}: ${model.viewport?.width ?? '—'}×${model.viewport?.height ?? '—'} @${model.viewport?.dpr ?? 1}x</div>`)}
</div>
${model.modeConflict ? `<p class="note">${escapeHtml(fillTemplate(labels.modeConflict ?? MODE_CONFLICT_TEMPLATE, model.modeConflict))}</p>` : ''}

<h2 id="score">${escapeHtml(nav.score ?? 'Score')}</h2>
<p class="note">${escapeHtml(labels.history ?? 'Round scores')}: ${escapeHtml((model.history ?? []).map((entry) => `R${entry.round ?? '?'}=${fmt(entry.score, 3)}`).join(' · ') || '—')}</p>
${renderScoreChart(model.history, model.threshold, locale)}

<h2 id="images">${escapeHtml(nav.images ?? 'Images')}</h2>
${model.mode === 'none'
    ? `<p class="note">${escapeHtml(labels.noDesign ?? '')}</p>`
    : ''}
<div class="panels">
  ${imagePanel(labels.design ?? 'Design', model.images?.design, model.imageSizes?.design, model.mode === 'none' ? labels.noDesign ?? '' : labels.empty ?? '')}
  ${imagePanel(labels.shot ?? 'Screenshot', model.images?.shot, model.imageSizes?.shot, labels.noShot ?? '')}
  ${imagePanel(labels.diff ?? 'Heatmap', model.images?.diff, model.imageSizes?.diff, labels.noDiff ?? '')}
</div>
${model.images?.sideBySide ? `<p class="note">${escapeHtml(labels.sideBySide ?? 'Side by side')}: <a href="${escapeHtml(model.images.sideBySide)}">${escapeHtml(model.images.sideBySide)}</a></p>` : ''}

${renderStyleSection(model.style, locale)}

<h2 id="regions">${escapeHtml(nav.regions ?? 'Regions')}</h2>
<p class="note">${escapeHtml(labels.staticSortHint ?? '')}${model.sizeMismatch?.mismatch ? ` · ${escapeHtml(labels.sizeMismatch ?? 'Size mismatch')}: ${model.sizeMismatch.design.width}×${model.sizeMismatch.design.height} vs ${model.sizeMismatch.shot.width}×${model.sizeMismatch.shot.height}` : ''}</p>
${renderRegionsTable(model.regions, locale)}

<h2 id="checks">${escapeHtml(nav.checks ?? 'Checks')}</h2>
<p class="note">${escapeHtml(probeLine)}</p>
${model.probe?.mode === 'audit' ? `<p class="note">${escapeHtml(auditDisclosure(model))}</p>` : ''}
${model.probe?.mode === 'audit'
    ? `<p class="note">${escapeHtml(labels.auditHint ?? '')}</p>`
    : renderChecksTable(model.probe?.mode === 'spec' ? model.probe.checks : [], locale)}
${(model.probe?.selectorMisses ?? []).length > 0
    ? `<h3>${escapeHtml(labels.selector ?? 'Selector')} miss</h3><ul>${model.probe.selectorMisses.map((miss) => `<li><code>${escapeHtml(miss.selector)}</code> ${escapeHtml(miss.label ?? '')}${miss.invalid ? '（选择器语法非法）' : '（页面没有匹配元素）'}</li>`).join('')}</ul>`
    : ''}

<h2 id="issues">${escapeHtml(nav.issues ?? 'Issues')}</h2>
${model.probe?.mode === 'spec'
    ? `<p class="note">${escapeHtml(labels.specHint ?? '')}</p>`
    : renderIssuesTable(model.probe?.mode === 'audit' ? model.probe.issues : [], locale)}
${model.probe?.mode === 'audit'
    ? `<h3>${escapeHtml(labels.detail ?? '')}</h3>
<dl class="fixture">
  <div class="fixture-row"><dt>${escapeHtml(labels.severity ?? 'Severity')}</dt><dd>高 ${model.probe.summary?.high ?? 0} · 中 ${model.probe.summary?.medium ?? 0} · 低 ${model.probe.summary?.low ?? 0}</dd></div>
  <div class="fixture-row"><dt>${escapeHtml(labels.detail ?? 'Detail')}</dt><dd>${escapeHtml(`元素 ${model.probe.audit?.elementsScanned ?? '—'} 个，溢出 ${model.probe.audit?.overflow ?? 0}，缺 alt ${model.probe.audit?.imagesWithoutAlt ?? 0}，焦点风险 ${model.probe.audit?.focusRisks ?? 0}，可疑空态 ${model.probe.audit?.emptyStates ?? 0}，内联硬编码色 ${model.probe.audit?.hardcodedColors ?? 0}`)}</dd></div>
  ${distributionRow('字号分布', model.probe.audit?.fontSizes)}
  ${distributionRow('间距分布', model.probe.audit?.spacing)}
  ${distributionRow('颜色分布', model.probe.audit?.palette)}
</dl>`
    : ''}

<h2 id="fixes">${escapeHtml(nav.fixes ?? 'Fixes')}</h2>
${renderFixes(model.fixes, locale)}

<h2 id="fixture">${escapeHtml(nav.fixture ?? 'Fixture')}</h2>
${renderFixture(model, locale)}

<footer>
  <span>${escapeHtml(locale.footer ?? '')}</span>
  <span>${escapeHtml(TOOL_NAME)}@${escapeHtml(TOOL_VERSION)}</span>
</footer>
</div>
</body>
</html>
`;
}

function renderMarkdown(model, locale) {
  const labels = locale.labels ?? {};
  const lines = [];
  lines.push(`# ${model.title}`, '');
  lines.push(`- ${labels.generatedAt ?? 'Generated'}: ${timestampText(model.generatedAt)}`);
  lines.push(`- ${labels.url ?? 'URL'}: ${model.url ?? '—'}`);
  lines.push(`- ${labels.mode ?? 'Mode'}: ${locale.mode?.[model.mode] ?? model.mode} · ${labels.designKind ?? 'Design source'}: ${model.profile?.designSource?.kind ?? 'none'}`);
  if (model.modeConflict) lines.push(`- ⚠ ${fillTemplate(labels.modeConflict ?? MODE_CONFLICT_TEMPLATE, model.modeConflict)}`);
  lines.push(`- ${labels.score ?? 'Score'}: **${Number.isFinite(Number(model.score)) ? `${(Number(model.score) * 100).toFixed(2)}%` : '—'}**（${labels.threshold ?? 'pass line'} ${pct(model.threshold)}）`);
  lines.push(`- ${labels.profile ?? 'Profile'}: ${model.profile?.id ?? '—'} · ${labels.viewport ?? 'Viewport'}: ${model.viewport?.width ?? '—'}×${model.viewport?.height ?? '—'} @${model.viewport?.dpr ?? 1}x`);
  lines.push('');

  lines.push(`## ${locale.nav?.score ?? 'Score'}`, '');
  lines.push((model.history ?? []).map((entry) => `R${entry.round ?? '?'}=${fmt(entry.score, 3)}`).join(' · ') || (labels.empty ?? ''));
  lines.push('');

  lines.push(`## ${locale.nav?.images ?? 'Images'}`, '');
  if (model.images?.design) lines.push(`![${labels.design ?? 'design'}](${model.images.design})`);
  else lines.push(`> ${labels.noDesign ?? ''}`);
  if (model.images?.shot) lines.push('', `![${labels.shot ?? 'shot'}](${model.images.shot})`);
  if (model.images?.diff) lines.push('', `![${labels.diff ?? 'diff'}](${model.images.diff})`);
  if (model.images?.sideBySide) lines.push('', `[${labels.sideBySide ?? 'side by side'}](${model.images.sideBySide})`);
  lines.push('');

  if (model.style) lines.push(...markdownStyleLines(model.style, locale));

  lines.push(`## ${locale.nav?.regions ?? 'Regions'}`, '');
  if ((model.regions ?? []).length === 0) lines.push(labels.empty ?? '');
  else {
    lines.push(`| ${labels.id ?? '#'} | X,Y | ${labels.width ?? 'W'}×${labels.height ?? 'H'} | ${labels.pixels ?? 'Pixels'} | ${labels.area ?? 'Share'} | ${labels.severity ?? 'Severity'} |`);
    lines.push('| --- | --- | --- | --- | --- | --- |');
    const sortedRegions = [...model.regions].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.pixels - a.pixels);
    for (const region of sortedRegions) {
      lines.push(`| #${region.index} | ${region.x}, ${region.y} | ${region.width}×${region.height} | ${region.pixels} | ${pct(region.ratio)} | ${locale.severity?.[region.severity] ?? region.severity} |`);
    }
  }
  lines.push('');

  lines.push(`## ${locale.nav?.checks ?? 'Checks'}`, '');
  if (model.probe?.mode === 'spec') {
    const s = model.probe.summary ?? {};
    lines.push(`- ${labels.property ?? 'Property'} checks: ${s.total ?? 0} · pass ${s.passed ?? 0} · fail ${s.failed ?? 0}（high ${s.high ?? 0} / medium ${s.medium ?? 0} / low ${s.low ?? 0}）${s.selectorMisses ? ` · selector misses ${s.selectorMisses}` : ''}`);
    lines.push('');
  } else if (model.probe?.mode === 'audit') {
    const s = model.probe.summary ?? {};
    lines.push(`- audit issues: ${s.total ?? 0}（high ${s.high ?? 0} / medium ${s.medium ?? 0} / low ${s.low ?? 0}）`, '');
    lines.push(`- ${auditDisclosure(model)}`, '');
  }
  const checks = model.probe?.mode === 'spec' ? sortChecks(model.probe.checks) : [];
  if (checks.length === 0) lines.push(labels.empty ?? '');
  else {
    lines.push(`| ${labels.selector ?? 'Selector'} | ${labels.property ?? 'Property'} | ${labels.expected ?? 'Expected'} | ${labels.actual ?? 'Actual'} | ${labels.delta ?? 'Delta'} | ${labels.severity ?? 'Severity'} |`);
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const check of checks) {
      lines.push(`| ${escapeMd(check.selector)} | ${check.property} | ${escapeMd(check.expected)} | ${escapeMd(check.actual)} | ${escapeMd(check.deltaText || '—')} | ${check.pass ? (labels.pass ?? 'pass') : locale.severity?.[check.severity] ?? check.severity} |`);
    }
  }
  lines.push('');

  lines.push(`## ${locale.nav?.issues ?? 'Issues'}`, '');
  const issues = model.probe?.mode === 'audit' ? sortIssues(model.probe.issues) : [];
  if (issues.length === 0) lines.push(labels.empty ?? '');
  else {
    lines.push(`| ${labels.kind ?? 'Kind'} | ${labels.selector ?? 'Selector'} | ${labels.detail ?? 'Detail'} | ${labels.severity ?? 'Severity'} |`);
    lines.push('| --- | --- | --- | --- |');
    for (const issue of issues) {
      lines.push(`| ${issue.kind} | ${escapeMd(issue.selector)} | ${escapeMd(issue.detail)} | ${locale.severity?.[issue.severity] ?? issue.severity} |`);
    }
  }
  lines.push('');

  lines.push(`## ${locale.nav?.fixes ?? 'Fixes'}`, '');
  if ((model.fixes ?? []).length === 0) lines.push(labels.empty ?? '');
  else {
    model.fixes.forEach((fix, index) => {
      lines.push(`${index + 1}. [${locale.severity?.[fix.priority] ?? fix.priority}] **${fix.target}**（${fix.source}）— ${fix.action}`);
    });
  }
  lines.push('');

  lines.push(`## ${locale.nav?.fixture ?? 'Fixture'}`, '');
  const profile = model.profile ?? {};
  const designSource = profile.designSource ?? { kind: 'none' };
  lines.push(`- ${labels.tool ?? 'Tool'}: ${TOOL_NAME}@${TOOL_VERSION}`);
  lines.push(`- ${labels.node ?? 'Node'}: ${model.node ?? '—'}`);
  lines.push(`- ${labels.profile ?? 'Profile'}: ${profile.id ?? '—'}（${profile.path ?? '内置'}）`);
  lines.push(`- ${labels.designRef ?? 'Design reference'}: ${[designSource.mcpServer, designSource.artboard, designSource.path].filter(Boolean).join(' · ') || '—'}`);
  lines.push(`- ${labels.viewportActual ?? '本次视口（截图/探针）'}: ${model.viewport ? `${model.viewport.width ?? '—'}×${model.viewport.height ?? '—'} @${model.viewport.dpr ?? 1}x` : '—'}`);
  lines.push(`- ${labels.profileDevice ?? '档案设备档'}: ${profile.device ? `${profile.device.id} · ${profile.device.width}×${profile.device.height} @${profile.device.dpr ?? 1}x` : '—'}`);
  if (model.canvas) lines.push(`- ${labels.diffCanvas ?? '差异画布'}: ${model.canvas.width}×${model.canvas.height}`);
  lines.push(`- ${labels.tolerance ?? 'Tolerance'}: ${model.tolerance ?? '—'} · ${labels.scale ?? 'Scale'}: ${fmt(model.scale, 3)}`);
  lines.push(`- ${labels.knownIssues ?? 'Known issues'}: ${(profile.knownIssues ?? []).length}`);
  if ((profile.notes ?? '') !== '') lines.push(`- ${labels.notes ?? 'Notes'}: ${profile.notes}`);
  lines.push('');
  lines.push('### artifacts', '');
  for (const [key, value] of Object.entries(model.artifacts ?? {})) lines.push(`- ${key}: \`${value}\``);
  lines.push('');
  lines.push(`> ${locale.footer ?? ''}`);
  return `${lines.join('\n')}\n`;
}

/**
 * 生成报告。
 * @param {{
 *   cwd?: string, config?: object, run?: string, design?: string, shot?: string,
 *   diffPath?: string, diffJson?: string, probePath?: string, out?: string,
 *   title?: string, mode?: string, locale?: string, profile?: object, history?: object[]
 * }} options
 */
export function buildReport(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? {};
  const locale = loadLocale(options.locale ?? config.locale ?? 'zh');
  const runDir = options.run ? resolveWorkspacePath(cwd, options.run) : undefined;
  const meta = runDir && existsSync(runDir) ? readMeta(runDir) : undefined;
  const discovered = runDir ? discoverRunArtifacts(runDir, meta ?? { artifacts: {} }) : {};

  const designPath = options.design ? resolveWorkspacePath(cwd, options.design) : discovered.design;
  const shotPath = options.shot ? resolveWorkspacePath(cwd, options.shot) : discovered.shot;
  const diffPath = options.diffPath ? resolveWorkspacePath(cwd, options.diffPath) : discovered.diff;
  const diffJsonPath = options.diffJson ? resolveWorkspacePath(cwd, options.diffJson) : discovered.diffJson;
  const probePath = options.probePath ? resolveWorkspacePath(cwd, options.probePath) : discovered.probeJson;

  if (!designPath && !shotPath && !diffPath && !diffJsonPath && !probePath) {
    throw new Error('ui_report 至少需要一个输入：run 目录，或 design / shot / diffPath / probePath 中任意一项');
  }

  const outDir = ensureDir(
    options.out
      ? resolveWorkspacePath(cwd, options.out)
      : runDir ?? (shotPath ? dirname(shotPath) : resolveWorkspacePath(cwd, join(DEFAULT_RUN_ROOT, `report-${stamp()}`))),
  );

  const diffData = readJsonIfExists(diffJsonPath, '差异摘要');
  const probeData = readJsonIfExists(probePath, '探针结果');
  const shotSize = shotPath ? pngSizeSafe(shotPath) : undefined;  const designSize = designPath ? pngSizeSafe(designPath) : undefined;
  const diffSize = diffPath ? pngSizeSafe(diffPath) : undefined;

  const images = {};
  const imageSizes = {};
  if (designPath) {
    images.design = materializeImage(outDir, designPath, 'design');
    imageSizes.design = designSize;
  }
  if (shotPath) {
    images.shot = materializeImage(outDir, shotPath, 'shot');
    imageSizes.shot = shotSize;
  }
  if (diffPath) {
    images.diff = materializeImage(outDir, diffPath, 'diff');
    imageSizes.diff = diffSize;
  }
  if (discovered.sideBySide) {
    images.sideBySide = materializeImage(outDir, discovered.sideBySide, 'side-by-side');
  }

  const history = Array.isArray(options.history) && options.history.length > 0
    ? options.history
    : Array.isArray(meta?.history) && meta.history.length > 0
      ? meta.history
      : diffData
        ? [{ round: 1, score: diffData.score }]
        : [];

  const score = Number.isFinite(Number(diffData?.score))
    ? Number(diffData.score)
    : Number.isFinite(Number(meta?.lastScore))
      ? Number(meta.lastScore)
      : undefined;

  const profile = options.profile ?? meta?.profile;
  const threshold = Number.isFinite(Number(options.threshold))
    ? Number(options.threshold)
    : Number.isFinite(Number(profile?.thresholds?.score))
      ? Number(profile.thresholds.score)
      : 0.95;
  // 档案 designSource 是项目级声明，报告模式以它为准；显式 mode 只在没有档案声明时生效。
  const designKind = profile?.designSource?.kind;
  const profileMode = designKind ? (designKind === 'none' ? 'none' : 'design') : undefined;
  const requestedMode = options.mode;
  const mode = profileMode ?? requestedMode ?? meta?.mode ?? (designPath ? 'design' : 'none');
  const modeConflict = requestedMode && profileMode && requestedMode !== profileMode
    ? { requested: requestedMode, kind: designKind, effective: profileMode }
    : undefined;

  // 风格指标只作证据：优先用 diff.json 里的 style，其次用 meta.json 的备份；缺省时整段不渲染。
  const styleData = isPlainObject(diffData?.style)
    ? diffData.style
    : isPlainObject(meta?.style)
      ? meta.style
      : undefined;

  const model = {
    title: options.title ?? config.reportTitle ?? locale.title ?? 'UI 还原验收报告',
    generatedAt: new Date().toISOString(),
    locale: options.locale ?? config.locale ?? 'zh',
    tool: { name: TOOL_NAME, version: TOOL_VERSION, package: PACKAGE.name },
    node: process.version,
    mode,
    modeConflict,
    url: meta?.url ?? probeData?.url ?? diffData?.url ?? '',
    viewport: meta?.viewport ?? probeData?.viewport,
    selector: meta?.selector ?? '',
    profile,
    threshold,
    score,
    diffRatio: diffData?.diffRatio,
    regions: diffData?.regions ?? [],
    sizeMismatch: diffData?.sizeMismatch,
    style: styleData,
    canvas: diffData?.canvas ?? meta?.canvas,
    scale: diffData?.scale,
    tolerance: diffData?.tolerance,
    history,
    probe: probeData,
    images,
    imageSizes,
    fixes: [],
    artifacts: {},
  };

  model.fixes = buildFixList(model, locale);

  const artifactEntries = {
    design: images.design,
    shot: images.shot,
    diff: images.diff,
    sideBySide: images.sideBySide,
    diffJson: diffJsonPath ? relOrAbs(outDir, diffJsonPath) : undefined,
    probeJson: probePath ? relOrAbs(outDir, probePath) : undefined,
    markdown: 'report.md',
    html: 'report.html',
  };
  model.artifacts = Object.fromEntries(Object.entries(artifactEntries).filter(([, value]) => typeof value === 'string' && value !== ''));

  const htmlPath = join(outDir, 'report.html');
  const markdownPath = join(outDir, 'report.md');
  writeFileSync(htmlPath, renderHtml(model, locale), 'utf8');
  writeFileSync(markdownPath, renderMarkdown(model, locale), 'utf8');

  if (runDir) {
    mergeMeta(runDir, {
      mode,
      url: model.url,
      viewport: model.viewport,
      profile: profile ?? undefined,
      thresholds: { score: threshold },
      artifacts: { reportHtml: basename(htmlPath), reportMarkdown: basename(markdownPath) },
      lastScore: score ?? null,
    });
  }

  const summary = {
    score: score ?? null,
    diffRatio: model.diffRatio ?? null,
    regions: model.regions.length,
    rounds: history.length,
    mode,
    designSource: profile?.designSource?.kind ?? 'none',
    checks: probeData?.summary ?? null,
    issues: probeData?.mode === 'audit' ? probeData.summary ?? null : null,
    fixes: model.fixes.length,
    pass: score === undefined ? null : score >= threshold,
  };

  return { htmlPath, markdownPath, outDir, summary, model };
}

function pngSizeSafe(file) {
  try {
    return readPngSize(readFileSync(file));
  } catch {
    return undefined;
  }
}
