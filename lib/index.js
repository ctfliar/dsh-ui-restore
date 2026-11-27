/**
 * dsh-ui-restore · DeepSeek Harness 插件入口
 *
 * 注册四个 Host 工具，构成「实现 → 截图 → 量化验收 → 报告」的闭环：
 *
 * - ui_capture  用 playwright-core 起浏览器截图（chromium → chrome → msedge）
 * - ui_diff     设计稿 vs 截图：等比对齐 + 逐像素 + 差异区域 + 热力图
 * - ui_probe    样式探针：无 expected 做体检；有 expected 按 ui-spec 逐属性比对
 * - ui_report   产出 report.md 与单文件 report.html（无外链、无 CDN、无 JS）
 *
 * 插件不连接任何 MCP、不访问外部服务；工具只返回本地文件路径，图片由模型用
 * read_image 自行查看。
 *
 * @module dsh-ui-restore
 */
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { capturePage } from './browser.js';
import { diffImages, readPngSize } from './diff.js';
import { runProbe } from './probe.js';
import { readSpecSource } from './spec.js';
import { loadProfile, primaryDevice } from './profile.js';
import { buildReport } from './report.js';
import { analyzeStyle, compareStyleAnalyses } from './style.js';
import { registerBundledSkill } from './skill.js';
import {
  TOOL_VERSION,
  appendHistory,
  assertFile,
  defaultRunDir,
  ensureDir,
  mergeMeta,
  profileSummary,
  resolveRunDir,
  resolveWorkspacePath,
  writeJsonFile,
} from './paths.js';

export const name = 'ui-restore';
export const inject = ['tools'];

const DEFAULT_CONFIG = {
  runRoot: 'output/ui-restore',
  profileDir: 'ui-restore-profiles',
  channels: ['chromium', 'chrome', 'msedge'],
  navigationTimeoutMs: 30000,
  launchTimeoutMs: 30000,
  settleMs: 250,
  tolerance: 24,
  locale: 'zh',
  freezeAnimations: true,
  reportTitle: undefined,
};

export const Config = Schema.object({
  runRoot: Schema.string().default(DEFAULT_CONFIG.runRoot).description('运行产物目录（相对工作区）'),
  profileDir: Schema.string().default(DEFAULT_CONFIG.profileDir).description('项目档案目录（相对工作区）'),
  channels: Schema.array(Schema.string()).default(DEFAULT_CONFIG.channels).description('浏览器 channel 尝试顺序'),
  executablePath: Schema.string().description('浏览器二进制绝对路径（优先于 channel）'),
  navigationTimeoutMs: Schema.number().default(DEFAULT_CONFIG.navigationTimeoutMs),
  launchTimeoutMs: Schema.number().default(DEFAULT_CONFIG.launchTimeoutMs),
  settleMs: Schema.number().default(DEFAULT_CONFIG.settleMs),
  tolerance: Schema.number().default(DEFAULT_CONFIG.tolerance).description('ui_diff 默认像素容差（0-255）'),
  locale: Schema.string().default(DEFAULT_CONFIG.locale).description('报告语言：zh | en'),
  freezeAnimations: Schema.boolean().default(DEFAULT_CONFIG.freezeAnimations),
  reportTitle: Schema.string().description('报告标题'),
});

function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  config.channels = Array.isArray(config.channels) && config.channels.length > 0
    ? config.channels.filter((channel) => typeof channel === 'string' && channel !== '')
    : [...DEFAULT_CONFIG.channels];
  if (config.channels.length === 0) config.channels = [...DEFAULT_CONFIG.channels];
  return config;
}

function textRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function workspaceCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}

function loadProfileSafe(source, { cwd, profileDir }) {
  if (!source) return null;
  return loadProfile(source, { cwd, profileDir });
}

function profileMode(profileResult) {
  const kind = profileResult?.profile?.designSource?.kind;
  return kind && kind !== 'none' ? 'design' : 'none';
}

function viewportOf(args, device) {
  return {
    width: Number.isFinite(args.width) ? args.width : device.width,
    height: Number.isFinite(args.height) ? args.height : device.height,
    dpr: Number.isFinite(args.dpr) && args.dpr > 0 ? args.dpr : device.dpr ?? 1,
  };
}

/** 约定：run 目录里的产物存相对文件名，外部路径存绝对路径。 */
function artifactPath(runDir, file) {
  if (!runDir) return file;
  const absolute = resolve(file);
  return dirname(absolute) === resolve(runDir) ? basename(absolute) : absolute;
}

function sizeOfFile(file) {
  if (!file || !existsSync(file)) return undefined;
  try {
    const size = readPngSize(readFileSync(file));
    return { width: size.width, height: size.height };
  } catch {
    return undefined;
  }
}

const REGION_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true },
    x: { type: 'integer', required: true },
    y: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    pixels: { type: 'integer', required: true },
    ratio: { type: 'number', required: true },
    severity: { type: 'string', required: true },
  },
});

const SIZE_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
  },
});

const VIEWPORT_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    dpr: { type: 'number', required: true },
  },
});

const CHECK_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    selector: { type: 'string', required: true },
    label: { type: 'string' },
    property: { type: 'string', required: true },
    expected: { type: 'string', required: true },
    actual: { type: 'string', required: true },
    delta: { type: 'number', required: true },
    deltaText: { type: 'string' },
    severity: { type: 'string', required: true },
    pass: { type: 'boolean', required: true },
  },
});

const ISSUE_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    severity: { type: 'string', required: true },
    selector: { type: 'string', required: true },
    detail: { type: 'string', required: true },
  },
});

const MISS_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    selector: { type: 'string', required: true },
    label: { type: 'string' },
    invalid: { type: 'boolean' },
  },
});

const PAIR_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    value: { type: 'string', required: true },
    count: { type: 'integer', required: true },
  },
});

const STYLE_PALETTE_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    color: { type: 'string', required: true },
    ratio: { type: 'number', required: true },
  },
});

const STYLE_BBOX_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'integer', required: true },
    y: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    ratio: { type: 'number', required: true },
  },
});

const STYLE_ANALYSIS_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    background: { ...STYLE_PALETTE_SCHEMA(), required: true },
    palette: { type: 'array', required: true, items: STYLE_PALETTE_SCHEMA() },
    contentPalette: { type: 'array', required: true, items: STYLE_PALETTE_SCHEMA() },
    colorCount: { type: 'integer', required: true },
    meanLuma: { type: 'number', required: true },
    meanSat: { type: 'number', required: true },
    flatRatio: { type: 'number', required: true },
    edgeDensity: { type: 'number', required: true },
    fillRatio: { type: 'number', required: true },
    bbox: { ...STYLE_BBOX_SCHEMA(), required: true },
  },
});

const STYLE_DELTAS_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    paletteDistance: { type: 'number', required: true },
    luma: { type: 'number', required: true },
    sat: { type: 'number', required: true },
    edgeDensity: { type: 'number', required: true },
    fillRatio: { type: 'number', required: true },
  },
});

const STYLE_SCHEMA = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'number', required: true },
    deltas: { ...STYLE_DELTAS_SCHEMA(), required: true },
    notes: { type: 'array', items: { type: 'string' } },
    reference: { ...STYLE_ANALYSIS_SCHEMA(), required: true },
    output: { ...STYLE_ANALYSIS_SCHEMA(), required: true },
  },
});

/**
 * 工具真正调用到的实现。第三个参数只用于测试注入（selftest 用假浏览器实现
 * 跑工具入口级回归，避免依赖真实浏览器）；DSH 加载时只传 ctx/config。
 */
const DEFAULT_DEPS = { capturePage, diffImages, runProbe, buildReport, analyzeStyle, compareStyleAnalyses };

export function apply(ctx, rawConfig, deps = {}) {
  const config = normalizeConfig(rawConfig);
  const impl = { ...DEFAULT_DEPS, ...deps };

  // 包内 SKILL 自动注册：ctx.inject(['skills']) 是可选项，缺 skills service 时静默跳过。
  registerBundledSkill(ctx);

  ctx.tools.register(defineTool({
    name: 'ui_capture',
    description: [
      '用本机 Chromium/Chrome/Edge 截图，返回 PNG 路径与像素尺寸。',
      '缺省视口取 profile.devices[0]（无档案时 1440×900）；给 run 时写入 run 目录的 shot.png。',
      '图片用 read_image 查看；工具不返回图片块。',
    ].join(''),
    parameters: {
      url: { type: 'string', required: true, description: '页面地址；支持 http(s)、file:// 以及工作区内的相对路径' },
      profile: { type: 'string', description: '项目档案 id 或 JSON 路径；用于取设备档、阈值与设计源' },
      width: { type: 'integer', description: '视口宽度（默认取档案 devices[0].width，缺省 1440）' },
      height: { type: 'integer', description: '视口高度（默认取档案 devices[0].height，缺省 900）' },
      dpr: { type: 'number', description: '设备像素比（默认取档案 devices[0].dpr，缺省 1）' },
      fullPage: { type: 'boolean', description: '截整页而不是首屏（默认 false）' },
      selector: { type: 'string', description: '只截该 CSS 选择器匹配的元素' },
      path: { type: 'string', description: '输出 PNG 路径；缺省写入 run 目录 shot.png 或 <runRoot>/run-<时间>/shot.png' },
      run: { type: 'string', description: '本次运行的目录（产物与元数据聚合到这里）' },
      waitMs: { type: 'integer', description: '加载后额外等待毫秒数（默认 config.settleMs）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          dpr: { type: 'number', required: true },
          cssWidth: { type: 'integer' },
          cssHeight: { type: 'integer' },
          fullPage: { type: 'boolean' },
          selector: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          channel: { type: 'string' },
          run: { type: 'string' },
          profile: { type: 'string' },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      const cwd = workspaceCwd(exec);
      const profileResult = loadProfileSafe(args.profile, { cwd, profileDir: config.profileDir });
      const device = primaryDevice(profileResult?.profile);
      const viewport = viewportOf(args, device);
      const runDir = args.run ? resolveRunDir({ cwd, runRoot: config.runRoot, run: args.run }) : undefined;
      const targetPath = args.path
        ? resolveWorkspacePath(cwd, args.path)
        : join(runDir ?? defaultRunDir(cwd, config.runRoot), 'shot.png');
      ensureDir(dirname(targetPath));

      const capture = await impl.capturePage({
        config,
        cwd,
        url: args.url,
        width: viewport.width,
        height: viewport.height,
        dpr: viewport.dpr,
        fullPage: args.fullPage === true,
        selector: args.selector,
        path: targetPath,
        waitMs: args.waitMs,
        profileDevice: device?.id,
      });

      if (runDir) {
        mergeMeta(runDir, {
          ...(profileResult ? { mode: profileMode(profileResult), profile: profileSummary(profileResult) } : {}),
          url: capture.url,
          viewport,
          selector: args.selector ?? '',
          artifacts: { shot: artifactPath(runDir, capture.path) },
        });
      }

      return {
        path: capture.path,
        width: capture.width,
        height: capture.height,
        dpr: capture.dpr,
        cssWidth: capture.cssWidth,
        cssHeight: capture.cssHeight,
        fullPage: capture.fullPage,
        selector: capture.selector,
        url: capture.url,
        title: capture.title,
        channel: capture.channel,
        run: runDir ?? '',
        profile: profileResult?.profile?.id ?? '',
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'ui_diff',
    description: [
      '对比设计稿与截图：等比缩放到设计稿画布后逐像素比较，返回还原度 score、差异率、',
      '差异区域列表、热力图与左右对照图路径。threshold 是允许的差异率（默认取 1-档案 score，否则 0.01）。',
      '同时计算风格指标（色板/明度/饱和/边缘密度/填充率/风格分），只作证据，不改变 pass 判定。',
    ].join(''),
    parameters: {
      design: { type: 'string', required: true, description: '设计稿 PNG 路径' },
      shot: { type: 'string', required: true, description: '截图 PNG 路径' },
      threshold: { type: 'number', description: '允许的最大差异率（0-1，默认 0.01 或 1-档案 thresholds.score）' },
      tolerance: { type: 'number', description: '单像素容差（0-255，默认 config.tolerance=24）' },
      profile: { type: 'string', description: '项目档案 id 或 JSON 路径（取阈值与设计源）' },
      run: { type: 'string', description: '本次运行的目录；给定时产物写入 run 目录并追加分数历史' },
      out: { type: 'string', description: '产物目录；未给 run 时默认与截图同目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          score: { type: 'number', required: true },
          diffRatio: { type: 'number', required: true },
          regions: { type: 'array', required: true, items: REGION_SCHEMA() },
          diffPath: { type: 'string', required: true },
          sideBySidePath: { type: 'string', required: true },
          sizeMismatch: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              design: SIZE_SCHEMA(),
              shot: SIZE_SCHEMA(),
              rescaled: SIZE_SCHEMA(),
              offset: {
                type: 'object',
                additionalProperties: false,
                properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } },
              },
              aspectDelta: { type: 'number', required: true },
              mismatch: { type: 'boolean', required: true },
            },
          },
          scale: { type: 'number', required: true },
          canvas: { type: 'object', additionalProperties: false, properties: SIZE_SCHEMA().properties },
          style: STYLE_SCHEMA(),
          mismatchPixels: { type: 'integer' },
          totalPixels: { type: 'integer' },
          diffJsonPath: { type: 'string' },
          threshold: { type: 'number' },
          tolerance: { type: 'number' },
          pass: { type: 'boolean' },
          run: { type: 'string' },
          profile: { type: 'string' },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      const cwd = workspaceCwd(exec);
      const profileResult = loadProfileSafe(args.profile, { cwd, profileDir: config.profileDir });
      const designPath = resolveWorkspacePath(cwd, args.design);
      const shotPath = resolveWorkspacePath(cwd, args.shot);
      assertFile(designPath, '设计稿');
      assertFile(shotPath, '截图');

      const runDir = args.run ? resolveRunDir({ cwd, runRoot: config.runRoot, run: args.run }) : undefined;
      const outDir = args.out
        ? ensureDir(resolveWorkspacePath(cwd, args.out))
        : runDir ?? dirname(shotPath);

      const profileThreshold = profileResult?.profile?.thresholds?.score;
      const threshold = Number.isFinite(args.threshold)
        ? args.threshold
        : Number.isFinite(profileThreshold)
          ? Number((1 - profileThreshold).toFixed(4))
          : 0.01;

      const designBuffer = readFileSync(designPath);
      const shotBuffer = readFileSync(shotPath);
      const result = impl.diffImages(designBuffer, shotBuffer, {
        tolerance: Number.isFinite(args.tolerance) ? args.tolerance : config.tolerance,
        threshold,
      });

      // 风格指标只作证据：独立于 diff 判定计算，不参与 pass/threshold 语义。
      const referenceStyle = impl.analyzeStyle(designBuffer);
      const outputStyle = impl.analyzeStyle(shotBuffer);
      const styleComparison = impl.compareStyleAnalyses(referenceStyle, outputStyle, { locale: config.locale });
      const style = {
        score: styleComparison.score,
        deltas: styleComparison.deltas,
        notes: styleComparison.notes,
        reference: referenceStyle,
        output: outputStyle,
      };

      const diffPath = join(outDir, 'diff.png');
      const sideBySidePath = join(outDir, 'side-by-side.png');
      writeFileSync(diffPath, result.diffPng);
      writeFileSync(sideBySidePath, result.sideBySidePng);

      const payload = {
        tool: name,
        version: TOOL_VERSION,
        generatedAt: new Date().toISOString(),
        design: { path: designPath, size: sizeOfFile(designPath) },
        shot: { path: shotPath, size: sizeOfFile(shotPath) },
        canvas: result.canvas,
        score: result.score,
        diffRatio: result.diffRatio,
        mismatchPixels: result.mismatchPixels,
        totalPixels: result.totalPixels,
        regions: result.regions,
        droppedRegions: result.droppedRegions,
        scale: result.scale,
        sizeMismatch: result.sizeMismatch,
        style,
        threshold: result.threshold,
        tolerance: result.tolerance,
        pass: result.pass,
        profile: profileSummary(profileResult),
      };
      const diffJsonPath = join(outDir, 'diff.json');
      writeJsonFile(diffJsonPath, payload);

      if (runDir) {
        const history = appendHistory(runDir, {
          round: 0,
          score: result.score,
          diffRatio: result.diffRatio,
          pass: result.pass,
          threshold: result.threshold,
        }).map((entry, index) => ({ ...entry, round: index + 1 }));
        mergeMeta(runDir, {
          // 只有知道档案设计源时才改 mode；否则保留 ui_capture 写入的模式。
          ...(profileResult ? { mode: profileMode(profileResult), profile: profileSummary(profileResult) } : {}),
          // 差异画布尺寸单独记录，不能覆盖 capture/probe 写入的「本次视口」。
          canvas: { width: result.canvas.width, height: result.canvas.height },
          style,
          profile: profileSummary(profileResult),
          thresholds: { score: Number((1 - threshold).toFixed(4)) },
          artifacts: {
            design: artifactPath(runDir, designPath),
            shot: artifactPath(runDir, shotPath),
            diff: artifactPath(runDir, diffPath),
            sideBySide: artifactPath(runDir, sideBySidePath),
            diffJson: artifactPath(runDir, diffJsonPath),
          },
          history,
        });
      }

      return {
        score: result.score,
        diffRatio: result.diffRatio,
        regions: result.regions,
        diffPath,
        sideBySidePath,
        sizeMismatch: result.sizeMismatch,
        scale: result.scale,
        canvas: result.canvas,
        style,
        mismatchPixels: result.mismatchPixels,
        totalPixels: result.totalPixels,
        diffJsonPath,
        threshold: result.threshold,
        tolerance: result.tolerance,
        pass: result.pass,
        run: runDir ?? '',
        profile: profileResult?.profile?.id ?? '',
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'ui_probe',
    description: [
      '样式探针。不给 expected：检查横向溢出、硬编码颜色、字号/间距分布、图片缺 alt、',
      '缺可见焦点、可疑空态；给 expected（ui-spec JSON 路径或对象）：按契约逐属性对比',
      'getComputedStyle，返回 {property, expected, actual, delta, severity}，非法字段直接报错。',
    ].join(''),
    parameters: {
      url: { type: 'string', required: true, description: '页面地址；支持 http(s)、file:// 以及工作区内的相对路径' },
      expected: { type: 'json', description: 'ui-spec：JSON 文件路径、内联 JSON 字符串或对象；省略则走审计模式' },
      profile: { type: 'string', description: '项目档案 id 或 JSON 路径' },
      width: { type: 'integer', description: '视口宽度（默认档案 devices[0] 或 ui-spec.viewport）' },
      height: { type: 'integer', description: '视口高度（默认档案 devices[0] 或 ui-spec.viewport）' },
      dpr: { type: 'number', description: '设备像素比' },
      selector: { type: 'string', description: '审计模式的采集范围（CSS 选择器，默认整页）' },
      run: { type: 'string', description: '本次运行的目录；给定时结果写入 run 目录 probe.json' },
      out: { type: 'string', description: '结果 JSON 路径；缺省 run 目录 probe.json' },
      waitMs: { type: 'integer', description: '加载后额外等待毫秒数' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          url: { type: 'string', required: true },
          path: { type: 'string', required: true },
          viewport: { type: 'object', required: true, additionalProperties: false, properties: VIEWPORT_SCHEMA().properties },
          summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              total: { type: 'integer' },
              passed: { type: 'integer' },
              failed: { type: 'integer' },
              high: { type: 'integer' },
              medium: { type: 'integer' },
              low: { type: 'integer' },
              selectorMisses: { type: 'integer' },
            },
          },
          checks: { type: 'array', items: CHECK_SCHEMA() },
          issues: { type: 'array', items: ISSUE_SCHEMA() },
          selectorMisses: { type: 'array', items: MISS_SCHEMA() },
          audit: {
            type: 'object',
            additionalProperties: false,
            properties: {
              elementsScanned: { type: 'integer' },
              truncated: { type: 'boolean' },
              palette: { type: 'array', items: PAIR_SCHEMA() },
              fontSizes: { type: 'array', items: PAIR_SCHEMA() },
              spacing: { type: 'array', items: PAIR_SCHEMA() },
              imagesWithoutAlt: { type: 'integer' },
              focusRisks: { type: 'integer' },
              emptyStates: { type: 'integer' },
              hardcodedColors: { type: 'integer' },
              overflow: { type: 'integer' },
              horizontalScroll: { type: 'boolean' },
            },
          },
          spec: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              elements: { type: 'integer' },
            },
          },
          profile: { type: 'string' },
          run: { type: 'string' },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      const cwd = workspaceCwd(exec);
      const profileResult = loadProfileSafe(args.profile, { cwd, profileDir: config.profileDir });
      const device = primaryDevice(profileResult?.profile);

      // 只解析一次：来源路径作为独立 specPath 传递，绝不写回 spec 本体。
      let specInput;
      if (args.expected !== undefined && args.expected !== null && args.expected !== '') {
        specInput = readSpecSource(args.expected, { cwd });
      }
      const spec = specInput?.spec;
      const width = Number.isFinite(args.width) ? args.width : spec?.viewport?.width ?? device.width;
      const height = Number.isFinite(args.height) ? args.height : spec?.viewport?.height ?? device.height;
      const dpr = Number.isFinite(args.dpr) && args.dpr > 0 ? args.dpr : spec?.viewport?.dpr ?? device.dpr ?? 1;

      const runDir = args.run ? resolveRunDir({ cwd, runRoot: config.runRoot, run: args.run }) : undefined;
      const result = await impl.runProbe({
        config,
        cwd,
        url: args.url,
        width,
        height,
        dpr,
        selector: args.selector,
        spec,
        specPath: specInput?.sourcePath,
        waitMs: args.waitMs,
      });

      const outPath = args.out
        ? resolveWorkspacePath(cwd, args.out)
        : join(runDir ?? defaultRunDir(cwd, config.runRoot), 'probe.json');
      const payload = {
        tool: name,
        version: TOOL_VERSION,
        generatedAt: new Date().toISOString(),
        profile: profileSummary(profileResult),
        ...result,
      };
      writeJsonFile(outPath, payload);

      if (runDir) {
        mergeMeta(runDir, {
          ...(profileResult ? { mode: profileMode(profileResult), profile: profileSummary(profileResult) } : {}),
          url: result.url,
          viewport: result.viewport,
          artifacts: { probeJson: artifactPath(runDir, outPath) },
          probeMode: result.mode,
          probeSummary: result.summary,
        });
      }

      const output = {
        mode: result.mode,
        url: result.url,
        path: outPath,
        viewport: result.viewport,
        summary: result.summary,
        profile: profileResult?.profile?.id ?? '',
        run: runDir ?? '',
      };
      if (result.checks) output.checks = result.checks;
      if (result.issues) output.issues = result.issues;
      if (result.selectorMisses) output.selectorMisses = result.selectorMisses;
      if (result.audit) output.audit = result.audit;
      if (result.spec) output.spec = { name: result.spec.name, path: result.spec.path, elements: result.spec.elements };
      return output;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'ui_report',
    description: [
      '生成验收报告：report.md（给人和 agent 引用）与 report.html（单文件、无外链、无 CDN、',
      '无 JavaScript，可直接双击打开且自适应宽度）。HTML 含概览卡片、内联 SVG 分数曲线、',
      '设计图/截图/热力图三图并排、风格指标、差异区域、属性差异表、修复清单与夹具声明。',
      '输入可以是 run 目录，也可以显式指定本次产物路径。',
    ].join(''),
    parameters: {
      run: { type: 'string', description: '本次运行的目录；自动发现 meta.json、shot/design/diff PNG、diff.json、probe.json' },
      design: { type: 'string', description: '设计稿 PNG 路径（没有设计稿时省略）' },
      shot: { type: 'string', description: '截图 PNG 路径' },
      diffPath: { type: 'string', description: '差异热力图 PNG 路径' },
      diffJson: { type: 'string', description: 'ui_diff 生成的 diff.json 路径' },
      probePath: { type: 'string', description: 'ui_probe 生成的 probe.json 路径' },
      out: { type: 'string', description: '报告输出目录；缺省为 run 目录或截图所在目录' },
      title: { type: 'string', description: '报告标题' },
      mode: { type: 'string', description: 'design | none（缺省按是否有设计图推断）' },
      profile: { type: 'string', description: '项目档案 id 或 JSON 路径（补充夹具声明）' },
      locale: { type: 'string', description: '报告语言：zh | en' },
      threshold: { type: 'number', description: '判定合格线（覆盖率 0-1，默认取档案 thresholds.score）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          markdownPath: { type: 'string', required: true },
          htmlPath: { type: 'string', required: true },
          outDir: { type: 'string', required: true },
          summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              score: { type: 'number' },
              diffRatio: { type: 'number' },
              regions: { type: 'integer', required: true },
              rounds: { type: 'integer', required: true },
              mode: { type: 'string', required: true },
              designSource: { type: 'string', required: true },
              fixes: { type: 'integer', required: true },
              pass: { type: 'boolean' },
            },
          },
        },
      },
      render: textRender,
    },
    async execute(args, exec) {
      const cwd = workspaceCwd(exec);
      const profileResult = loadProfileSafe(args.profile, { cwd, profileDir: config.profileDir });
      const report = impl.buildReport({
        cwd,
        config,
        run: args.run,
        design: args.design,
        shot: args.shot,
        diffPath: args.diffPath,
        diffJson: args.diffJson,
        probePath: args.probePath,
        out: args.out,
        title: args.title,
        mode: args.mode,
        locale: args.locale,
        threshold: args.threshold,
        profile: profileSummary(profileResult),
      });
      const { summary } = report;
      const outputSummary = {
        regions: summary.regions,
        rounds: summary.rounds,
        mode: summary.mode,
        designSource: summary.designSource,
        fixes: summary.fixes,
      };
      if (typeof summary.score === 'number') outputSummary.score = summary.score;
      if (typeof summary.diffRatio === 'number') outputSummary.diffRatio = summary.diffRatio;
      if (typeof summary.pass === 'boolean') outputSummary.pass = summary.pass;
      return {
        markdownPath: report.markdownPath,
        htmlPath: report.htmlPath,
        outDir: report.outDir,
        summary: outputSummary,
      };
    },
  }));
}
