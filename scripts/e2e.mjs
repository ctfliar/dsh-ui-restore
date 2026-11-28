#!/usr/bin/env node
/**
 * dsh-ui-restore · 黄金 E2E（真实浏览器、file:// 夹具、无外网）
 *
 * 用 examples/static-demo/index.html 跑完整闭环：
 *   capture → 自比 diff → 契约探针（examples/static-demo/ui-spec.json）→ report
 *
 * 关键约束：
 * - 用 withBrowserSession 一次 launch 顺序完成 3 个视口截图 + 1 次契约探针，
 *   并打印「单独启动」与「复用 session」的耗时对比；
 * - 自比 diff 必须 score=1（同一页面同一视口重复截图）；
 * - 契约探针必须全过（含 selector 零缺失）；
 * - report.html 必须含三张图、无 <script>、无外链；
 * - 任一断言失败退出码非 0（CI 直接红）。
 *
 * 用法：
 *   node scripts/e2e.mjs                     # 产物写到 output/e2e/<时间戳>/
 *   node scripts/e2e.mjs --out output/e2e-local
 *   node scripts/e2e.mjs --channels chrome,msedge
 *
 * 环境变量：
 *   DSH_UI_RESTORE_CHANNELS=chromium,chrome,msedge   覆盖 channel 尝试顺序
 *   DSH_UI_RESTORE_EXECUTABLE=/path/to/chromium      指定浏览器二进制（优先于 channel）
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { capturePage, launchBrowser, withBrowserSession } from '../lib/browser.js';
import { diffImages, readPngSize } from '../lib/diff.js';
import { runProbe } from '../lib/probe.js';
import { buildReport } from '../lib/report.js';
import { analyzeStyle, compareStyleAnalyses } from '../lib/style.js';
import { loadProfile } from '../lib/profile.js';
import {
  TOOL_NAME,
  TOOL_VERSION,
  ensureDir,
  profileSummary,
  stamp,
} from '../lib/paths.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function argValue(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseChannels() {
  const fromArg = argValue('--channels');
  const fromEnv = process.env.DSH_UI_RESTORE_CHANNELS;
  const raw = fromArg ?? fromEnv ?? '';
  const list = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return list.length > 0 ? list : ['chromium', 'chrome', 'msedge'];
}

const outDir = ensureDir(argValue('--out')
  ? resolve(process.cwd(), argValue('--out'))
  : join(ROOT, 'output', 'e2e', stamp()));
const specPath = join(ROOT, 'examples', 'static-demo', 'ui-spec.json');
const demoPath = join(ROOT, 'examples', 'static-demo', 'index.html');
const demoUrl = pathToFileURL(demoPath).href;

const config = {
  channels: parseChannels(),
  navigationTimeoutMs: 30000,
  launchTimeoutMs: 30000,
  settleMs: 250,
  tolerance: 24,
  locale: 'zh',
  freezeAnimations: true,
};
if (process.env.DSH_UI_RESTORE_EXECUTABLE) config.executablePath = process.env.DSH_UI_RESTORE_EXECUTABLE;

const artifacts = {
  solo: join(outDir, 'solo-launch.png'),
  desktop: join(outDir, 'shot-desktop.png'),
  desktopSelf: join(outDir, 'shot-desktop-self.png'),
  mobile: join(outDir, 'shot-mobile.png'),
  design: join(outDir, 'design.png'),
  diff: join(outDir, 'diff.png'),
  sideBySide: join(outDir, 'side-by-side.png'),
  diffJson: join(outDir, 'diff.json'),
  probeJson: join(outDir, 'probe.json'),
};

let passed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  }
}

function assertArtifact(file, label) {
  assert(existsSync(file), `${label} 不存在：${file}`);
  const stat = statSync(file);
  assert(stat.isFile() && stat.size > 0, `${label} 为空：${file}`);
  return stat.size;
}

function pass(name, detail = '') {
  passed += 1;
  console.log(`PASS  ${name}${detail ? `（${detail}）` : ''}`);
}

function fmtMs(ms) {
  return `${ms}ms`;
}

function detailOf(value) {
  if (!value || typeof value !== 'object') return '';
  if (Number.isFinite(value.width) && Number.isFinite(value.height)) {
    return `${value.width}×${value.height} @${value.dpr ?? 1}x`;
  }
  if (value.summary && Number.isFinite(value.summary.total)) {
    return `${value.summary.passed}/${value.summary.total} 项通过`;
  }
  return '';
}

/** launchBrowser 的 channel 标签形如 channel=msedge，展示时去掉前缀。 */
function channelLabel(channel) {
  return String(channel ?? '').replace(/^channel=/, '');
}

async function main() {
  console.log('dsh-ui-restore 黄金 E2E');
  console.log(`仓库：${ROOT}`);
  console.log(`夹具：${demoUrl}`);
  console.log(`契约：${specPath}`);
  console.log(`产物：${outDir}`);
  console.log(`浏览器 channel 顺序：${config.channels.join(' → ')}${config.executablePath ? `（executablePath=${config.executablePath}）` : ''}`);
  console.log('');

  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  assert(
    nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 10),
    `Node.js 版本过低：${process.versions.node}（需要 >=20.10.0）`,
  );
  assert(demoUrl.startsWith('file://'), `夹具必须用 file:// 打开，实际 ${demoUrl}`);
  assert(existsSync(demoPath), `夹具不存在：${demoPath}`);
  assert(existsSync(specPath), `契约不存在：${specPath}`);
  pass('前置检查', `Node ${process.versions.node} · file:// 夹具 · ui-spec 存在`);

  // 基线 1：单独 launch 截图，作为耗时对比的基准（也验证现有 capturePage 行为不变）。
  const soloStartedAt = Date.now();
  const solo = await capturePage({
    config,
    cwd: ROOT,
    url: demoUrl,
    width: 1440,
    height: 900,
    dpr: 1,
    path: artifacts.solo,
  });
  const soloMs = Date.now() - soloStartedAt;
  assertArtifact(artifacts.solo, '单独启动截图');
  assertEqual(solo.width, 1440, '单独启动截图 PNG 宽');
  assertEqual(solo.height, 900, '单独启动截图 PNG 高');
  pass('capturePage（单独启动，行为不变）', `1440×900 @1x · ${fmtMs(soloMs)} · channel=${channelLabel(solo.channel)}`);

  // 基线 2：withBrowserSession 一次 launch，顺序跑 3 个视口 + 1 次契约探针。
  let launchCount = 0;
  const countingLauncher = async (launchConfig) => {
    launchCount += 1;
    return launchBrowser(launchConfig);
  };
  const session = await withBrowserSession(config, [
    {
      name: 'capture-desktop-1440x900',
      run: (s) => s.capture({
        cwd: ROOT,
        url: demoUrl,
        width: 1440,
        height: 900,
        dpr: 1,
        path: artifacts.desktop,
      }),
    },
    {
      name: 'capture-desktop-again',
      run: (s) => s.capture({
        cwd: ROOT,
        url: demoUrl,
        width: 1440,
        height: 900,
        dpr: 1,
        path: artifacts.desktopSelf,
      }),
    },
    {
      name: 'capture-mobile-390x844',
      run: (s) => s.capture({
        cwd: ROOT,
        url: demoUrl,
        width: 390,
        height: 844,
        dpr: 2,
        path: artifacts.mobile,
      }),
    },
    {
      name: 'probe-contract',
      run: (s) => runProbe({
        config,
        cwd: ROOT,
        url: demoUrl,
        expected: specPath,
        width: 1440,
        height: 900,
        dpr: 1,
        launcher: s.launcher,
      }),
    },
  ], { launcher: countingLauncher });

  assertEqual(launchCount, 1, 'withBrowserSession 必须只 launch 一次');
  assertEqual(session.results.length, 4, 'session 应顺序执行 4 个任务');
  pass('withBrowserSession 一次 launch', `4 个任务 · channel=${channelLabel(session.channel)} · ${fmtMs(session.elapsedMs)}`);

  const [desktop, desktopSelf, mobile, probeResult] = session.results.map((result) => result.value);

  assertArtifact(artifacts.desktop, '桌面截图');
  assertArtifact(artifacts.desktopSelf, '桌面重复截图');
  assertArtifact(artifacts.mobile, '移动端截图');
  assertEqual(desktop.width, 1440, '桌面截图 PNG 宽');
  assertEqual(desktop.height, 900, '桌面截图 PNG 高');
  assertEqual(mobile.width, 780, '移动端截图 PNG 宽（390 × dpr 2）');
  assertEqual(mobile.height, 1688, '移动端截图 PNG 高（844 × dpr 2）');
  assertEqual(mobile.dpr, 2, '移动端 DPR');
  pass('多视口截图', `1440×900 @1x · 390×844 @2x`);

  // ---- 自比 diff：同一页面同一视口重复截图必须完全一致 ----
  const desktopBuffer = readFileSync(artifacts.desktop);
  const selfBuffer = readFileSync(artifacts.desktopSelf);
  const selfDiff = diffImages(desktopBuffer, selfBuffer, { tolerance: 24, threshold: 0.01 });
  assertEqual(selfDiff.score, 1, '自比 score 必须为 1');
  assertEqual(selfDiff.diffRatio, 0, '自比差异率必须为 0');
  assertEqual(selfDiff.regions.length, 0, '自比不应出现差异区域');
  assertEqual(selfDiff.pass, true, '自比 pass 必须为 true');
  pass('自比 diff', `score=${selfDiff.score} · diffRatio=${selfDiff.diffRatio} · regions=${selfDiff.regions.length}`);

  // ---- 契约探针：基准页必须全过 ----
  assertEqual(probeResult.mode, 'spec', '探针应为契约模式');
  assertEqual(probeResult.selectorMisses.length, 0, `契约 selector 不应缺失：${JSON.stringify(probeResult.selectorMisses)}`);
  assertEqual(probeResult.summary.failed, 0, `契约必须全过，失败项：${JSON.stringify((probeResult.checks ?? []).filter((check) => !check.pass))}`);
  assertEqual(probeResult.summary.passed, probeResult.summary.total, '通过数应等于总检查数');
  assert((probeResult.checks ?? []).length >= 10, `契约检查项过少：${(probeResult.checks ?? []).length}`);
  assertEqual(probeResult.spec.elements, 6, '契约元素数');
  pass('契约探针', `${probeResult.summary.passed}/${probeResult.summary.total} 项通过 · selectorMisses=0`);

  // ---- 生成 report 需要的产物：design / diff / style / diff.json / probe.json ----
  copyFileSync(artifacts.desktop, artifacts.design);
  writeFileSync(artifacts.diff, selfDiff.diffPng);
  writeFileSync(artifacts.sideBySide, selfDiff.sideBySidePng);

  const referenceStyle = analyzeStyle(desktopBuffer);
  const outputStyle = analyzeStyle(selfBuffer);
  const style = compareStyleAnalyses(referenceStyle, outputStyle, { locale: config.locale });
  const desktopSize = readPngSize(desktopBuffer);
  const selfSize = readPngSize(selfBuffer);

  const diffPayload = {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    url: demoUrl,
    design: { path: artifacts.desktop, size: desktopSize },
    shot: { path: artifacts.desktopSelf, size: selfSize },
    canvas: selfDiff.canvas,
    score: selfDiff.score,
    diffRatio: selfDiff.diffRatio,
    mismatchPixels: selfDiff.mismatchPixels,
    totalPixels: selfDiff.totalPixels,
    regions: selfDiff.regions,
    droppedRegions: selfDiff.droppedRegions,
    scale: selfDiff.scale,
    sizeMismatch: selfDiff.sizeMismatch,
    style: {
      score: style.score,
      deltas: style.deltas,
      notes: style.notes,
      reference: referenceStyle,
      output: outputStyle,
    },
    threshold: selfDiff.threshold,
    tolerance: selfDiff.tolerance,
    pass: selfDiff.pass,
  };
  writeFileSync(artifacts.diffJson, `${JSON.stringify(diffPayload, null, 2)}\n`, 'utf8');

  const profile = loadProfile('static-demo', { cwd: ROOT });
  const probePayload = {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    profile: profileSummary(profile),
    ...probeResult,
  };
  writeFileSync(artifacts.probeJson, `${JSON.stringify(probePayload, null, 2)}\n`, 'utf8');
  pass('产物落盘', 'design.png · diff.png · side-by-side.png · diff.json · probe.json');

  const report = buildReport({
    cwd: ROOT,
    config,
    run: outDir,
    design: artifacts.design,
    shot: artifacts.desktop,
    diffPath: artifacts.diff,
    diffJson: artifacts.diffJson,
    probePath: artifacts.probeJson,
    locale: 'zh',
    profile: profileSummary(profile),
  });
  assertArtifact(report.markdownPath, 'report.md');
  assertArtifact(report.htmlPath, 'report.html');
  assertEqual(report.summary.score, 1, '报告 score 必须为 1');
  assertEqual(report.summary.pass, true, '报告判定应为 pass');
  assertEqual(report.summary.checks?.failed, 0, '报告探针失败数应为 0');
  pass('report', `score=${report.summary.score} · pass=${report.summary.pass} · report.md/html`);

  // ---- 报告硬约束：含图、无脚本、无外链 ----
  const html = readFileSync(report.htmlPath, 'utf8');
  const md = readFileSync(report.markdownPath, 'utf8');
  assert(!/<script\b/i.test(html), 'report.html 不得包含 <script>');
  assert(
    !/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(html),
    'report.html 不得引用外链（http/https/protocol-relative）',
  );
  assert(!/@import\s+url\(\s*["']?https?:/i.test(html), 'report.html 不得 @import 外链样式');
  const imgCount = (html.match(/<img\b/gi) ?? []).length;
  assert(imgCount >= 3, `report.html 至少应有 3 张图，实际 ${imgCount}`);
  for (const name of ['design.png', 'shot-desktop.png', 'diff.png']) {
    assert(html.includes(`src="${name}"`), `report.html 缺少图片引用：${name}`);
    assertArtifact(join(outDir, name), `报告图片 ${name}`);
  }
  assert(md.length > 200, 'report.md 内容过短');
  assert(/report|验收/i.test(md), 'report.md 应包含报告标题');
  pass('报告硬约束', `${imgCount} 张图 · 无 <script> · 无外链 · report.md/${html.length}B`);

  // ---- 产物总清单 ----
  for (const [key, file] of Object.entries(artifacts)) {
    assertArtifact(file, `产物 ${key}`);
  }
  pass('产物清单', `${Object.keys(artifacts).length} 个文件全部存在`);

  // ---- 耗时对比（只打印，不作断言，避免 CI 抖动误红） ----
  const estimatedSeparate = soloMs * session.results.length;
  const saved = estimatedSeparate - session.elapsedMs;
  const savedPercent = estimatedSeparate > 0 ? Math.round((saved / estimatedSeparate) * 100) : 0;
  console.log('');
  console.log('耗时对比（同一台机器、同一夹具）：');
  console.log(`- 单独启动截图：${fmtMs(soloMs)} / 次（launch + 页面加载 + 截图，channel=${channelLabel(solo.channel)}）`);
  for (const result of session.results) {
    const detail = detailOf(result.value);
    console.log(`- session 任务 ${result.name}：${fmtMs(result.elapsedMs)}${detail ? ` · ${detail}` : ''}`);
  }
  console.log(`- withBrowserSession：1 次 launch + ${session.results.length} 个任务 = ${fmtMs(session.elapsedMs)}`);
  console.log(`- 若每个任务各自启动 ≈ ${fmtMs(estimatedSeparate)}；本次节省 ≈ ${fmtMs(Math.max(0, saved))}（${Math.max(0, savedPercent)}%，按单次启动耗时估算，仅供趋势参考）`);
  console.log('');
  console.log(`结果：${passed} PASS / ${failures.length} FAIL`);
  console.log(`产物：${outDir}`);
}

try {
  await main();
} catch (error) {
  failures.push(error);
  console.error('');
  console.error('FAIL  黄金 E2E');
  console.error(error?.stack ?? String(error));
  if (existsSync(outDir)) console.error(`已写入的产物目录：${outDir}`);
  process.exit(1);
}
