#!/usr/bin/env node
/**
 * dsh-ui-restore 自测
 *
 * 默认跑「核心集」：PNG 编解码、像素差异与定位、ui-spec 校验与比较、档案默认值、
 * 报告生成（含静态 HTML 的硬约束），以及用假 launcher/page 注入覆盖浏览器层
 * （capturePage / withPage / runProbe），全部不需要浏览器。
 *
 * 加 --browser 跑「浏览器集」：真实截图、同图自比、改一处后定位、探针两种模式、
 * 报告在真实浏览器里打开并检查三图与差异表。
 *
 * 产物默认写在系统临时目录（<tmp>/dsh-ui-restore-selftest-*），不污染工作区；
 * 用 --out <dir> 指定目录，用 --keep 保留临时目录（默认也保留，方便取证）。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodePng, diffImages, encodePng, readPngSize } from '../lib/diff.js';
import { analyzeStyle, compareStyles } from '../lib/style.js';
import { UiSpecError, compareElementStyles, readSpecSource, validateSpec } from '../lib/spec.js';
import { DEFAULT_PROFILE, loadProfile, normalizeProfile } from '../lib/profile.js';
import { buildReport } from '../lib/report.js';
import { auditExpressionSource, buildAuditResult, buildSpecResult, runProbe } from '../lib/probe.js';
import { capturePage, launchBrowser, withPage } from '../lib/browser.js';
import { ensureDir, mergeMeta, profileSummary, readMeta, writeJsonFile } from '../lib/paths.js';
import { SKILL_FILE, readBundledSkill, registerBundledSkill } from '../lib/skill.js';
import {
  ENDPOINT_ENV,
  buildUiSpec,
  collectTreeNodes,
  convert as convertPaper,
  extractToolPayload,
  filterStyles,
  main as paperMain,
  parseArgs as parsePaperArgs,
  parseMcpBody,
  resolveEndpoint,
  toUiSpecPropertyName,
} from '../scripts/paper-to-ui-spec.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const withBrowser = argv.includes('--browser') || process.env.DSH_UI_RESTORE_SELFTEST_BROWSER === '1';
const outIndex = argv.indexOf('--out');
const baseDir = outIndex >= 0 && argv[outIndex + 1]
  ? resolve(process.cwd(), argv[outIndex + 1])
  : mkdtempSync(join(tmpdir(), 'dsh-ui-restore-selftest-'));

const results = [];
let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function assertClose(actual, expected, epsilon, message) {
  if (!(Math.abs(actual - expected) <= epsilon)) {
    throw new Error(`${message}（期望 ${expected} ± ${epsilon}，实际 ${actual}）`);
  }
}

function assertThrows(fn, pattern, message) {
  let error;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error(`${message}：没有抛错`);
  if (pattern && !pattern.test(String(error.message))) {
    throw new Error(`${message}：错误信息不匹配 ${pattern}；实际：${error.message}`);
  }
  return error;
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push({ name, status: 'PASS' });
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    results.push({ name, status: 'FAIL', error: error.message });
    console.log(`FAIL  ${name}`);
    console.log(`      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

function skip(name, reason) {
  skipped += 1;
  results.push({ name, status: 'SKIP', reason });
  console.log(`SKIP  ${name}（${reason}）`);
}

// ---------------------------------------------------------------- 夹具工具

function canvas(width, height, fill = [255, 255, 255, 255]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = fill[0];
    rgba[index * 4 + 1] = fill[1];
    rgba[index * 4 + 2] = fill[2];
    rgba[index * 4 + 3] = fill[3];
  }
  return rgba;
}

function fillRect(rgba, width, rect, color) {
  const { x, y, w, h } = rect;
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      const target = (py * width + px) * 4;
      rgba[target] = color[0];
      rgba[target + 1] = color[1];
      rgba[target + 2] = color[2];
      rgba[target + 3] = color[3] ?? 255;
    }
  }
}

function makeDemoPng({ width = 200, height = 120, rect = { x: 20, y: 20, w: 60, h: 30 }, color = [37, 99, 235, 255] } = {}) {
  const rgba = canvas(width, height);
  if (rect) fillRect(rgba, width, rect, color);
  return encodePng({ width, height, rgba });
}

function writePng(file, buffer) {
  writeFileSync(file, buffer);
  return file;
}

const pngBytes = (file) => readFileSync(file);

// ---------------------------------------------------------------- 假浏览器（核心集）

/**
 * 注入式假浏览器：launcher → fake browser → fake page。
 * 让浏览器层（capturePage / withPage / runProbe）的核心逻辑在无浏览器环境也能测。
 * 这正是 t8 的教训：`channel is not defined` 只有真实浏览器才暴露。
 */
function createFakeBrowser(options = {}) {
  const state = {
    launchCalls: 0,
    closed: 0,
    newPageCalls: 0,
    contexts: [],
    gotoCalls: [],
    screenshotCalls: [],
    evaluateCalls: [],
  };
  const shotSize = options.shotSize ?? { width: 400, height: 300 };
  const fill = options.fill ?? [240, 240, 240, 255];
  const page = {
    url: () => options.pageUrl ?? 'file:///fake/index.html',
    title: async () => options.title ?? 'fake page',
    goto: async (target) => {
      state.gotoCalls.push(target);
      return { status: () => 200 };
    },
    waitForLoadState: async () => {},
    emulateMedia: async () => {},
    addStyleTag: async () => {},
    waitForTimeout: async () => {},
    screenshot: async ({ path, fullPage } = {}) => {
      state.screenshotCalls.push({ path, fullPage: fullPage === true, mode: 'page' });
      writeFileSync(path, encodePng({ width: shotSize.width, height: shotSize.height, rgba: canvas(shotSize.width, shotSize.height, fill) }));
    },
    locator: (selector) => ({
      first: () => ({
        count: async () => (options.selectorMissing === true ? 0 : 1),
        screenshot: async ({ path }) => {
          state.screenshotCalls.push({ path, selector, mode: 'element' });
          const size = options.elementSize ?? { width: 100, height: 40 };
          writeFileSync(path, encodePng({ width: size.width, height: size.height, rgba: canvas(size.width, size.height, fill) }));
        },
      }),
    }),
    evaluate: async (fn, arg) => {
      state.evaluateCalls.push({ fnName: fn?.name ?? '', arg });
      return typeof options.evaluate === 'function' ? options.evaluate(arg) : options.evaluate;
    },
  };
  const launcher = async () => {
    state.launchCalls += 1;
    const browser = {
      newContext: async (contextOptions) => {
        state.contexts.push(contextOptions);
        return {
          newPage: async () => {
            state.newPageCalls += 1;
            return page;
          },
          close: async () => {},
        };
      },
      close: async () => {
        state.closed += 1;
      },
    };
    return { browser, channel: options.channel ?? 'fake-channel' };
  };
  return { launcher, page, state };
}


// ---------------------------------------------------------------- 工具入口 harness

/**
 * 把 lib/ 复制到临时目录并注入最小 @deepseek-ai 桩，让「没有 DSH 依赖、没有浏览器」
 * 的构建区也能直接调用 apply() 注册出来的 execute。
 * 这条路径正是 t3 指出的缺口：以前 selftest 只直调 runProbe，绕过了工具入口。
 */
async function loadToolEntryHarness() {
  const dir = join(baseDir, 'tool-entry-harness');
  const libDir = join(dir, 'lib');
  cpSync(fileURLToPath(new URL('../lib', import.meta.url)), libDir, { recursive: true });
  // 技能自动注册会按 PLUGIN_ROOT 读 skills/，所以复制时要带包内技能目录。
  cpSync(fileURLToPath(new URL('../skills', import.meta.url)), join(dir, 'skills'), { recursive: true });
  // 报告的标签来自 locale/；复制后工具入口 harness 的报告输出与真实插件一致。
  cpSync(fileURLToPath(new URL('../locale', import.meta.url)), join(dir, 'locale'), { recursive: true });
  writeModuleStub(
    join(dir, 'node_modules', '@deepseek-ai', 'schemastery'),
    'index.mjs',
    'const chain = () => { const node = {}; node.default = () => node; node.description = () => node; node.required = () => node; return node; };\n'
    + 'export default { object: chain, string: chain, number: chain, array: chain, boolean: chain };\n',
  );
  writeModuleStub(
    join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools'),
    'index.mjs',
    'export const defineTool = (options) => options;\n',
  );
  return import(pathToFileURL(join(libDir, 'index.js')).href);
}

function writeModuleStub(dir, entry, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'selftest-stub', type: 'module', exports: { '.': `./${entry}` } }), 'utf8');
  writeFileSync(join(dir, entry), body, 'utf8');
}

let toolEntryHarnessPromise;

function getToolEntryHarness() {
  toolEntryHarnessPromise ??= loadToolEntryHarness();
  return toolEntryHarnessPromise;
}

/** 用一组固定计算样式伪造一次契约探针，验证工具入口的编排（不启动浏览器）。 */
function fakeSpecProbeResult(options) {
  const spec = options.spec;
  const checks = [];
  for (const element of spec.elements) {
    for (const [property, expected] of Object.entries(element.properties)) {
      checks.push({
        selector: element.selector,
        label: element.label ?? '',
        property,
        expected: String(expected),
        actual: String(expected),
        delta: 0,
        deltaText: '',
        severity: 'pass',
        pass: true,
      });
    }
  }
  return {
    mode: 'spec',
    url: options.url,
    title: 'fake',
    viewport: { width: options.width, height: options.height, dpr: options.dpr },
    spec: {
      name: spec.name ?? '',
      path: options.specPath ?? '',
      elements: spec.elements.length,
      tolerance: spec.tolerance,
    },
    checks,
    selectorMisses: [],
    rects: {},
    summary: { total: checks.length, passed: checks.length, failed: 0, high: 0, medium: 0, low: 0, selectorMisses: 0 },
  };
}

// ---------------------------------------------------------------- 核心集

async function coreSuite() {
  await test('PNG 编解码往返一致（含 RGB/RGBA 通道与尺寸）', () => {
    const width = 64;
    const height = 48;
    const rgba = canvas(width, height, [12, 34, 56, 255]);
    for (let index = 0; index < width * height; index += 1) {
      rgba[index * 4] = index % 256;
      rgba[index * 4 + 1] = (index * 7) % 256;
      rgba[index * 4 + 2] = (index * 13) % 256;
    }
    const png = encodePng({ width, height, rgba });
    const size = readPngSize(png);
    assertEqual(size.width, width, 'PNG 宽度');
    assertEqual(size.height, height, 'PNG 高度');
    const decoded = decodePng(png);
    assertEqual(decoded.width, width, '解码宽度');
    assertEqual(decoded.height, height, '解码高度');
    for (let index = 0; index < width * height; index += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        if (decoded.rgba[index * 4 + channel] !== rgba[index * 4 + channel]) {
          throw new Error(`像素 ${index} 通道 ${channel} 不一致`);
        }
      }
    }
  });

  const designFile = writePng(join(baseDir, 'design.png'), makeDemoPng());

  await test('同一张图自比：score≈1 且没有差异区域', () => {
    const result = diffImages(pngBytes(designFile), pngBytes(designFile), { tolerance: 24, threshold: 0.01 });
    assertEqual(result.score, 1, '自比 score');
    assertEqual(result.diffRatio, 0, '自比 diffRatio');
    assertEqual(result.regions.length, 0, '自比区域数');
    assertEqual(result.pass, true, '自比 pass');
    assertEqual(result.sizeMismatch.mismatch, false, '自比尺寸不一致标记');
  });

  await test('改一处后能定位到该区域（区域包围盒与改动矩形重合）', () => {
    const changed = makeDemoPng({ color: [220, 38, 38, 255] });
    const result = diffImages(pngBytes(designFile), changed, { tolerance: 24, threshold: 0.01 });
    assert(result.score < 0.99, `改一处后 score 应明显下降，实际 ${result.score}`);
    assert(result.regions.length >= 1, '应至少有一个差异区域');
    const region = result.regions[0];
    assertClose(region.x, 20, 2, '区域左上角 x 应落在改动矩形上');
    assertClose(region.y, 20, 2, '区域左上角 y 应落在改动矩形上');
    assertClose(region.width, 60, 3, '区域宽度应接近改动矩形');
    assertClose(region.height, 30, 3, '区域高度应接近改动矩形');
    assertEqual(region.severity, 'high', '60x30 的差异区域应为高严重度');
    const diffSize = readPngSize(result.diffPng);
    assertEqual(diffSize.width, 200, '热力图宽度');
    assertEqual(diffSize.height, 120, '热力图高度');
    const sideSize = readPngSize(result.sideBySidePng);
    assertEqual(sideSize.width, 200 * 2 + 12, '左右对照图宽度含 12px 分隔');
    assertEqual(sideSize.height, 120, '左右对照图高度');
  });

  await test('尺寸不一致：2x 截图等比缩放后仍能对齐，比例不同会标记 sizeMismatch', () => {
    const rgba2x = canvas(400, 240);
    fillRect(rgba2x, 400, { x: 40, y: 40, w: 120, h: 60 }, [37, 99, 235, 255]);
    const shot2x = encodePng({ width: 400, height: 240, rgba: rgba2x });
    const scaled = diffImages(pngBytes(designFile), shot2x, { tolerance: 24, threshold: 0.01 });
    assertEqual(scaled.scale, 0.5, '2x 截图的缩放比应为 0.5');
    assertEqual(scaled.sizeMismatch.rescaled.width, 200, '缩放后宽度');
    assertEqual(scaled.sizeMismatch.rescaled.height, 120, '缩放后高度');
    assert(scaled.score >= 0.99, `等比缩放的同一内容 score 应接近 1，实际 ${scaled.score}`);
    assertEqual(scaled.sizeMismatch.mismatch, false, '等比缩放不应标记尺寸不一致');

    const wide = canvas(400, 120);
    fillRect(wide, 400, { x: 40, y: 20, w: 120, h: 30 }, [37, 99, 235, 255]);
    const wideShot = encodePng({ width: 400, height: 120, rgba: wide });
    const mismatched = diffImages(pngBytes(designFile), wideShot, { tolerance: 24, threshold: 0.01 });
    assertEqual(mismatched.sizeMismatch.mismatch, true, '比例不同应标记尺寸不一致');
    assert(mismatched.sizeMismatch.aspectDelta > 0.5, '比例差应可量化');
    assert(mismatched.score < 0.99, `比例不同 score 应下降，实际 ${mismatched.score}`);
    assert(mismatched.diffRatio > mismatched.threshold, '比例不同应判为超过阈值');
  });

  await test('风格指标：analyzeStyle 输出色板/明度/饱和/边缘密度/填充率与 bbox', () => {
    const png = makeDemoPng();
    const style = analyzeStyle(png);
    assertEqual(style.width, 200, '宽度');
    assertEqual(style.height, 120, '高度');
    assert(style.palette.length >= 2 && style.palette.length <= 8, `主色板应为 2..8 色，实际 ${style.palette.length}`);
    assertEqual(style.palette[0].color, '#ffffff', '白底应为第一主色');
    assertClose(style.palette[0].ratio, 1 - (60 * 30) / (200 * 120), 0.01, '白底占比');
    assertEqual(style.palette[1].color, '#2563eb', '蓝色块应为第二主色');
    assertEqual(style.background.color, '#ffffff', '背景色应单独识别为白色');
    assertClose(style.background.ratio, 1 - (60 * 30) / (200 * 120), 0.01, '背景占比');
    assertEqual(style.contentPalette.length, 1, '内容色板应只剩蓝色块');
    assertEqual(style.contentPalette[0].color, '#2563eb', '内容色板不应包含白底');
    assertEqual(style.contentPalette[0].ratio, 1, '内容色板在内容像素内归一');
    assert(Number.isInteger(style.colorCount) && style.colorCount >= 2, '颜色数应 ≥2');
    assert(style.flatRatio > 0.99, `主色覆盖率应接近 1，实际 ${style.flatRatio}`);
    assert(style.edgeDensity > 0 && style.edgeDensity < 0.1, `边缘密度应较小，实际 ${style.edgeDensity}`);
    assertClose(style.fillRatio, (60 * 30) / (200 * 120), 0.005, '填充率应接近矩形占比');
    assertEqual(style.bbox.x, 20, 'bbox.x');
    assertEqual(style.bbox.y, 20, 'bbox.y');
    assertEqual(style.bbox.width, 60, 'bbox.width');
    assertEqual(style.bbox.height, 30, 'bbox.height');
    assert(style.meanLuma > 0.8 && style.meanLuma <= 1, `白底平均明度应偏高，实际 ${style.meanLuma}`);
    assert(style.meanSat > 0 && style.meanSat < 0.2, `白底平均饱和度应偏低，实际 ${style.meanSat}`);

    const again = analyzeStyle(png);
    assertEqual(JSON.stringify(again), JSON.stringify(style), '同图分析应稳定（纯函数）');
  });

  await test('风格指标：compareStyles 同图高分，不同色板/边缘密度可区分', () => {
    const basePng = makeDemoPng();
    const same = compareStyles(basePng, basePng);
    assertEqual(same.score, 1, '同图风格分应为 1');
    assertEqual(same.deltas.paletteDistance, 0, '同图色板距离为 0');
    assert(same.notes.length >= 1, '应有风格说明');

    const darkRgba = canvas(200, 120, [15, 23, 42, 255]);
    fillRect(darkRgba, 200, { x: 20, y: 20, w: 60, h: 30 }, [249, 115, 22, 255]);
    const darkPng = encodePng({ width: 200, height: 120, rgba: darkRgba });
    const different = compareStyles(basePng, darkPng);
    assert(different.score < 0.8, `不同色板/明度风格分应明显下降，实际 ${different.score}`);
    assert(different.deltas.paletteDistance > 0.5, `色板距离应明显，实际 ${different.deltas.paletteDistance}`);
    assert(different.deltas.luma > 0.5, `明度差应明显，实际 ${different.deltas.luma}`);
    assert(different.notes.some((note) => note.includes('色板')), '应给出色板说明');

    const flatPng = encodePng({ width: 200, height: 120, rgba: canvas(200, 120) });
    const stripedRgba = canvas(200, 120);
    for (let x = 0; x < 200; x += 10) fillRect(stripedRgba, 200, { x, y: 0, w: 5, h: 120 }, [15, 23, 42, 255]);
    const stripedPng = encodePng({ width: 200, height: 120, rgba: stripedRgba });
    const flatStyle = analyzeStyle(flatPng);
    const stripedStyle = analyzeStyle(stripedPng);
    assert(stripedStyle.edgeDensity > flatStyle.edgeDensity + 0.1, `条纹图边缘密度应更高，实际 ${stripedStyle.edgeDensity} vs ${flatStyle.edgeDensity}`);
    assert(stripedStyle.fillRatio > 0.4, `条纹图填充率应明显，实际 ${stripedStyle.fillRatio}`);
    const edgeCompare = compareStyles(flatPng, stripedPng);
    assert(edgeCompare.deltas.edgeDensity > 0.1, `边缘密度差应可量化，实际 ${edgeCompare.deltas.edgeDensity}`);
    assert(edgeCompare.score < same.score, '边缘密度不同也应降低风格分');
    assertEqual(flatStyle.fillRatio, 0, '纯色图没有内容像素');
    assertEqual(flatStyle.bbox.width, 0, '纯色图 bbox 宽应为 0');
    assertEqual(flatStyle.bbox.height, 0, '纯色图 bbox 高应为 0');

    // 灰底 vs 暖底：背景色单独比较，不能被「内容色板相同」稀释。
    const makeBgPng = (background) => {
      const rgba = canvas(200, 120, background);
      fillRect(rgba, 200, { x: 20, y: 20, w: 60, h: 30 }, [37, 99, 235, 255]);
      return encodePng({ width: 200, height: 120, rgba });
    };
    const backgroundCompare = compareStyles(makeBgPng([250, 247, 242, 255]), makeBgPng([128, 128, 128, 255]));
    assert(backgroundCompare.deltas.paletteDistance > 0.3, `灰底 vs 暖底色板距离应显著，实际 ${backgroundCompare.deltas.paletteDistance}`);
    assert(backgroundCompare.score < 0.9, `灰底 vs 暖底风格分应下降，实际 ${backgroundCompare.score}`);
  });

  await test('风格指标区分度：真实资产 v2 自比/灰度/红蓝互换/跨版本排序', () => {
    const fixtureDir = join(ROOT, 'scripts', 'fixtures', 'style');
    const v0 = readFileSync(join(fixtureDir, 'v0-page1.png'));
    const v1 = readFileSync(join(fixtureDir, 'v1-page1.png'));
    const v2p1 = readFileSync(join(fixtureDir, 'v2-page1.png'));
    const v2p2 = readFileSync(join(fixtureDir, 'v2-page2.png'));

    // 真实资产派生：灰度化 / 红蓝通道互换（只改像素，不新增夹具文件）。
    const decoded = decodePng(v2p1);
    const grayRgba = new Uint8Array(decoded.rgba.length);
    const swapRgba = new Uint8Array(decoded.rgba);
    for (let index = 0; index < decoded.width * decoded.height; index += 1) {
      const offset = index * 4;
      const value = Math.round(decoded.rgba[offset] * 0.299 + decoded.rgba[offset + 1] * 0.587 + decoded.rgba[offset + 2] * 0.114);
      grayRgba[offset] = value;
      grayRgba[offset + 1] = value;
      grayRgba[offset + 2] = value;
      grayRgba[offset + 3] = decoded.rgba[offset + 3];
      swapRgba[offset] = decoded.rgba[offset + 2];
      swapRgba[offset + 1] = decoded.rgba[offset + 1];
      swapRgba[offset + 2] = decoded.rgba[offset];
      swapRgba[offset + 3] = decoded.rgba[offset + 3];
    }
    const grayPng = encodePng({ width: decoded.width, height: decoded.height, rgba: grayRgba });
    const swapPng = encodePng({ width: decoded.width, height: decoded.height, rgba: swapRgba });

    const self = compareStyles(v2p1, v2p1);
    const crossPage = compareStyles(v2p1, v2p2);
    const v1v2 = compareStyles(v1, v2p1);
    const v0v2 = compareStyles(v0, v2p1);
    const gray = compareStyles(v2p1, grayPng);
    const swap = compareStyles(v2p1, swapPng);

    // 校准阈值：需求来自 t2 验收（v1/v2 区分度）。
    assert(self.score >= 0.99, `v2 自比应 ≥0.99，实际 ${self.score}`);
    assert(v1v2.score <= 0.90, `v1 vs v2 应 ≤0.90，实际 ${v1v2.score}`);
    assert(v1v2.score < crossPage.score - 0.03, `v1 vs v2 应明显低于同版本跨页（v1v2=${v1v2.score}，cross=${crossPage.score}）`);
    assert(gray.score <= 0.85, `v2 灰度化应 ≤0.85，实际 ${gray.score}`);
    assert(swap.score <= 0.90, `v2 红蓝互换应 ≤0.90，实际 ${swap.score}`);
    assert(v0v2.score <= 0.90 && v0v2.score < v1v2.score, `v0 vs v2 应低于 v1 vs v2（v0v2=${v0v2.score}，v1v2=${v1v2.score}）`);

    // 色板度量的可解释性：不能只靠白底，内容色板必须贡献差异。
    assert(v1v2.deltas.paletteDistance > 0.18, `v1 vs v2 色板距离应显著，实际 ${v1v2.deltas.paletteDistance}`);
    assert(gray.deltas.paletteDistance > 0.2, `灰度化色板距离应显著，实际 ${gray.deltas.paletteDistance}`);
    assert(swap.deltas.paletteDistance > 0.2, `红蓝互换色板距离应显著，实际 ${swap.deltas.paletteDistance}`);
    assert(!v1v2.notes.some((note) => note.includes('配色和参考接近')), 'v1 vs v2 不应误报「配色接近」');
    assert(v1v2.notes.some((note) => note.includes('差异明显')), 'v1 vs v2 应提示色板差异明显');

    const analysis = analyzeStyle(v2p1);
    assertEqual(analysis.background.color, '#ffffff', '真实资产背景应为白色');
    assert(analysis.contentPalette.length > 0 && analysis.contentPalette.length <= 16, '内容色板应有 1..16 色');
    assert(analysis.contentPalette[0].color !== '#ffffff', '内容色板不应被白底占满');
    const whiteShare = analysis.contentPalette
      .filter((entry) => entry.color === '#ffffff' || entry.color === '#fefefe')
      .reduce((sum, entry) => sum + entry.ratio, 0);
    assert(whiteShare < 0.05, `内容色板中纯白占比应接近 0，实际 ${whiteShare}`);
  });

  await test('ui-spec 校验：合法契约通过，非法属性/颜色/顶层字段报错', () => {
    const spec = validateSpec({
      version: 1,
      elements: [{ selector: '.btn', properties: { backgroundColor: '#2563eb', fontSize: '14px', fontWeight: 600 } }],
    });
    assertEqual(spec.elements.length, 1, '合法契约元素数');
    assertEqual(spec.tolerance.length, 0.5, '缺省长度容差');

    let error;
    try {
      validateSpec({ elements: [{ selector: '.btn', properties: { widht: '10px' } }] });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof UiSpecError, '非法属性应抛 UiSpecError');
    assert(/widht/.test(error.message), `错误信息应包含非法属性名；实际：${error.message}`);
    assert(/不是受支持的属性/.test(error.message), '错误信息应说明属性不受支持');

    assertThrows(() => validateSpec({ elements: [{ selector: '.x', properties: { color: 'not-a-color' } }] }), /not-a-color/, '非法颜色');
    assertThrows(() => validateSpec({ elements: [], extra: true }), /未知字段/, '未知顶层字段');
    assertThrows(() => validateSpec({ elements: [{ selector: '', properties: { color: '#fff' } }] }), /selector/, '空选择器');
  });

  await test('属性比较：expected/actual/delta/severity 正确', () => {
    const checks = compareElementStyles(
      {
        selector: '.btn-primary',
        label: '主操作',
        properties: {
          backgroundColor: '#2563eb',
          fontSize: '20px',
          paddingTop: 16,
          display: 'flex',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
        },
      },
      {
        backgroundColor: 'rgb(220, 38, 38)',
        fontSize: '30px',
        paddingTop: '16px',
        display: 'block',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
      },
      { length: 0.5, number: 0.01, color: 0 },
    );
    const byProperty = Object.fromEntries(checks.map((check) => [check.property, check]));
    assertEqual(byProperty.backgroundColor.pass, false, '颜色应不通过');
    assertEqual(byProperty.backgroundColor.severity, 'high', '颜色差异大应为 high');
    assert(byProperty.backgroundColor.delta > 100, '颜色 delta 应是通道最大差');
    assertEqual(byProperty.fontSize.pass, false, '字号应不通过');
    assertEqual(byProperty.fontSize.severity, 'high', '10px 字号差应为 high');
    assertEqual(byProperty.fontSize.delta, 10, '字号 delta');
    assertEqual(byProperty.paddingTop.pass, true, '相同内边距应通过');
    assertEqual(byProperty.paddingTop.severity, 'pass', '通过项 severity=pass');
    assertEqual(byProperty.display.severity, 'high', '布局关键字不匹配应为 high');
    assertEqual(byProperty.boxShadow.pass, true, '归一化后相同的阴影应通过');
  });

  await test('ui-spec 非法 expected 在启动浏览器前就报错（fail fast）', async () => {
    let error;
    try {
      await runProbe({
        config: {},
        url: 'about:blank',
        expected: { elements: [{ selector: '.x', properties: { widht: 1 } }] },
      });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof UiSpecError, `应抛 UiSpecError，实际 ${error?.name}: ${error?.message}`);
    assert(/widht/.test(error.message), '错误信息应包含非法字段');
  });

  await test('探针结论：审计原始数据 → 问题分级；契约原始数据 → 属性差异', () => {
    const audit = buildAuditResult({
      title: 'demo',
      url: 'file:///demo.html',
      viewport: { innerWidth: 1000, innerHeight: 800, scrollWidth: 1200, scrollHeight: 900, horizontalScroll: true },
      elementsScanned: 42,
      truncated: false,
      overflow: [{ selector: '.box', tag: 'div', axis: 'x', scrollWidth: 1200, clientWidth: 1000, scrollHeight: 10, clientHeight: 10, overflowX: 200, overflowY: 0 }],
      outsideViewport: [{ selector: '.wide', tag: 'div', left: 0, right: 1200, width: 1200, viewportWidth: 1000 }],
      palette: [{ value: 'rgb(15, 23, 42)', count: 12 }],
      fontSizes: [{ value: '9px', count: 2 }],
      spacing: [],
      hardcodedColors: [{ selector: '.x', inline: 'color:#ff0000' }],
      imagesWithoutAlt: [{ selector: 'img', src: 'asset.svg' }],
      focusRisks: [{ selector: 'button', outline: 'none 3px', boxShadow: 'none' }],
      emptyStates: [{ selector: '.e', width: 300, height: 200, area: 60000 }],
    }, { width: 1000, height: 800, dpr: 1 });
    const kinds = new Set(audit.issues.map((issue) => issue.kind));
    for (const kind of ['overflow', 'alt', 'focus', 'empty', 'hardcoded']) {
      assert(kinds.has(kind), `应产出 ${kind} 类问题`);
    }
    assert(audit.summary.high >= 2, '横向滚动与越出视口应为高严重度');
    assertEqual(audit.audit.fontSizes[0].value, '9px', '字号分布应保留');

    const spec = validateSpec({
      elements: [
        { selector: '.a', properties: { fontSize: '14px' } },
        { selector: '.missing', properties: { color: '#ffffff' } },
      ],
    });
    const specResult = buildSpecResult({
      url: 'file:///demo.html',
      title: 'demo',
      entries: [
        { selector: '.a', found: true, styles: { fontSize: '16px' }, rect: { x: 0, y: 0, width: 10, height: 10 } },
        { selector: '.missing', found: false, styles: {} },
      ],
    }, spec, { width: 1000, height: 800, dpr: 1 });
    assertEqual(specResult.mode, 'spec', '模式应为 spec');
    assertEqual(specResult.summary.failed, 1, '应有一个属性失败');
    assertEqual(specResult.summary.selectorMisses, 1, '应记录一个选择器缺失');
    assertEqual(specResult.checks[0].severity, 'medium', '2px 字号差应为中严重度');
    assertEqual(specResult.checks[0].property, 'fontSize', '属性名');
  });

  await test('ui-spec 来源：路径与对象解析出同一 spec，来源路径只作为独立 sourcePath', () => {
    const specPath = join(ROOT, 'examples', 'static-demo', 'ui-spec.json');
    const viaPath = readSpecSource(specPath, { cwd: ROOT });
    const viaObject = readSpecSource(JSON.parse(readFileSync(specPath, 'utf8')), { cwd: ROOT });
    assertEqual(resolve(viaPath.sourcePath), resolve(specPath), '路径形态应返回 sourcePath');
    assertEqual(viaObject.sourcePath, '', '对象形态不应有 sourcePath');
    assertEqual(JSON.stringify(viaPath.spec), JSON.stringify(viaObject.spec), '两种来源应解析出同一 spec');
    assert(!Object.prototype.hasOwnProperty.call(viaPath.spec, 'path'), 'spec 本体不能带 path（会被二次校验当未知字段）');
  });

  await test('工具入口级：ui_probe 的 expected 路径与对象等价，profile 视口缺省生效', async () => {
    const module = await getToolEntryHarness();
    const calls = [];
    const fakeRunProbe = async (options) => {
      calls.push(options);
      return fakeSpecProbeResult(options);
    };
    const definitions = new Map();
    module.apply(
      { tools: { register: (definition) => definitions.set(definition.name, definition) } },
      { profileDir: 'profiles', runRoot: 'runs' },
      { runProbe: fakeRunProbe },
    );
    const probe = definitions.get('ui_probe');
    assert(probe, 'apply 应注册 ui_probe');
    const exec = { agent: { session: { header: { cwd: baseDir } } } };
    const specPath = join(ROOT, 'examples', 'static-demo', 'ui-spec.json');
    const profilePath = join(ROOT, 'profiles', 'static-demo.json');
    const outDir = join(baseDir, 'tool-entry-out');
    mkdirSync(outDir, { recursive: true });

    const pathResult = await probe.execute(
      { url: 'file:///fake/index.html', expected: specPath, profile: profilePath, out: join(outDir, 'probe-path.json') },
      exec,
    );
    const objectSpec = JSON.parse(readFileSync(specPath, 'utf8'));
    const objectResult = await probe.execute(
      { url: 'file:///fake/index.html', expected: objectSpec, profile: profilePath, out: join(outDir, 'probe-object.json') },
      exec,
    );

    assertEqual(calls.length, 2, '路径与对象两种形态都应进入 runProbe');
    for (const call of calls) {
      assertEqual(call.width, 1440, '缺省宽度应取档案 devices[0]');
      assertEqual(call.height, 900, '缺省高度应取档案 devices[0]');
      assertEqual(call.dpr, 1, '缺省 DPR 应取档案 devices[0]');
      assert(!Object.prototype.hasOwnProperty.call(call.spec, 'path'), '传给 runProbe 的 spec 不应带 path');
      assertEqual(call.expected, undefined, '工具入口应复用已解析 spec，而不是把原始 expected 再传一次');
    }
    assertEqual(resolve(calls[0].specPath), resolve(specPath), '路径形态应把来源路径作为独立 specPath');
    assertEqual(calls[1].specPath, '', '对象形态没有来源路径');

    assertEqual(pathResult.mode, 'spec', '路径形态 mode');
    assertEqual(objectResult.mode, 'spec', '对象形态 mode');
    assertEqual(JSON.stringify(pathResult.viewport), JSON.stringify(objectResult.viewport), '两种形态视口应一致');
    assertEqual(JSON.stringify(pathResult.summary), JSON.stringify(objectResult.summary), '两种形态 summary 应一致');
    assertEqual(JSON.stringify(pathResult.checks), JSON.stringify(objectResult.checks), '两种形态属性检查应一致');
    assertEqual(pathResult.spec.elements, objectResult.spec.elements, '两种形态元素数应一致');
    assertEqual(resolve(pathResult.spec.path), resolve(specPath), '路径形态报告元数据应记录来源');
    assertEqual(objectResult.spec.path, '', '对象形态来源为空');

    // 显式 width 覆盖档案，未给的 height 仍取档案
    await probe.execute(
      { url: 'file:///fake/index.html', expected: specPath, profile: profilePath, width: 800, out: join(outDir, 'probe-width.json') },
      exec,
    );
    assertEqual(calls[2].width, 800, '显式 width 应覆盖档案');
    assertEqual(calls[2].height, 900, '未给 height 时仍取档案');
  });

  await test('工具入口级：非法 ui-spec 在起浏览器前报错，且不进入 runProbe', async () => {
    const module = await getToolEntryHarness();
    const calls = [];
    const definitions = new Map();
    module.apply(
      { tools: { register: (definition) => definitions.set(definition.name, definition) } },
      { profileDir: 'profiles', runRoot: 'runs' },
      { runProbe: async (options) => { calls.push(options); return fakeSpecProbeResult(options); } },
    );
    const probe = definitions.get('ui_probe');
    const exec = { agent: { session: { header: { cwd: baseDir } } } };
    const invalidSpec = join(ROOT, 'examples', 'static-demo', 'ui-spec-invalid.json');
    let error;
    try {
      await probe.execute({ url: 'file:///fake/index.html', expected: invalidSpec, profile: join(ROOT, 'profiles', 'static-demo.json') }, exec);
    } catch (caught) {
      error = caught;
    }
    // harness 复制了一份 lib/，UiSpecError 是另一个模块实例，按 name 判断而不是 instanceof。
    assertEqual(error?.name, 'UiSpecError', `应抛 UiSpecError，实际 ${error?.name}: ${error?.message}`);
    for (const token of ['widht', 'not-a-color', 'selector', 'unknownTopLevel']) {
      assert(String(error.message).includes(token), `错误信息应含 ${token}`);
    }
    assertEqual(calls.length, 0, '非法 spec 不应触发浏览器段');
  });

  await test('工具入口级：ui_diff 只写差异画布，不覆盖本次视口', async () => {
    const module = await getToolEntryHarness();
    const runDir = join(baseDir, 'tool-entry-diff-run');
    ensureDir(runDir);
    mergeMeta(runDir, { viewport: { width: 1280, height: 800, dpr: 1 } });
    const designPath = writePng(join(baseDir, 'entry-diff-design.png'), makeDemoPng());
    const shotPath = writePng(join(baseDir, 'entry-diff-shot.png'), makeDemoPng({ color: [220, 38, 38, 255] }));
    const fakeDiff = () => ({
      score: 0.9,
      diffRatio: 0.1,
      regions: [],
      diffPng: pngBytes(designPath),
      sideBySidePng: pngBytes(designPath),
      canvas: { width: 200, height: 120 },
      mismatchPixels: 100,
      totalPixels: 1000,
      sizeMismatch: {
        design: { width: 200, height: 120 },
        shot: { width: 200, height: 120 },
        rescaled: { width: 200, height: 120 },
        offset: { x: 0, y: 0 },
        aspectDelta: 0,
        mismatch: false,
      },
      scale: 1,
      threshold: 0.01,
      tolerance: 24,
      pass: false,
    });
    const definitions = new Map();
    module.apply(
      { tools: { register: (definition) => definitions.set(definition.name, definition) } },
      {},
      { diffImages: fakeDiff },
    );
    const exec = { agent: { session: { header: { cwd: baseDir } } } };
    const output = await definitions.get('ui_diff').execute({ design: designPath, shot: shotPath, run: runDir }, exec);
    const meta = readMeta(runDir);
    assertEqual(output.canvas.width, 200, '输出应带差异画布');
    assertEqual(meta.canvas.width, 200, 'meta 应单独记录差异画布');
    assertEqual(meta.viewport.width, 1280, 'ui_diff 不应覆盖本次视口');
    assertEqual(meta.viewport.height, 800, 'ui_diff 不应覆盖本次视口高度');
  });

  await test('工具入口级：ui_diff 输出 style 证据，ui_report 生成风格指标段', async () => {
    const module = await getToolEntryHarness();
    const runDir = join(baseDir, 'tool-entry-style-run');
    ensureDir(runDir);
    const designPath = writePng(join(runDir, 'design.png'), makeDemoPng());
    const sameShotPath = writePng(join(runDir, 'shot.png'), makeDemoPng());
    const definitions = new Map();
    module.apply(
      { tools: { register: (definition) => definitions.set(definition.name, definition) } },
      {},
      {},
    );
    const exec = { agent: { session: { header: { cwd: baseDir } } } };
    const diffOutput = await definitions.get('ui_diff').execute({ design: designPath, shot: sameShotPath, run: runDir }, exec);
    assert(diffOutput.style, 'ui_diff 输出应含 style 字段');
    assertEqual(diffOutput.style.score, 1, '同图风格分应为 1');
    assertEqual(diffOutput.pass, true, '同图像素判定仍为 pass（style 不改判定）');
    assertEqual(diffOutput.style.reference.palette[0].color, '#ffffff', '参考色板应可读');
    assert(diffOutput.style.deltas && typeof diffOutput.style.deltas.paletteDistance === 'number', '应带 deltas');

    const diffJson = JSON.parse(readFileSync(join(runDir, 'diff.json'), 'utf8'));
    assertEqual(diffJson.style.score, diffOutput.style.score, 'diff.json 应写 style');
    const meta = readMeta(runDir);
    assertEqual(meta.style.score, diffOutput.style.score, 'meta.json 应写 style');

    // 不同色板：风格分应下降，但 pass 仍只由像素差异率决定。
    const changedPng = writePng(join(baseDir, 'style-shot-changed.png'), makeDemoPng({ color: [220, 38, 38, 255] }));
    const changed = await definitions.get('ui_diff').execute({
      design: designPath,
      shot: changedPng,
      out: join(baseDir, 'style-diff-out'),
    }, exec);
    assert(changed.style.score < diffOutput.style.score, `不同色板风格分应下降，实际 ${changed.style.score}`);
    assert(changed.style.deltas.paletteDistance > 0, '不同色板应有色板距离');
    assertEqual(changed.pass, changed.diffRatio <= changed.threshold, 'pass 仍只由 diffRatio/threshold 决定');

    const reportDefinitions = new Map();
    module.apply(
      { tools: { register: (definition) => reportDefinitions.set(definition.name, definition) } },
      {},
      {},
    );
    const report = await reportDefinitions.get('ui_report').execute({ run: runDir }, exec);
    const html = readFileSync(report.htmlPath, 'utf8');
    const markdown = readFileSync(report.markdownPath, 'utf8');
    assert(html.includes('风格指标'), 'HTML 应含风格指标段');
    assert(markdown.includes('风格指标'), 'Markdown 应含风格指标段');
    assert(html.includes('色板距离') && html.includes('边缘密度') && html.includes('填充率'), 'HTML 应含风格指标明细');
    assert(!/<script/i.test(html), '风格指标段不应引入脚本');
    assert(!/src="https?:/i.test(html) && !/href="https?:/i.test(html), '风格指标段不应引入外链');
    assert(!/data:image/i.test(html), '风格指标段不应内嵌 base64');
    assertEqual(report.summary.pass, true, '报告判定仍由像素分数决定');
  });

  // ---- 假浏览器：浏览器层核心逻辑（B1/B2 回归，不需要 --browser） ----------

  await test('浏览器层注入：capturePage 返回 path/width/height/dpr/channel/cssWidth/cssHeight', async () => {
    const fake = createFakeBrowser({ channel: 'fake-msedge', shotSize: { width: 1440, height: 900 } });
    const target = join(baseDir, 'fake-capture', 'shot.png');
    const capture = await capturePage({
      config: {},
      cwd: baseDir,
      url: 'file:///fake/index.html',
      width: 1440,
      height: 900,
      dpr: 1,
      path: target,
      launcher: fake.launcher,
    });
    assertEqual(capture.channel, 'fake-msedge', 'channel 应来自 launcher（B1 回归：不能再 ReferenceError）');
    assertEqual(capture.width, 1440, '截图像素宽');
    assertEqual(capture.height, 900, '截图像素高');
    assertEqual(capture.dpr, 1, 'DPR');
    assertEqual(capture.cssWidth, 1440, 'CSS 宽度');
    assertEqual(capture.cssHeight, 900, 'CSS 高度');
    assertEqual(capture.fullPage, false, 'fullPage 默认 false');
    assertEqual(capture.selector, '', 'selector 默认空');
    assertEqual(capture.path, resolve(target), '返回绝对路径');
    assert(existsSync(capture.path), '截图文件应真实落盘');
    assertEqual(fake.state.launchCalls, 1, '应只启动一次');
    assertEqual(fake.state.closed, 1, '拿完结果应关闭浏览器');
    assertEqual(fake.state.contexts[0].viewport.width, 1440, 'context 视口宽度');
    assertEqual(fake.state.contexts[0].deviceScaleFactor, 1, 'context DPR');
    assertEqual(fake.state.screenshotCalls[0].fullPage, false, '页面截图的 fullPage');

    // DPR 2：PNG 像素翻倍，CSS 尺寸保持
    const fake2 = createFakeBrowser({ channel: 'fake-2x', shotSize: { width: 2880, height: 1800 } });
    const capture2 = await capturePage({
      config: {},
      cwd: baseDir,
      url: 'file:///fake/index.html',
      width: 1440,
      height: 900,
      dpr: 2,
      fullPage: true,
      path: join(baseDir, 'fake-capture', 'shot-2x.png'),
      launcher: fake2.launcher,
    });
    assertEqual(capture2.width, 2880, '2x 截图像素宽');
    assertEqual(capture2.height, 1800, '2x 截图像素高');
    assertEqual(capture2.dpr, 2, '2x DPR');
    assertEqual(capture2.cssWidth, 1440, '2x CSS 宽度');
    assertEqual(fake2.state.screenshotCalls[0].fullPage, true, 'fullPage 应透传');
    assertEqual(fake2.state.contexts[0].deviceScaleFactor, 2, '2x context DPR');

    // 元素截图分支
    const fake3 = createFakeBrowser({ channel: 'fake-element', elementSize: { width: 120, height: 40 } });
    const capture3 = await capturePage({
      config: {},
      cwd: baseDir,
      url: 'file:///fake/index.html',
      width: 1440,
      height: 900,
      selector: '.btn',
      path: join(baseDir, 'fake-capture', 'element.png'),
      launcher: fake3.launcher,
    });
    assertEqual(capture3.width, 120, '元素截图像素宽');
    assertEqual(capture3.height, 40, '元素截图像素高');
    assertEqual(fake3.state.screenshotCalls[0].mode, 'element', '应走元素截图分支');
    assertEqual(fake3.state.screenshotCalls[0].selector, '.btn', 'selector 应透传');
  });

  await test('浏览器层注入：withPage callback 能拿到 channel 与 context，异常也会关闭浏览器', async () => {
    const fake = createFakeBrowser({ channel: 'fake-chrome' });
    const seen = {};
    await withPage({}, { width: 800, height: 600, dpr: 1 }, async (page, info) => {
      seen.hasPage = Boolean(page);
      seen.channel = info.channel;
      seen.hasContext = Boolean(info.context);
    }, { launcher: fake.launcher });
    assert(seen.hasPage, 'callback 应收到 page');
    assertEqual(seen.channel, 'fake-chrome', 'callback 第二参数应含 channel');
    assert(seen.hasContext, 'callback 第二参数应含 context');
    assertEqual(fake.state.closed, 1, '正常结束应关闭浏览器');

    const failing = createFakeBrowser({ channel: 'fake-fail' });
    let error;
    try {
      await withPage({}, { width: 100, height: 100 }, async () => {
        throw new Error('boom');
      }, { launcher: failing.launcher });
    } catch (caught) {
      error = caught;
    }
    assertEqual(error?.message, 'boom', 'callback 异常应透传');
    assertEqual(failing.state.closed, 1, 'callback 异常也必须关闭浏览器');
  });

  await test('浏览器层注入：runProbe 审计模式在假 page 下返回结构正确', async () => {
    const rawAudit = {
      title: 'audit',
      url: 'file:///fake/audit.html',
      viewport: { innerWidth: 1440, innerHeight: 900, scrollWidth: 1600, scrollHeight: 900, horizontalScroll: true },
      elementsScanned: 12,
      truncated: false,
      overflow: [],
      outsideViewport: [],
      palette: [{ value: 'rgb(15, 23, 42)', count: 3 }],
      fontSizes: [{ value: '9px', count: 2 }],
      spacing: [],
      hardcodedColors: [{ selector: '.x', inline: 'color:#ff0000' }],
      imagesWithoutAlt: [{ selector: 'img', src: 'asset.svg' }],
      focusRisks: [],
      emptyStates: [],
    };
    const fake = createFakeBrowser({ channel: 'fake-audit', evaluate: () => rawAudit });
    const result = await runProbe({
      config: {},
      cwd: baseDir,
      url: 'file:///fake/audit.html',
      width: 1440,
      height: 900,
      dpr: 2,
      launcher: fake.launcher,
    });
    assertEqual(result.mode, 'audit', '审计模式');
    assertEqual(result.viewport.width, 1440, '视口宽');
    assertEqual(result.viewport.height, 900, '视口高');
    assertEqual(result.viewport.dpr, 2, '视口 DPR');
    const kinds = new Set(result.issues.map((issue) => issue.kind));
    assert(kinds.has('overflow'), '应报横向溢出');
    assert(kinds.has('alt'), '应报缺 alt');
    assert(kinds.has('hardcoded'), '应报硬编码颜色');
    assertEqual(result.audit.fontSizes[0].value, '9px', '字号分布应保留');
    assertEqual(fake.state.evaluateCalls[0].fnName, 'pageAudit', '应调用页面内 pageAudit');
    assertEqual(fake.state.evaluateCalls[0].arg.scope, '', '默认整页采集');
    assertEqual(fake.state.closed, 1, '探针结束应关闭浏览器');
  });

  await test('浏览器层注入：runProbe 契约模式在假 page 下返回 checks 与来源路径', async () => {
    const spec = readSpecSource({
      elements: [{ selector: '.a', label: 'A', properties: { fontSize: '14px' } }],
    }).spec;
    const rawStyles = {
      url: 'file:///fake/spec.html',
      title: 'spec',
      entries: [{ selector: '.a', found: true, styles: { fontSize: '14px' }, rect: { x: 0, y: 0, width: 10, height: 10 } }],
    };
    const fake = createFakeBrowser({ channel: 'fake-spec', evaluate: () => rawStyles });
    const result = await runProbe({
      config: {},
      cwd: baseDir,
      url: 'file:///fake/spec.html',
      spec,
      specPath: 'specs/a.ui.json',
      width: 1440,
      height: 900,
      dpr: 1,
      launcher: fake.launcher,
    });
    assertEqual(result.mode, 'spec', '契约模式');
    assertEqual(result.checks.length, 1, '一条属性检查');
    assertEqual(result.checks[0].pass, true, '相同计算样式应通过');
    assertEqual(result.summary.passed, 1, 'summary passed');
    assertEqual(result.spec.path, 'specs/a.ui.json', '来源路径应写入报告元数据');
    assertEqual(fake.state.evaluateCalls[0].fnName, 'pageReadStyles', '应调用页面内 pageReadStyles');
    assertEqual(fake.state.evaluateCalls[0].arg[0].selector, '.a', '选择器应透传');
    assertEqual(fake.state.closed, 1, '探针结束应关闭浏览器');
  });

  await test('浏览器层注入：假 capture → diff → report 全链路无 undefined path（B2 回归）', async () => {
    const runDir = join(baseDir, 'fake-browser-run');
    ensureDir(runDir);
    const designFake = createFakeBrowser({ channel: 'fake-design', shotSize: { width: 200, height: 120 }, fill: [240, 240, 240, 255] });
    const shotFake = createFakeBrowser({ channel: 'fake-shot', shotSize: { width: 200, height: 120 }, fill: [220, 38, 38, 255] });
    const design = await capturePage({
      config: {}, cwd: baseDir, url: 'file:///fake/design.html', width: 200, height: 120, dpr: 1,
      path: join(runDir, 'design.png'), launcher: designFake.launcher,
    });
    const shot = await capturePage({
      config: {}, cwd: baseDir, url: 'file:///fake/shot.html', width: 200, height: 120, dpr: 1,
      path: join(runDir, 'shot.png'), launcher: shotFake.launcher,
    });
    assert(design && shot, 'capturePage 必须返回对象（B2：此前 undefined 会炸在 .path）');
    assertEqual(typeof design.path, 'string', 'design.path 应为字符串');
    assertEqual(typeof shot.path, 'string', 'shot.path 应为字符串');

    const diff = diffImages(readFileSync(design.path), readFileSync(shot.path), { tolerance: 24, threshold: 0.01 });
    writeFileSync(join(runDir, 'diff.png'), diff.diffPng);
    writeFileSync(join(runDir, 'side-by-side.png'), diff.sideBySidePng);
    writeJsonFile(join(runDir, 'diff.json'), {
      tool: 'dsh-ui-restore',
      version: '0.1.0',
      generatedAt: new Date().toISOString(),
      canvas: diff.canvas,
      score: diff.score,
      diffRatio: diff.diffRatio,
      mismatchPixels: diff.mismatchPixels,
      totalPixels: diff.totalPixels,
      regions: diff.regions,
      scale: diff.scale,
      sizeMismatch: diff.sizeMismatch,
      threshold: diff.threshold,
      tolerance: diff.tolerance,
      pass: diff.pass,
    });
    mergeMeta(runDir, {
      mode: 'design',
      url: 'file:///fake/design.html',
      viewport: { width: 200, height: 120, dpr: 1 },
      history: [{ round: 1, score: diff.score }],
    });
    const report = buildReport({ run: runDir, cwd: ROOT, locale: 'zh' });
    assert(existsSync(report.htmlPath), '报告 HTML 应生成');
    const html = readFileSync(report.htmlPath, 'utf8');
    assertEqual((html.match(/<img /g) ?? []).length, 3, '报告应含三张图');
    // B3 回归：HTML 里的 <img src> 必须是同目录相对路径，且文件真实存在于报告目录。
    const imgSources = [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((match) => match[1]);
    assertEqual(imgSources.length, 3, 'HTML 应引用三张图');
    for (const source of imgSources) {
      assert(!source.includes('/') && !source.includes('\\'), `报告图片应使用同目录相对路径：${source}`);
      assert(existsSync(join(report.outDir, source)), `报告图片应实际存在于报告目录：${source}`);
    }
    assertEqual(report.summary.regions, diff.regions.length, '区域数应与 diff 一致');
    assertEqual(report.summary.mode, 'design', '模式');
  });

  // ---- 技能自动注册（装上即可被 catalog 发现） -----------------------------

  await test('技能自动注册：包内 SKILL.md 可读、frontmatter 已剥离、无本机绝对路径', () => {
    const skill = readBundledSkill();
    assert(skill, '应读取到 skills/ui-restore/SKILL.md');
    assertEqual(skill.name, 'ui-restore', '技能名');
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name), '技能名应为 kebab-case');
    assert(skill.description.length > 10, 'description 应非空');
    assert(skill.whenToUse.length > 10, 'whenToUse 应非空');
    assert(skill.content.length > 5000, `SKILL 正文应完整，实际 ${skill.content.length} 字节`);
    assert(skill.content.startsWith('# SKILL'), 'frontmatter 应被剥离，正文以标题开头');
    assertEqual(skill.resourceBase.kind, 'directory', 'resourceBase 类型');
    assertEqual(skill.source, 'runtime', 'source 应为 runtime（registry 必填）');
    assertEqual(resolve(skill.path), resolve(SKILL_FILE), 'path 应指向包内 SKILL.md');
    assert(existsSync(join(skill.resourceBase.path, 'SKILL.md')), 'resourceBase 应指向包内技能目录');
    assertEqual(resolve(skill.resourceBase.path), resolve(SKILL_FILE, '..'), '技能目录应与包内路径一致');

    // 实现不得硬编码本机绝对路径（运行时路径由 import.meta.url 推导即可）。
    const source = readFileSync(new URL('../lib/skill.js', import.meta.url), 'utf8');
    assert(!/['"`][A-Za-z]:[\\/]/.test(source), 'lib/skill.js 不应出现盘符绝对路径字面量');
  });

  await test('技能自动注册：ctx.inject(["skills"]) 注册载荷与 SKILL 一致', () => {
    const skill = readBundledSkill();
    const captured = {};
    const fakeSkillCtx = {
      skills: {
        register: (payload) => {
          captured.registered = payload;
          return () => {};
        },
      },
      effect: (factory) => {
        captured.effectDisposer = typeof factory();
        return () => {};
      },
    };
    const fakeCtx = {
      inject: (deps, callback) => {
        captured.deps = deps;
        callback(fakeSkillCtx);
      },
    };
    assertEqual(registerBundledSkill(fakeCtx), true, '应发起注册');
    assertEqual(JSON.stringify(captured.deps), JSON.stringify(['skills']), '应注入 skills service');
    assert(captured.registered, '应调用 skills.register');
    assertEqual(captured.registered.name, skill.name, '注册名');
    assertEqual(captured.registered.content, skill.content, '注册正文与 SKILL.md 一致');
    assertEqual(captured.registered.resourceBase.path, skill.resourceBase.path, 'resourceBase 一致');
    assertEqual(captured.effectDisposer, 'function', '注册 disposer 应交给 ctx.effect 持有');
    assertEqual(registerBundledSkill({}), false, '没有 inject 的上下文应静默跳过');
  });

  await test('工具入口级：apply() 会注册内置 skill（假 ctx 验证接线）', async () => {
    const module = await getToolEntryHarness();
    const captured = {};
    const fakeCtx = {
      tools: { register: () => () => {} },
      inject: (deps, callback) => {
        captured.deps = deps;
        callback({
          skills: {
            register: (payload) => {
              captured.skill = payload;
              return () => {};
            },
          },
          effect: (factory) => factory(),
        });
      },
    };
    module.apply(fakeCtx, {});
    assertEqual(JSON.stringify(captured.deps), JSON.stringify(['skills']), 'apply 应注入 skills');
    assertEqual(captured.skill?.name, 'ui-restore', 'apply 应注册 ui-restore 技能');
    assert(captured.skill?.content.includes('# SKILL'), '注册正文应来自包内 SKILL.md');
  });

  await test('设计评审门：SKILL / 三个预设 persona / 文档一致声明评审阶段', () => {
    const skill = readBundledSkill();
    for (const marker of ['设计评审', '设计评审层', 'review/design-review.json', 'needs_revision']) {
      assert(skill.content.includes(marker), `SKILL 应包含「${marker}」`);
    }
    const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
    for (const marker of ['design-review.json', '设计评审', 'needs_revision']) {
      assert(patch.includes(marker), `cordis.patch.yml 应包含「${marker}」`);
    }
    const reviewMentions = (patch.match(/设计评审/g) ?? []).length;
    assert(reviewMentions >= 3, `队长/设计/验收三个 persona 都应声明设计评审，实际 ${reviewMentions} 处`);
    const usage = readFileSync(join(ROOT, 'docs/USAGE.md'), 'utf8');
    assert(usage.includes('design-review.json'), 'USAGE 应说明设计评审产物');
    assert(skill.content.includes('pass') && skill.content.includes('评审不通过不得派画师'), 'SKILL 应写明评审不通过不得派画师');
  });

  await test('知识库接线：SKILL 与五个预设均声明按案例工作', () => {
    const skill = readBundledSkill();
    for (const marker of ['2B. 项目知识库', '项目知识库', '失败案例', '参考案例']) {
      assert(skill.content.includes(marker), `SKILL 应包含「${marker}」`);
    }
    for (const role of ['队长', '设计师', '画师', '验收者', '接线者']) {
      assert(new RegExp(`### ${role}`).test(skill.content), `SKILL 第 7 节应有「${role}」角色说明`);
    }

    const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
    assert(patch.includes('docs/knowledge'), 'cordis.patch.yml 应引用 docs/knowledge');

    // 逐预设切片断言（不看全文计数）：顶层条目以 4 空格缩进开头，
    // 预设内嵌套的插件条目缩进更深，不会被当成片段边界。
    const patchLines = patch.split(/\r?\n/);
    const topLevelIdLine = /^ {4}- id: /;
    const presetBlock = (presetId) => {
      const marker = `- id: preset-${presetId}`;
      const start = patchLines.findIndex((line) => line.trim() === marker);
      assert(start >= 0, `cordis.patch.yml 应声明预设 ${presetId}`);
      let end = patchLines.length;
      for (let cursor = start + 1; cursor < patchLines.length; cursor += 1) {
        if (topLevelIdLine.test(patchLines[cursor])) {
          end = cursor;
          break;
        }
      }
      return {
        text: patchLines.slice(start, end).join('\n'),
        start: start + 1,
        end: end + 1,
      };
    };
    const presetRules = {
      'ui-restore': ['知识库', '参考案例'],
      'ui-restore-painter': ['知识库', '图块/风格模板'],
      'ui-restore-verifier': ['知识库', '结构层', '风格层', '可辨识'],
      'ui-restore-integrator': ['知识库', 'api 段'],
      'ui-restore-designer': ['知识库', '失败案例', '风格自检', '推导'],
    };
    for (const [presetId, markers] of Object.entries(presetRules)) {
      const block = presetBlock(presetId);
      for (const marker of markers) {
        assert(block.text.includes(marker), `预设 ${presetId}（第 ${block.start}~${block.end} 行）的 persona 应包含「${marker}」`);
      }
    }

    const teams = readFileSync(join(ROOT, 'docs', 'teams-integration.md'), 'utf8');
    assert(teams.includes('参考案例'), 'teams-integration 任务模板应含「参考案例」');

    const knowledge = readFileSync(join(ROOT, 'docs', 'knowledge', 'README.md'), 'utf8');
    assert(knowledge.includes('Agent 接线'), 'knowledge README 应含「Agent 接线」说明');
  });

  // ---- Paper 直读（离线夹具，不依赖网络） --------------------------------

  // 真实 Paper 的 tools/call 返回两段 text block：block0 是上下文头，block1 才是业务载荷。
  const PAPER_CONTEXT_HEADER = {
    file: { id: 'file_sample', name: 'Marketing Home' },
    contentHash: { tokens: 'sha256:paper-context' },
  };
  const paperToolResult = (payloads) => ({
    content: [
      { type: 'text', text: JSON.stringify(PAPER_CONTEXT_HEADER) },
      ...(Array.isArray(payloads) ? payloads : [payloads]).map((payload) => ({ type: 'text', text: JSON.stringify(payload) })),
    ],
  });

  // 真实 Paper 形状：get_tree_summary 只有字符串 summary；层级靠 get_children 逐层取。
  const PAPER_CHILDREN = {
    artboard_home: [
      { id: 'n-hero', name: 'Hero', component: 'frame' },
      { id: 'n-cta', name: 'Primary CTA', component: 'button' },
      { id: 'n-card', name: 'Feature card', component: 'frame' },
    ],
    'n-hero': [
      { id: 'n-hero-title', name: 'Hero title', component: 'text' },
      { id: 'n-hero-sub', name: 'Hero subtitle', component: 'text' },
    ],
    'n-cta': [],
    'n-card': [],
  };
  const makePaperClient = (fixture) => {
    const calls = [];
    const styleBatches = [];
    return {
      calls,
      styleBatches,
      async callTool(name, args = {}) {
        calls.push({ name, args });
        if (name === 'get_basic_info') return extractToolPayload(paperToolResult({ fileName: fixture.file.name, artboards: fixture.artboards }), name);
        if (name === 'get_tokens') return extractToolPayload(paperToolResult({ tokens: fixture.tokens }), name);
        if (name === 'get_tree_summary') {
          return extractToolPayload(paperToolResult({ summary: `Frame "${fixture.artboards[0].name}" (${fixture.artboards[0].id}) ${fixture.artboards[0].width}×${fixture.artboards[0].height}\n  Frame Hero ...` }), name);
        }
        if (name === 'get_children') return extractToolPayload(paperToolResult({ children: PAPER_CHILDREN[args.nodeId] ?? [] }), name);
        if (name === 'get_computed_styles') {
          styleBatches.push([...args.nodeIds]);
          const styles = {};
          for (const nodeId of args.nodeIds) {
            const entry = fixture.computedStyles.find((item) => item.nodeId === nodeId);
            if (entry) styles[nodeId] = entry.styles;
          }
          return extractToolPayload(paperToolResult({ styles }), name);
        }
        throw new Error(`unexpected tool ${name}`);
      },
    };
  };

  await test('Paper 多 content block：按业务键选载荷（上下文头 + 业务块）', () => {
    const basic = extractToolPayload(paperToolResult({ fileName: 'Marketing Home', artboards: [{ id: 'a1', name: 'Artboard', width: 100, height: 50 }] }), 'get_basic_info');
    assertEqual(basic.artboards[0].id, 'a1', 'get_basic_info 应选含 artboards 的块');
    const tokens = extractToolPayload(paperToolResult({ tokens: [{ name: 'brand' }] }), 'get_tokens');
    assertEqual(tokens.tokens[0].name, 'brand', 'get_tokens 应选 tokens 块');
    const summary = extractToolPayload(paperToolResult({ summary: { nodes: [{ id: 'n1' }] } }), 'get_tree_summary');
    assertEqual(summary.summary.nodes[0].id, 'n1', 'get_tree_summary 应选 summary 块');
    const children = extractToolPayload(paperToolResult({ children: [{ id: 'c1' }] }), 'get_children');
    assertEqual(children.children[0].id, 'c1', 'get_children 应选 children 块');
    const styles = extractToolPayload(paperToolResult({ styles: { n1: { 'font-size': '12px' } } }), 'get_computed_styles');
    assertEqual(styles.styles.n1['font-size'], '12px', 'get_computed_styles 应选 styles 块');

    let headerOnly;
    try {
      extractToolPayload(paperToolResult([]), 'get_basic_info');
    } catch (error) {
      headerOnly = error;
    }
    assert(headerOnly && headerOnly.message.includes('返回里没有 artboards'), '只有上下文头时应报「返回里没有 artboards」');

    const warnings = [];
    const merged = extractToolPayload(paperToolResult([{ artboards: [{ id: 'a1' }] }, { fileName: 'Marketing Home' }]), 'get_basic_info', warnings);
    assertEqual(merged.artboards[0].id, 'a1', '多业务块应浅合并保留 artboards');
    assertEqual(merged.fileName, 'Marketing Home', '多业务块应浅合并保留 fileName');
    assertEqual(warnings.length, 1, '多业务块应写 warning');
  });

  await test('Paper 直读：JSON-RPC/SSE 解析、工具载荷解包与属性映射', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    const parsed = parseMcpBody(sse, 'text/event-stream');
    assertEqual(parsed.result.ok, true, 'SSE data 行应解析成 JSON-RPC 结果');
    const direct = parseMcpBody('{"jsonrpc":"2.0","id":2,"result":{"value":1}}', 'application/json');
    assertEqual(direct.result.value, 1, '普通 JSON 应直接解析');
    const payload = extractToolPayload({ content: [{ type: 'text', text: JSON.stringify({ artboards: [{ id: 'a1', width: 100, height: 50 }] }) }] });
    assertEqual(payload.artboards[0].id, 'a1', 'content[].text 应解包成 JSON');
    assertEqual(toUiSpecPropertyName('font-size'), 'fontSize', 'kebab-case 应映射到 ui-spec 键');
    assertEqual(toUiSpecPropertyName('not-a-property'), undefined, '白名单外属性应丢弃');
    const styles = filterStyles({ 'font-size': '12px', 'line-height': 16, color: '#C72926', 'unknown-thing': 'x' });
    assertEqual(JSON.stringify(styles), JSON.stringify({ fontSize: '12px', lineHeight: '16px', color: '#c72926' }), '样式应过滤并归一化');
    const { nodes, truncated } = collectTreeNodes({ children: [{ id: 'a' }, { id: 'b', children: [{ id: 'c' }] }] }, 10);
    assertEqual(JSON.stringify(nodes.map((node) => node.id)), JSON.stringify(['a', 'b', 'c']), '应按深度优先收集节点');
    assertEqual(truncated, false, '未超限不应截断');
  });

  await test('Paper 直读：离线夹具（字符串 summary + get_children BFS）→ ui-spec 与 sample 一致', async () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, 'examples', 'paper', 'paper-artboard.sample.json'), 'utf8'));
    const expected = JSON.parse(readFileSync(join(ROOT, 'examples', 'paper', 'ui-spec.sample.json'), 'utf8'));
    const fakeClient = makePaperClient(fixture);
    const result = await convertPaper({ client: fakeClient, fileId: 'file_sample', artboardId: 'artboard_home', maxNodes: 200, maxDepth: 3 });
    assertEqual(JSON.stringify(result.spec), JSON.stringify(expected), '生成的 ui-spec 应与 sample 完全一致');
    assertEqual(result.spec.elements.length, 4, '应有 4 个有样式的元素');
    assertEqual(result.spec.viewport.width, 1440, 'viewport 宽应取 artboard');
    assertEqual(result.warnings.length, 0, '未超限不应有 warning');
    assertEqual(result.stats.childrenCalls, 6, 'BFS 应调用 6 次 get_children（根 + hero + 2 叶子 + 2 文本）');
    assertEqual(result.stats.styleCalls, 1, '4 个节点应只调用 1 次 styles');
    assert(!fakeClient.calls.some((call) => call.name === 'get_tree_summary'), '建 ui-spec 不应依赖 get_tree_summary');
    assertEqual(fakeClient.calls.find((call) => call.name === 'get_children').args.fileId, 'file_sample', 'get_children 必须显式传 fileId');
    assert(fakeClient.styleBatches.every((batch) => batch.length <= 50), '每批 styles ≤ 50 个 nodeIds');
    validateSpec(result.spec);
  });

  await test('Paper 直读：超 max-nodes 截断并 warning；缺端点/artboard 报可读错误', async () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, 'examples', 'paper', 'paper-artboard.sample.json'), 'utf8'));
    const fakeClient = makePaperClient(fixture);
    const truncated = await convertPaper({ client: fakeClient, fileId: 'file_sample', artboardId: 'artboard_home', maxNodes: 4, maxDepth: 3 });
    assertEqual(truncated.spec.elements.length, 2, 'max-nodes=4 时只采到根 + 三个子节点，其中 2 个有样式');
    assertEqual(truncated.stats.truncated, true, 'max-nodes 截断应标记 truncated');
    assert(truncated.warnings.some((warning) => warning.includes('max-nodes')), '截断应写 warning');

    let missingEndpoint;
    try {
      resolveEndpoint({}, {});
    } catch (error) {
      missingEndpoint = error;
    }
    assert(missingEndpoint && missingEndpoint.message.includes(ENDPOINT_ENV), '缺端点错误应包含环境变量名');
    assert(missingEndpoint.message.includes('--url http://<paper-host>:<port>/mcp'), '缺端点错误应给出示例值');
    assertEqual(resolveEndpoint({ url: 'http://paper.example/mcp' }, {}), 'http://paper.example/mcp', '--url 优先');

    let missingArtboard;
    try {
      await convertPaper({ client: fakeClient, fileId: 'file_sample', artboardId: 'nope', maxNodes: 10 });
    } catch (error) {
      missingArtboard = error;
    }
    assert(missingArtboard && missingArtboard.message.includes('artboard 不存在'), '不存在的 artboard 应报可读错误');
    assert(missingArtboard.message.includes('可用 artboard') && missingArtboard.message.includes('artboard_home'), '错误里应列出可用 artboard');

    const args = parsePaperArgs(['--file', 'f', '--artboard', 'a', '--dry-run']);
    assertEqual(args.dryRun, true, '--dry-run 应被解析');
    assertEqual(args.maxNodes, 200, '默认 max-nodes=200');
    assertEqual(args.maxDepth, 3, '默认 max-depth=3');
    assertEqual(parsePaperArgs(['--file', 'f', '--artboard', 'a', '--max-depth', '5']).maxDepth, 5, '--max-depth 应被解析');
    assertEqual(typeof paperMain, 'function', 'CLI 入口应可调用');

    const source = readFileSync(new URL('../scripts/paper-to-ui-spec.mjs', import.meta.url), 'utf8');
    const forbidden = ['127' + '.0.0.1', '299' + '79', 'mcp' + '__paper'];
    assert(!forbidden.some((needle) => source.includes(needle)), '脚本源码不应出现本机地址/端口/工具名');
  });

  await test('Paper 直读：get_computed_styles 每批 ≤ 50 并记录 calls 计数', async () => {
    const children = Array.from({ length: 120 }, (_, index) => ({ id: `n${index}`, name: `Node ${index}`, component: 'text' }));
    const batchSizes = [];
    const fakeClient = {
      async callTool(name, args = {}) {
        if (name === 'get_basic_info') return { fileName: 'Batch Home', artboards: [{ id: 'root', name: 'Batch', width: 100, height: 100 }] };
        if (name === 'get_tokens') return { tokens: [] };
        if (name === 'get_children') return { children: args.nodeId === 'root' ? children : [] };
        if (name === 'get_computed_styles') {
          batchSizes.push(args.nodeIds.length);
          const styles = {};
          for (const nodeId of args.nodeIds) {
            if (nodeId === 'root') continue;
            styles[nodeId] = { 'font-size': '12px' };
          }
          return { styles };
        }
        throw new Error(`unexpected tool ${name}`);
      },
    };
    const result = await convertPaper({ client: fakeClient, fileId: 'f', artboardId: 'root', maxNodes: 200, maxDepth: 1 });
    assertEqual(result.spec.elements.length, 120, '120 个子节点都应生成元素');
    assertEqual(result.stats.styleCalls, 3, '120 个节点应分 3 批（根节点也占一个 id）');
    assertEqual(JSON.stringify(batchSizes), JSON.stringify([50, 50, 21]), '每批 ≤ 50 且按顺序切分');
    assertEqual(result.stats.childrenCalls, 1, 'max-depth=1 只取根节点 children');
    validateSpec(result.spec);
  });

  await test('Paper 直读：get_children 返回空报可读错误；单批 styles 失败只跳过该批', async () => {
    const emptyClient = {
      async callTool(name) {
        if (name === 'get_basic_info') return { fileName: 'Empty', artboards: [{ id: 'root', name: 'Empty', width: 100, height: 100 }] };
        if (name === 'get_tokens') return { tokens: [] };
        if (name === 'get_children') return { children: [] };
        throw new Error(`unexpected tool ${name}`);
      },
    };
    let emptyError;
    try {
      await convertPaper({ client: emptyClient, fileId: 'f', artboardId: 'root', maxNodes: 10, maxDepth: 2 });
    } catch (error) {
      emptyError = error;
    }
    assert(emptyError && emptyError.message.includes('get_children 返回空'), '空 artboard 应报「get_children 返回空」');

    const children = Array.from({ length: 60 }, (_, index) => ({ id: `n${index}`, name: `Node ${index}`, component: 'text' }));
    let styleCall = 0;
    const flakyClient = {
      async callTool(name, args = {}) {
        if (name === 'get_basic_info') return { fileName: 'Flaky', artboards: [{ id: 'root', name: 'Flaky', width: 100, height: 100 }] };
        if (name === 'get_tokens') return { tokens: [] };
        if (name === 'get_children') return { children: args.nodeId === 'root' ? children : [] };
        if (name === 'get_computed_styles') {
          styleCall += 1;
          if (styleCall === 1) throw new Error('paper busy');
          const styles = {};
          for (const nodeId of args.nodeIds) styles[nodeId] = { 'font-size': '12px' };
          return { styles };
        }
        throw new Error(`unexpected tool ${name}`);
      },
    };
    const partial = await convertPaper({ client: flakyClient, fileId: 'f', artboardId: 'root', maxNodes: 100, maxDepth: 1 });
    assertEqual(partial.stats.styleCalls, 2, '61 个节点应分 2 批');
    assert(partial.warnings.some((warning) => warning.includes('第 1 批') && warning.includes('已跳过该批')), '首批失败应写 warning');
    assertEqual(partial.spec.elements.length, 11, '第二批成功的 11 个节点仍应生成元素');
  });

  await test('Paper 值归一化：calc()/var()/auto/百分比跳过并计数，保留合法值', async () => {
    const styles = {
      left: 'calc(50% + 0px)',
      width: 'var(--w)',
      minWidth: '50%',
      height: 'auto',
      fontSize: '50%',
      maxWidth: '10vh',
      borderRadius: 'fit-content',
      backgroundColor: 'var(--bg)',
      borderColor: 'currentColor',
      position: 'calc(1px + 2px)',
      paddingTop: '12px',
      display: 'flex',
      color: '#C72926',
      top: '0',
      letterSpacing: '-0.02em',
      outlineColor: 'rgb(1, 2, 3)',
      unknownThing: 'x',
    };
    const fakeClient = {
      async callTool(name, args = {}) {
        if (name === 'get_basic_info') return { fileName: 'Normalize', artboards: [{ id: 'root', name: 'Normalize', width: 100, height: 100 }] };
        if (name === 'get_tokens') return { tokens: [] };
        if (name === 'get_children') return { children: args.nodeId === 'root' ? [{ id: 'n-bad', name: 'Bad styles', component: 'frame' }] : [] };
        if (name === 'get_computed_styles') return { styles: { 'n-bad': styles } };
        throw new Error(`unexpected tool ${name}`);
      },
    };
    const result = await convertPaper({ client: fakeClient, fileId: 'f', artboardId: 'root', maxNodes: 10, maxDepth: 1 });
    assertEqual(result.spec.elements.length, 1, '应生成 1 个元素');
    assertEqual(JSON.stringify(result.spec.elements[0].properties), JSON.stringify({
      paddingTop: '12px',
      display: 'flex',
      color: '#c72926',
      top: '0px',
      letterSpacing: '-0.02em',
      outlineColor: 'rgb(1, 2, 3)',
    }), '只保留可写进 ui-spec 的值');
    assertEqual(result.stats.collected, 6, 'collected 计数');
    assertEqual(result.stats.skipped, 10, 'skipped 计数');
    assertEqual(result.stats.skippedByProp.left, 1, 'left 计入 skippedByProp');
    assertEqual(result.stats.skippedByProp.position, 1, 'position 计入 skippedByProp');
    assert(!('width' in result.spec.elements[0].properties), 'var(--w) 应被跳过');
    assert(result.warnings.some((warning) => warning.includes('已跳过 10 个') && warning.includes('left×1')), 'warning 应汇总 skipped');
    validateSpec(result.spec);
  });

  await test('项目档案缺字段走默认值；未知档案与非法 designSource 报错', () => {
    const normalized = normalizeProfile({ id: 'sparse' });
    assertEqual(normalized.profile.devices.length, 1, '缺省设备档数量');
    assertEqual(normalized.profile.devices[0].width, 1440, '缺省设备宽度');
    assertEqual(normalized.profile.devices[0].height, 900, '缺省设备高度');
    assertEqual(normalized.profile.devices[0].dpr, 1, '缺省设备 DPR');
    assertEqual(normalized.profile.thresholds.score, DEFAULT_PROFILE.thresholds.score, '缺省合格线');
    assertEqual(normalized.profile.thresholds.maxRounds, DEFAULT_PROFILE.thresholds.maxRounds, '缺省轮次上限');
    assertEqual(normalized.profile.designSource.kind, 'none', '缺省设计源');
    assertEqual(normalized.profile.tokens.files.length, 0, '缺省 token 文件');
    assertEqual(normalized.profile.baseUrl, '', '缺省 baseUrl');

    const loaded = loadProfile('minimal', { cwd: ROOT });
    assertEqual(loaded.profile.id, 'minimal', '载入 minimal 档案');
    assertEqual(loaded.profile.devices[0].width, 1440, 'minimal 档案走默认设备');
    assert(loaded.path.endsWith('profiles/minimal.json') || loaded.path.endsWith('profiles\\minimal.json'), `档案路径：${loaded.path}`);

    assertThrows(() => loadProfile('no-such-profile', { cwd: ROOT }), /找不到项目档案/, '未知档案');
    assertThrows(() => normalizeProfile({ id: 'x', designSource: { kind: 'wysiwyg' } }), /designSource\.kind 非法/, '非法设计源');
  });

  await test('项目档案 api 段：默认关闭；非法值告警并退回安全缺省', () => {
    const sparse = normalizeProfile({ id: 'sparse' });
    assertEqual(sparse.profile.api.source, 'none', '缺省 api.source');
    assertEqual(sparse.profile.api.env, 'test', '缺省 api.env');
    assertEqual(sparse.profile.api.enabled, false, '缺省 api.enabled');
    assertEqual(sparse.profile.api.allow.length, 0, '缺省 api.allow');
    assertEqual(sparse.profile.api.authEnv, '', '缺省 api.authEnv');

    const configured = normalizeProfile({
      id: 'wired',
      api: { source: 'project', env: 'prod-readonly', enabled: true, allow: ['http://127.0.0.1:8080'], authEnv: 'APP_TOKEN' },
    });
    assertEqual(configured.profile.api.source, 'project', 'api.source 生效');
    assertEqual(configured.profile.api.env, 'prod-readonly', 'api.env 生效');
    assertEqual(configured.profile.api.enabled, true, 'api.enabled 生效');
    assertEqual(configured.profile.api.allow[0], 'http://127.0.0.1:8080', 'api.allow 生效');
    assertEqual(configured.profile.api.authEnv, 'APP_TOKEN', 'api.authEnv 生效');
    assertEqual(configured.warnings.length, 0, '合法 api 段不应告警');

    const warnings = [];
    const bad = normalizeProfile({ id: 'bad', api: { source: 'swagger', env: 'staging', allow: 'http://x' } }, { warnings });
    assertEqual(bad.profile.api.source, 'none', '非法 api.source 退回 none');
    assertEqual(bad.profile.api.env, 'test', '非法 api.env 退回 test');
    assertEqual(bad.profile.api.enabled, false, '未显式 enabled 时为 false');
    assertEqual(bad.profile.api.allow.length, 0, '非数组 allow 被忽略');
    assert(warnings.some((warning) => warning.includes('api.source')), 'api.source 告警');
    assert(warnings.some((warning) => warning.includes('api.env')), 'api.env 告警');
    assert(warnings.some((warning) => warning.includes('api.allow')), 'api.allow 告警');
  });

  await test('项目档案 design 段：默认 reference；from-scratch 原样生效；非法值告警回退', () => {
    const sparse = normalizeProfile({ id: 'sparse' });
    assertEqual(sparse.profile.design.mode, 'reference', '缺省 design.mode');
    assertEqual(sparse.profile.design.brief, '', '缺省 design.brief');
    assertEqual(sparse.profile.design.styleRefs.length, 0, '缺省 design.styleRefs');
    assertEqual(JSON.stringify(sparse.profile.design.outputs), JSON.stringify(['spec', 'mock']), '缺省 design.outputs');
    assertEqual(sparse.warnings.length, 0, '缺省 design 段不应告警');

    const configured = normalizeProfile({
      id: 'designed',
      design: {
        mode: 'from-scratch',
        brief: '给运营做一个活动落地页，风格跟随现有后台',
        styleRefs: ['src/views/a.vue', 'src/components/PageHeader.vue'],
        outputs: ['mock', 'paper'],
      },
    });
    assertEqual(configured.profile.design.mode, 'from-scratch', 'design.mode 生效');
    assertEqual(configured.profile.design.brief, '给运营做一个活动落地页，风格跟随现有后台', 'design.brief 生效');
    assertEqual(JSON.stringify(configured.profile.design.styleRefs), JSON.stringify(['src/views/a.vue', 'src/components/PageHeader.vue']), 'design.styleRefs 生效');
    assertEqual(JSON.stringify(configured.profile.design.outputs), JSON.stringify(['mock', 'paper']), 'design.outputs 生效');
    assertEqual(configured.warnings.length, 0, '合法 design 段不应告警');

    const warnings = [];
    const bad = normalizeProfile({
      id: 'bad',
      design: { mode: 'creative', styleRefs: 'src/views/a.vue', outputs: ['spec', 'diorama'] },
    }, { warnings });
    assertEqual(bad.profile.design.mode, 'reference', '非法 design.mode 退回 reference');
    assertEqual(bad.profile.design.styleRefs.length, 0, '非数组 design.styleRefs 被忽略');
    assertEqual(JSON.stringify(bad.profile.design.outputs), JSON.stringify(['spec']), 'design.outputs 非法值被过滤');
    assert(warnings.some((warning) => warning.includes('design.mode')), 'design.mode 告警');
    assert(warnings.some((warning) => warning.includes('design.styleRefs')), 'design.styleRefs 告警');
    assert(warnings.some((warning) => warning.includes('design.outputs')), 'design.outputs 告警');

    const nonArrayWarnings = [];
    const nonArray = normalizeProfile({ id: 'bad-non-array', design: { outputs: 'paper' } }, { warnings: nonArrayWarnings });
    assertEqual(JSON.stringify(nonArray.profile.design.outputs), JSON.stringify(['spec', 'mock']), '非数组 design.outputs 回默认 spec + mock');
    assert(nonArrayWarnings.some((warning) => warning.includes('design.outputs')), '非数组 design.outputs 告警');

    const emptyWarnings = [];
    const empty = normalizeProfile({ id: 'bad-empty', design: { outputs: ['diorama'] } }, { warnings: emptyWarnings });
    assertEqual(JSON.stringify(empty.profile.design.outputs), JSON.stringify(['spec', 'mock']), '全非法 design.outputs 回默认 spec + mock');
    assert(emptyWarnings.some((warning) => warning.includes('design.outputs')), '全非法 design.outputs 告警');
  });

  await test('探针页面采集函数语法自检 + 不引用模块作用域变量', () => {
    const sources = auditExpressionSource();
    assertEqual(sources.length, 2, '应导出两个页面采集函数');
    for (const source of sources) {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${source})`)();
      assertEqual(typeof fn, 'function', '页面采集函数应可解析');
    }
    assert(/getComputedStyle/.test(sources.join('\n')), '采集函数应读取计算样式');

    // page.evaluate 只序列化函数体：引用模块级常量会在浏览器里直接 ReferenceError。
    const moduleSource = readFileSync(new URL('../lib/probe.js', import.meta.url), 'utf8');
    const topLevel = [...moduleSource.matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((match) => match[1])
      .filter((name) => name !== 'pageAudit' && name !== 'pageReadStyles');
    const serialized = sources.join('\n');
    for (const name of topLevel) {
      assert(!new RegExp(`\\b${name}\\b`).test(serialized), `页面采集函数不能引用模块作用域标识符 ${name}`);
    }
  });

  // ---- 报告生成（合成 run：设计图 + 截图 + diff.json + probe.json + meta）

  const reportRun = join(baseDir, 'run-report');
  ensureDir(reportRun);
  const reportDesign = join(reportRun, 'design.png');
  const reportShot = join(reportRun, 'shot.png');
  const changedPng = makeDemoPng({ color: [220, 38, 38, 255] });
  writePng(join(reportRun, 'design.png'), pngBytes(designFile));
  writePng(reportShot, changedPng);
  const realDiff = diffImages(pngBytes(reportDesign), pngBytes(reportShot), { tolerance: 24, threshold: 0.01 });
  const diffPngPath = writePng(join(reportRun, 'diff.png'), realDiff.diffPng);
  writePng(join(reportRun, 'side-by-side.png'), realDiff.sideBySidePng);
  writeJsonFile(join(reportRun, 'diff.json'), {
    tool: 'dsh-ui-restore',
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    canvas: realDiff.canvas,
    score: realDiff.score,
    diffRatio: realDiff.diffRatio,
    mismatchPixels: realDiff.mismatchPixels,
    totalPixels: realDiff.totalPixels,
    regions: realDiff.regions,
    scale: realDiff.scale,
    sizeMismatch: realDiff.sizeMismatch,
    threshold: realDiff.threshold,
    tolerance: realDiff.tolerance,
    pass: realDiff.pass,
  });
  writeJsonFile(join(reportRun, 'probe.json'), {
    tool: 'dsh-ui-restore',
    version: '0.1.0',
    mode: 'spec',
    url: 'file:///demo/index.html',
    viewport: { width: 1440, height: 900, dpr: 1 },
    spec: { name: 'demo 基线', path: '', elements: 2, tolerance: { length: 0.5, number: 0.01, color: 0 } },
    checks: [
      { selector: '.btn-primary', label: '主操作', property: 'backgroundColor', expected: '#2563eb', actual: 'rgb(220, 38, 38)', delta: 197, deltaText: '通道最大差 197', severity: 'high', pass: false },
      { selector: '.card', label: '卡片', property: 'paddingTop', expected: '16px', actual: '16px', delta: 0, deltaText: '', severity: 'pass', pass: true },
    ],
    selectorMisses: [{ selector: '.missing', label: '缺失元素', invalid: false }],
    summary: { total: 2, passed: 1, failed: 1, high: 1, medium: 0, low: 0, selectorMisses: 1 },
  });
  const demoProfile = loadProfile('static-demo', { cwd: ROOT });
  mergeMeta(reportRun, {
    mode: 'design',
    url: 'file:///demo/index.html',
    viewport: { width: 200, height: 120, dpr: 1 },
    profile: profileSummary(demoProfile),
    artifacts: {
      design: 'design.png',
      shot: 'shot.png',
      diff: 'diff.png',
      sideBySide: 'side-by-side.png',
      diffJson: 'diff.json',
      probeJson: 'probe.json',
    },
    history: [
      { round: 1, score: 0.82 },
      { round: 2, score: realDiff.score },
    ],
  });

  let reportResult;
  await test('ui_report 产出 report.md + report.html（三图、差异表、无外链/无 JS/无 base64）', () => {
    reportResult = buildReport({ run: reportRun, cwd: ROOT, profile: profileSummary(demoProfile), locale: 'zh' });
    assert(existsSync(reportResult.markdownPath), 'report.md 应存在');
    assert(existsSync(reportResult.htmlPath), 'report.html 应存在');
    const html = readFileSync(reportResult.htmlPath, 'utf8');
    const markdown = readFileSync(reportResult.markdownPath, 'utf8');

    assert(/^<!doctype html>/i.test(html.trim()), 'HTML 应以 <!doctype html> 开头');
    assertEqual((html.match(/<img /g) ?? []).length, 3, 'HTML 应有三张图（设计稿/截图/热力图）');
    assert(html.includes('src="design.png"'), '应相对引用 design.png');
    assert(html.includes('src="shot.png"'), '应相对引用 shot.png');
    assert(html.includes('src="diff.png"'), '应相对引用 diff.png');
    assert(!/<script/i.test(html), 'HTML 不应包含任何 <script>');
    assert(!/src="https?:/i.test(html), 'HTML 不应引用外部图片');
    assert(!/href="https?:/i.test(html), 'HTML 不应有外链');
    assert(!/data:image/i.test(html), 'HTML 不应内联 base64 图片');
    assert(html.includes('sev-high'), '属性差异表应带严重度样式');
    assert(html.includes('backgroundColor'), '差异表应包含属性名');
    assert(html.includes('rgb(220, 38, 38)'), '差异表应包含实际值');
    assertEqual((html.match(/<table /g) ?? []).length >= 2, true, '应至少有区域表与差异表');
    assert(markdown.includes('](shot.png)'), 'Markdown 应引用截图');
    assert(/还原度|Fidelity/.test(markdown), 'Markdown 应有还原度分数');
    assertEqual(reportResult.summary.rounds, 2, '报告应读取两轮分数历史');
    assertEqual(reportResult.summary.regions, realDiff.regions.length, '区域数应与 diff 一致');
    assertEqual(reportResult.summary.mode, 'design', '模式应为 design');
    assert(html.includes('static-demo'), '夹具声明应包含档案 id');
    assert(html.includes('已知问题'), '夹具声明应包含已知问题标签');
    assert(html.includes('字体依赖系统字体栈') || markdown.includes('字体依赖系统字体栈'), '夹具声明应展开已知问题内容');
  });

  await test('ui_report 无设计稿模式与显式产物路径模式都能生成', () => {
    const explicit = buildReport({
      cwd: ROOT,
      design: reportDesign,
      shot: reportShot,
      diffPath: diffPngPath,
      diffJson: join(reportRun, 'diff.json'),
      probePath: join(reportRun, 'probe.json'),
      out: join(baseDir, 'report-explicit'),
      locale: 'zh',
    });
    assert(existsSync(explicit.htmlPath), '显式路径模式应生成 HTML');
    assert(existsSync(join(baseDir, 'report-explicit', 'design.png')), '设计稿应物化到报告目录');

    const probeOnly = buildReport({
      cwd: ROOT,
      probePath: join(reportRun, 'probe.json'),
      out: join(baseDir, 'report-probe-only'),
      mode: 'none',
      locale: 'zh',
    });
    const html = readFileSync(probeOnly.htmlPath, 'utf8');
    assert(html.includes('无设计稿'), '无设计稿模式应显示说明');
    assertEqual((html.match(/<img /g) ?? []).length, 0, '无图时应使用占位块');
  });

  await test('ui_report 审计模式：问题表与字号/间距/颜色分布都进 HTML', () => {
    const auditRun = join(baseDir, 'run-audit');
    ensureDir(auditRun);
    writePng(join(auditRun, 'shot.png'), pngBytes(designFile));
    writeJsonFile(join(auditRun, 'probe.json'), {
      tool: 'dsh-ui-restore',
      version: '0.1.0',
      mode: 'audit',
      url: 'file:///audit.html',
      viewport: { width: 1440, height: 900, dpr: 1 },
      summary: { total: 5, high: 2, medium: 2, low: 1 },
      issues: [
        { kind: 'overflow', severity: 'high', selector: 'html', detail: '页面出现横向滚动：scrollWidth 1620 > innerWidth 1440' },
        { kind: 'overflow', severity: 'high', selector: '.overflow-box', detail: '元素越出视口 160px' },
        { kind: 'alt', severity: 'medium', selector: 'img', detail: '图片缺少 alt：asset.svg' },
        { kind: 'focus', severity: 'medium', selector: 'button.no-focus', detail: '可交互元素没有可见焦点样式' },
        { kind: 'empty', severity: 'low', selector: '.empty-card', detail: '大块空白容器没有空态提示' },
      ],
      audit: {
        elementsScanned: 29,
        truncated: false,
        palette: [{ value: 'rgb(15, 23, 42)', count: 12 }],
        fontSizes: [{ value: '9px', count: 2 }],
        spacing: [{ value: '16px', count: 3 }],
        imagesWithoutAlt: 1,
        focusRisks: 2,
        emptyStates: 1,
        hardcodedColors: 1,
        overflow: 2,
        horizontalScroll: true,
      },
    });
    const report = buildReport({ run: auditRun, cwd: ROOT, mode: 'none', locale: 'zh' });
    const html = readFileSync(report.htmlPath, 'utf8');
    assert(html.includes('字号分布'), '应展示字号分布');
    assert(html.includes('9px×2'), '字号分布应带次数');
    assert(html.includes('间距分布') && html.includes('16px×3'), '应展示间距分布');
    assert(html.includes('颜色分布') && html.includes('rgb(15, 23, 42)'), '应展示颜色分布');
    assert(html.includes('overflow') && html.includes('button.no-focus'), '问题表应包含问题类型与选择器');
    assert(html.includes('审计模式'), '应说明当前为审计模式');
    // T6-L1：审计运行必须显式声明「本次未做设计比对」，不能让人误以为比对过。
    assert(html.includes('本次未做设计比对（审计运行）'), 'HTML 应显式声明审计运行未做设计比对');
    const auditMd = readFileSync(report.markdownPath, 'utf8');
    assert(auditMd.includes('本次未做设计比对（审计运行）'), 'Markdown 也应显式声明审计运行未做设计比对');
    assertEqual(report.summary.issues.total, 5, '报告摘要应带问题总数');
    assertEqual(report.summary.mode, 'none', '无设计稿模式');
  });

  await test('ui_report 声明一致：mode 以档案 designSource 为准，设备档分列本次视口/档案设备档', () => {
    const runDir = join(baseDir, 'run-declaration');
    ensureDir(runDir);
    writePng(join(runDir, 'shot.png'), pngBytes(designFile));
    mergeMeta(runDir, {
      mode: 'none',
      viewport: { width: 1280, height: 800, dpr: 1 },
      canvas: { width: 1000, height: 700 },
    });
    const profile = profileSummary(loadProfile('static-demo', { cwd: ROOT }));
    const report = buildReport({ run: runDir, cwd: ROOT, mode: 'none', profile, locale: 'zh' });
    assertEqual(report.summary.mode, 'design', '档案 designSource=image 时 mode 应为 design');
    assertEqual(report.summary.designSource, 'image', '设计源应保持档案声明');

    const html = readFileSync(report.htmlPath, 'utf8');
    const markdown = readFileSync(report.markdownPath, 'utf8');
    assert(html.includes('本次视口（截图/探针）'), 'HTML 应有本次视口行');
    assert(html.includes('1280×800'), '本次视口应展示实际尺寸');
    assert(html.includes('档案设备档') && html.includes('1440×900'), '档案设备档应单独展示 1440×900');
    assert(html.includes('差异画布') && html.includes('1000×700'), '差异画布应单独展示');
    assert(!html.includes('desktop · 1280×800'), '不能把档案设备 id 与实际尺寸混写');
    assert(html.includes('冲突'), '显式 mode 与档案冲突时应在报告提示');
    assert(!html.includes('无设计稿模式'), '档案为 image 时不应再输出无设计稿声明');
    assert(markdown.includes('本次视口') && markdown.includes('档案设备档'), 'Markdown 夹具声明应分列视口与设备档');
  });

  await test('ui_report 风格指标段：有数据时 Markdown/HTML 都输出，无数据时省略且无外链/脚本', () => {
    const styleRun = join(baseDir, 'run-report-style');
    ensureDir(styleRun);
    writePng(join(styleRun, 'design.png'), pngBytes(designFile));
    writePng(join(styleRun, 'shot.png'), changedPng);
    const style = {
      ...compareStyles(pngBytes(designFile), changedPng),
      reference: analyzeStyle(pngBytes(designFile)),
      output: analyzeStyle(changedPng),
    };
    writeJsonFile(join(styleRun, 'diff.json'), {
      tool: 'dsh-ui-restore',
      version: '0.1.0',
      generatedAt: new Date().toISOString(),
      score: 0.95,
      diffRatio: 0.05,
      threshold: 0.01,
      tolerance: 24,
      regions: [],
      style,
    });
    const report = buildReport({ run: styleRun, cwd: ROOT, locale: 'zh' });
    const html = readFileSync(report.htmlPath, 'utf8');
    const markdown = readFileSync(report.markdownPath, 'utf8');
    assert(html.includes('风格指标'), 'HTML 应含风格指标段');
    assert(markdown.includes('风格指标'), 'Markdown 应含风格指标段');
    assert(html.includes('色板距离') && html.includes('边缘密度') && html.includes('填充率'), 'HTML 应含风格指标明细');
    assert(markdown.includes('色板距离') && markdown.includes('边缘密度') && markdown.includes('填充率'), 'Markdown 应含风格指标明细');
    assert(html.includes('class="swatch"'), 'HTML 应展示色板色块');
    assert(html.includes('风格指标只作证据'), '应声明风格指标不参与判定');
    assert(!/<script/i.test(html), '风格指标段不应引入脚本');
    assert(!/src="https?:/i.test(html) && !/href="https?:/i.test(html), '风格指标段不应引入外链');
    assert(!/data:image/i.test(html), '风格指标段不应内嵌 base64');
    assert(report.model.style && report.model.style.score === style.score, '报告模型应带 style');

    // 向后兼容：没有 style 数据的报告（审计运行）不显示该段，也不出现锚点。
    const auditOnly = buildReport({
      cwd: ROOT,
      probePath: join(reportRun, 'probe.json'),
      out: join(baseDir, 'report-style-absent'),
      mode: 'none',
      locale: 'zh',
    });
    const auditHtml = readFileSync(auditOnly.htmlPath, 'utf8');
    const auditMarkdown = readFileSync(auditOnly.markdownPath, 'utf8');
    assert(!auditHtml.includes('风格指标'), '无 style 数据时 HTML 不应有风格指标段');
    assert(!auditMarkdown.includes('风格指标'), '无 style 数据时 Markdown 不应有风格指标段');
    assert(!auditHtml.includes('id="style"'), '无 style 数据时不应有 style 锚点');
  });

  await test('run 元数据：meta.json 记录产物、档案与分数历史', () => {
    const meta = readMeta(reportRun);
    assertEqual(meta.tool, 'dsh-ui-restore', 'meta.tool');
    assertEqual(meta.profile.id, 'static-demo', 'meta.profile.id');
    assertEqual(meta.history.length, 2, 'meta.history 轮次');
    assertEqual(meta.artifacts.shot, 'shot.png', 'meta.artifacts.shot');
    assert(meta.artifacts.reportHtml === 'report.html', 'ui_report 应把报告写回 meta.artifacts');
  });
}

// ---------------------------------------------------------------- 浏览器集

async function browserSuite(config) {
  const demo = (file) => join(ROOT, 'examples', 'static-demo', file);
  const browserRun = join(baseDir, 'run-browser');
  let designShot;
  let variantShot;

  await test('ui_capture：截图成功并返回像素尺寸/DPR', async () => {
    designShot = await capturePage({
      config,
      cwd: ROOT,
      url: demo('index.html'),
      width: 1440,
      height: 900,
      dpr: 1,
      path: join(browserRun, 'shot.png'),
    });
    assert(existsSync(designShot.path), '截图文件应存在');
    assertEqual(designShot.width, 1440, '截图像素宽（dpr=1）');
    assertEqual(designShot.height, 900, '截图像素高（dpr=1）');
    assertEqual(designShot.dpr, 1, 'DPR');
    assertEqual(designShot.cssWidth, 1440, 'CSS 宽度');
    const stat = statSync(designShot.path);
    assert(stat.size > 1000, '截图应有实际内容');
  });

  await test('ui_capture：同一页面重复截图，self-diff≈1', async () => {
    const second = join(browserRun, 'shot-self.png');
    await capturePage({ config, cwd: ROOT, url: demo('index.html'), width: 1440, height: 900, dpr: 1, path: second });
    const result = diffImages(readFileSync(designShot.path), readFileSync(second), { tolerance: 24, threshold: 0.01 });
    assert(result.score >= 0.999, `同页面重复截图应几乎一致，实际 ${result.score}`);
    assert(result.regions.length <= 1, `同页面重复截图不应出现大量区域，实际 ${result.regions.length}`);
  });

  await test('ui_diff：改一处后定位到改动区域（真实页面）', async () => {
    variantShot = await capturePage({
      config,
      cwd: ROOT,
      url: demo('variant.html'),
      width: 1440,
      height: 900,
      dpr: 1,
      path: join(browserRun, 'shot-variant.png'),
    });
    const result = diffImages(readFileSync(designShot.path), readFileSync(variantShot.path), { tolerance: 24, threshold: 0.005 });
    assert(result.score < 1, `有缺陷实现 score 应小于 1，实际 ${result.score}`);
    assert(result.regions.length >= 1, '应定位到至少一个差异区域');
    const severe = result.regions.filter((region) => region.severity === 'high');
    assert(severe.length >= 1, '主色错误应产生高严重度区域');
  });

  await test('ui_probe 审计模式：发现溢出/缺 alt/无焦点/硬编码色/可疑空态', async () => {
    const result = await runProbe({ config, cwd: ROOT, url: demo('audit.html'), width: 1440, height: 900, dpr: 1, waitMs: 200 });
    assertEqual(result.mode, 'audit', '模式应为 audit');
    const kinds = new Set((result.issues ?? []).map((issue) => issue.kind));
    assert(kinds.has('overflow'), `应发现溢出，实际 ${[...kinds].join(',')}`);
    assert(kinds.has('alt'), '应发现图片缺 alt');
    assert(kinds.has('focus'), '应发现缺可见焦点');
    assert(kinds.has('hardcoded'), '应发现内联硬编码颜色');
    assert(kinds.has('empty'), '应发现可疑空态');
    assert(result.summary.high >= 1, '应有高严重度问题');
    assert((result.audit?.fontSizes ?? []).some((entry) => entry.value === '9px'), '应统计到 9px 字号');
  });

  await test('ui_probe 契约模式：合法契约全通过，缺陷实现失败且分级', async () => {
    const good = await runProbe({
      config,
      cwd: ROOT,
      url: demo('index.html'),
      expected: demo('ui-spec.json'),
      width: 1440,
      height: 900,
      dpr: 1,
    });
    assertEqual(good.mode, 'spec', '模式应为 spec');
    assertEqual(good.selectorMisses.length, 0, '基准页不应有选择器缺失');
    assertEqual(good.summary.failed, 0, `基准页应全部通过，实际失败项：${JSON.stringify((good.checks ?? []).filter((check) => !check.pass))}`);
    assert(good.summary.passed >= 10, '契约应比较到多个属性');

    const bad = await runProbe({
      config,
      cwd: ROOT,
      url: demo('variant.html'),
      expected: demo('ui-spec.json'),
      width: 1440,
      height: 900,
      dpr: 1,
    });
    assert(bad.summary.failed >= 3, `缺陷实现应有多个失败项，实际 ${bad.summary.failed}`);
    assert(bad.summary.high >= 2, '主色与字号错误应为高严重度');
    const colorCheck = (bad.checks ?? []).find((check) => check.property === 'backgroundColor' && !check.pass);
    assert(colorCheck, '应报告背景色不一致');
    assert(colorCheck.actual.includes('220') || colorCheck.actual.includes('rgb'), '背景色实际值应可读');
  });

  await test('非法 expected 文件（未知属性/非法颜色/空选择器）报错', async () => {
    let error;
    try {
      await runProbe({ config, cwd: ROOT, url: demo('index.html'), expected: demo('ui-spec-invalid.json') });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof UiSpecError, `应抛 UiSpecError，实际 ${error?.name}: ${error?.message}`);
    assert(/widht/.test(error.message), '应指出未知属性');
    assert(/not-a-color/.test(error.message), '应指出非法颜色');
    assert(/selector/.test(error.message), '应指出空选择器');
    assert(/unknownTopLevel/.test(error.message), '应指出未知顶层字段');
  });

  await test('ui_report 的 HTML 能在真实浏览器打开，并包含三图与差异表', async () => {
    const runDir = browserRun;
    const result = diffImages(readFileSync(designShot.path), readFileSync(variantShot.path), { tolerance: 24, threshold: 0.005 });
    writePng(join(runDir, 'diff.png'), result.diffPng);
    writePng(join(runDir, 'side-by-side.png'), result.sideBySidePng);
    writePng(join(runDir, 'design.png'), readFileSync(designShot.path));
    writeJsonFile(join(runDir, 'diff.json'), {
      tool: 'dsh-ui-restore',
      version: '0.1.0',
      generatedAt: new Date().toISOString(),
      canvas: result.canvas,
      score: result.score,
      diffRatio: result.diffRatio,
      mismatchPixels: result.mismatchPixels,
      totalPixels: result.totalPixels,
      regions: result.regions,
      scale: result.scale,
      sizeMismatch: result.sizeMismatch,
      threshold: result.threshold,
      tolerance: result.tolerance,
      pass: result.pass,
    });
    // B5：报告浏览器用例要同时验证「区域表 + 属性差异表」。只给 diff 数据时报告只有区域表，
    // 因此这里补一份最小契约探针结果（真实走 buildSpecResult，不是手写 HTML 断言）。
    const spec = readSpecSource({
      version: 1,
      elements: [
        { selector: '.page-title', label: '页面标题', properties: { fontSize: '20px', fontWeight: 600 } },
        { selector: '.btn-primary', label: '主操作', properties: { backgroundColor: '#2563eb' } },
      ],
    }).spec;
    const probeResult = buildSpecResult(
      {
        url: 'file:///fake/index.html',
        title: 'fake',
        entries: spec.elements.map((element) => ({
          selector: element.selector,
          found: true,
          styles: Object.fromEntries(
            Object.entries(element.properties).map(([property, value]) => [property, String(value)]),
          ),
          rect: { x: 0, y: 0, width: 10, height: 10 },
        })),
      },
      spec,
      { width: result.canvas.width, height: result.canvas.height, dpr: 1 },
      '',
    );
    writeJsonFile(join(runDir, 'probe.json'), {
      tool: 'dsh-ui-restore',
      version: '0.1.0',
      generatedAt: new Date().toISOString(),
      profile: profileSummary(loadProfile('static-demo', { cwd: ROOT })),
      ...probeResult,
    });
    const report = buildReport({
      run: runDir,
      cwd: ROOT,
      profile: profileSummary(loadProfile('static-demo', { cwd: ROOT })),
      locale: 'zh',
    });

    const launched = await launchBrowser(config);
    try {
      const context = await launched.browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto(pathToFileURL(report.htmlPath).href, { waitUntil: 'load' });
      // 报告图片是本地文件、eager 加载；load 事件后仍可能在解码，先等图片真正就绪再断言。
      await page.waitForFunction(
        () => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0),
        undefined,
        { timeout: 10000 },
      ).catch(() => {});
      const probe = await page.evaluate(() => {
        const images = Array.from(document.images).map((image) => ({
          src: image.getAttribute('src'),
          loaded: image.complete && image.naturalWidth > 0,
          naturalWidth: image.naturalWidth,
        }));
        return {
          title: document.title,
          images,
          tables: document.querySelectorAll('table.data').length,
          rows: document.querySelectorAll('table.data tbody tr').length,
          tableRows: Array.from(document.querySelectorAll('table.data')).map((table) => table.tBodies[0]?.rows.length ?? 0),
          scripts: document.querySelectorAll('script').length,
          headings: Array.from(document.querySelectorAll('h2')).map((node) => node.textContent),
          hasScoreChart: Boolean(document.querySelector('svg.chart')),
          width: document.documentElement.scrollWidth,
        };
      });
      assertEqual(probe.scripts, 0, '页面不应加载任何脚本');
      assert(probe.images.length >= 3, `应有至少三张图，实际 ${probe.images.length}`);
      for (const image of probe.images) {
        assert(image.loaded, `图片应能相对加载：${image.src}`);
      }
      assert(probe.tables >= 2, `应有区域表与属性差异表两张表，实际 ${probe.tables}`);
      assert(
        probe.tableRows.length >= 2 && probe.tableRows.every((count) => count > 0),
        `区域表与属性差异表都应有数据行，实际 ${JSON.stringify(probe.tableRows)}`,
      );
      assert(probe.rows >= 1, '差异表应有数据行');
      assert(probe.headings.includes('属性差异'), '应有「属性差异」分区');
      assert(probe.hasScoreChart, '应渲染内联 SVG 分数曲线');
      assert(probe.width > 0, '页面应有内容宽度');
      assert(probe.headings.length >= 5, '应有多个分区标题');
      await page.setViewportSize({ width: 420, height: 900 });
      const narrow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      assert(narrow.scrollWidth <= narrow.innerWidth + 2, `窄屏不应横向溢出（${narrow.scrollWidth} > ${narrow.innerWidth}）`);
      await context.close();
    } finally {
      await launched.browser.close().catch(() => {});
    }
  });
}

// ---------------------------------------------------------------- 入口

console.log(`dsh-ui-restore selftest · 产物目录 ${baseDir}`);
if (withBrowser) console.log('模式：核心集 + 浏览器集（--browser）');
else console.log('模式：核心集（加 --browser 跑真实浏览器链路）');
console.log('');

await coreSuite();

if (withBrowser) {
  const config = {
    channels: ['chromium', 'chrome', 'msedge'],
    navigationTimeoutMs: 30000,
    settleMs: 250,
    tolerance: 24,
    locale: 'zh',
    freezeAnimations: true,
  };
  let available = true;
  let reason = '';
  try {
    const probe = await launchBrowser(config);
    await probe.browser.close();
  } catch (error) {
    available = false;
    reason = String(error.message).split('\n')[0];
  }
  if (!available) {
    skip('浏览器集（ui_capture / ui_diff / ui_probe / ui_report）', `没有可用浏览器：${reason}`);
  } else {
    await browserSuite(config);
  }
}

console.log('');
console.log(`结果：${passed} PASS / ${failed} FAIL / ${skipped} SKIP`);
if (results.some((entry) => entry.status === 'FAIL')) {
  console.log('失败用例：');
  for (const entry of results.filter((item) => item.status === 'FAIL')) console.log(`- ${entry.name}: ${entry.error}`);
}
console.log(`产物：${baseDir}`);
process.exit(failed > 0 ? 1 : 0);
