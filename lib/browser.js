/**
 * dsh-ui-restore · 浏览器（playwright-core）
 *
 * 本机没有可复用的浏览器 service，插件自己启动 Chromium/Chrome/Edge：
 * 先试 Playwright 自带 chromium，再试系统 Chrome、系统 Edge；也可以用
 * config.executablePath 指定二进制。每次调用启动、用完关闭，避免常驻进程与
 * HMR 生命周期问题。工具只返回文件路径，图片由模型自行查看。
 *
 * playwright-core 的解析顺序：
 *   1. 包内 node_modules（npm 安装后）
 *   2. 环境变量 DSH_UI_RESTORE_PLAYWRIGHT 指向的包目录
 *   3. 当前 DSH profile 的 node_modules（DSH_PROFILE_DIR）
 *   4. DSH 安装目录的 node_modules（DSH_INSTALL_DIR）
 *
 * @module dsh-ui-restore/browser
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDir, resolveWorkspacePath } from './paths.js';
import { readPngSize } from './diff.js';

const DEFAULT_CHANNELS = ['chromium', 'chrome', 'msedge'];
const FREEZE_STYLE = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}`;

let cachedPlaywright;

function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, 240);
}

async function importPlaywrightDir(dir) {
  const candidates = [
    join(dir, 'index.mjs'),
    join(dir, 'index.js'),
  ];
  let lastError;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const module = await import(pathToFileURL(candidate).href);
      if (module.chromium) return module;
      if (module.default?.chromium) return module.default;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return undefined;
}

/**
 * 载入 playwright-core；失败时给出可执行的修复建议。
 * @returns {Promise<{ chromium: object }>}
 */
export async function loadPlaywright() {
  if (cachedPlaywright) return cachedPlaywright;
  const attempts = [];

  try {
    const module = await import('playwright-core');
    if (module.chromium) {
      cachedPlaywright = module;
      return cachedPlaywright;
    }
  } catch (error) {
    attempts.push(`playwright-core（包解析）：${firstLine(error.message)}`);
  }

  const envOverride = process.env.DSH_UI_RESTORE_PLAYWRIGHT;
  if (envOverride) {
    const dir = resolveWorkspacePath(process.cwd(), envOverride);
    try {
      const module = await importPlaywrightDir(dir);
      if (module) {
        cachedPlaywright = module;
        return cachedPlaywright;
      }
      attempts.push(`DSH_UI_RESTORE_PLAYWRIGHT=${dir}：目录下没有可用的 index.mjs/index.js`);
    } catch (error) {
      attempts.push(`DSH_UI_RESTORE_PLAYWRIGHT=${dir}：${firstLine(error.message)}`);
    }
  }

  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir) {
    const dir = join(profileDir, 'node_modules', 'playwright-core');
    if (existsSync(dir)) {
      try {
        const module = await importPlaywrightDir(dir);
        if (module) {
          cachedPlaywright = module;
          return cachedPlaywright;
        }
      } catch (error) {
        attempts.push(`profile node_modules：${firstLine(error.message)}`);
      }
    }
  }

  const installDir = process.env.DSH_INSTALL_DIR;
  if (installDir) {
    const dir = join(installDir, 'node_modules', 'playwright-core');
    if (existsSync(dir)) {
      try {
        const module = await importPlaywrightDir(dir);
        if (module) {
          cachedPlaywright = module;
          return cachedPlaywright;
        }
      } catch (error) {
        attempts.push(`DSH 安装目录 node_modules：${firstLine(error.message)}`);
      }
    }
  }

  throw new Error(
    '缺少 playwright-core，无法启动浏览器。\n'
    + '修复方式：在插件安装目录执行 `npm install playwright-core`，或设置环境变量 DSH_UI_RESTORE_PLAYWRIGHT 指向已安装的 playwright-core 目录。\n'
    + `已尝试：\n- ${attempts.join('\n- ') || '（无可用尝试）'}`,
  );
}

function normalizeChannels(config = {}) {
  const configured = Array.isArray(config.channels) && config.channels.length > 0
    ? config.channels
    : DEFAULT_CHANNELS;
  return configured.filter((channel) => typeof channel === 'string' && channel !== '');
}

/**
 * 启动浏览器，返回 browser 与命中的 channel。
 * @param {object} config 插件 config
 * @returns {Promise<{ browser: object, channel: string }>}
 */
export async function launchBrowser(config = {}) {
  const { chromium } = await loadPlaywright();
  const errors = [];
  const timeout = Number.isFinite(config.launchTimeoutMs) ? config.launchTimeoutMs : 30000;

  const attempt = async (label, options) => {
    try {
      const browser = await chromium.launch({ headless: true, timeout, ...options });
      return { browser, channel: label };
    } catch (error) {
      errors.push(`${label}：${firstLine(error.message)}`);
      return undefined;
    }
  };

  if (typeof config.executablePath === 'string' && config.executablePath !== '') {
    const executablePath = isAbsolute(config.executablePath)
      ? config.executablePath
      : resolve(config.executablePath);
    const result = await attempt(`executablePath=${executablePath}`, { executablePath });
    if (result) return result;
  }

  for (const channel of normalizeChannels(config)) {
    const result = await attempt(`channel=${channel}`, { channel });
    if (result) return result;
  }

  throw new Error(
    '无法启动浏览器，已尝试：\n'
    + `- ${errors.join('\n- ')}\n`
    + '修复方式：安装 Google Chrome 或 Microsoft Edge（channel 自动识别），'
    + '或执行 `npx playwright install chromium` 安装 Playwright 自带 Chromium，'
    + '或在插件配置里用 executablePath 指定浏览器二进制。',
  );
}

/**
 * 在一个新浏览器上下文里执行回调，结束后关闭浏览器。
 * @param {object} config 插件 config
 * @param {{ width: number, height: number, dpr?: number }} viewport
 * @param {(page: object, info: { context: object, channel: string }) => Promise<any>} callback
 * @param {{ launcher?: (config: object) => Promise<{ browser: object, channel: string }> }} [deps]
 *   仅用于测试注入假浏览器（默认走 launchBrowser）。
 */
export async function withPage(config, viewport, callback, deps = {}) {
  const launcher = deps.launcher ?? launchBrowser;
  const { browser, channel } = await launcher(config);
  try {
    const context = await browser.newContext({
      viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) },
      deviceScaleFactor: viewport.dpr ?? 1,
      ignoreHTTPSErrors: true,
      locale: config.locale === 'en' ? 'en-US' : 'zh-CN',
    });
    const page = await context.newPage();
    return await callback(page, { context, channel });
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 把本地路径或相对路径统一成 URL。 */
export function normalizeTarget(target, cwd) {
  if (typeof target !== 'string' || target.trim() === '') throw new Error('url 不能为空');
  const text = target.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('data:') || text.startsWith('about:')) {
    return text;
  }
  const absolute = resolveWorkspacePath(cwd, text);
  return pathToFileURL(absolute).href;
}

/** 打开页面并等待稳定（字体、动画、懒加载）。 */
export async function openTarget(page, target, config = {}, waitMs) {
  const timeout = Number.isFinite(config.navigationTimeoutMs) ? config.navigationTimeoutMs : 30000;
  const response = await page.goto(target, { waitUntil: 'load', timeout });
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 5000) });
  } catch {
    // 有长连接/轮询的页面永远不 idle，加载到 load 就足够。
  }
  if (config.freezeAnimations !== false) {
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addStyleTag({ content: FREEZE_STYLE });
    } catch {
      // 部分页面（如 PDF/资源）无法注入样式，不影响主流程。
    }
  }
  const settle = Number.isFinite(waitMs) ? waitMs : config.settleMs;
  if (Number.isFinite(settle) && settle > 0) await page.waitForTimeout(settle);
  return response;
}

/**
 * 截图并返回像素尺寸（PNG 实际尺寸，含 DPR 放大）。
 * @param {{
 *   config: object, cwd?: string, url: string,
 *   width: number, height: number, dpr?: number,
 *   fullPage?: boolean, selector?: string, path: string, waitMs?: number,
 *   launcher?: (config: object) => Promise<{ browser: object, channel: string }>
 * }} options launcher 仅用于测试注入假浏览器。
 */
export async function capturePage(options) {
  const {
    config = {},
    cwd,
    url,
    width,
    height,
    dpr = 1,
    fullPage = false,
    selector,
    path: targetPath,
    waitMs,
    launcher,
  } = options;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('width/height 必须是正数');
  }
  const target = normalizeTarget(url, cwd);
  ensureDir(dirname(resolveWorkspacePath(cwd, targetPath)));
  const absolutePath = resolveWorkspacePath(cwd, targetPath);

  const result = await withPage(config, { width, height, dpr }, async (page, { channel }) => {
    await openTarget(page, target, config, waitMs);
    if (selector) {
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (count === 0) throw new Error(`selector 在页面上没有匹配元素：${selector}`);
      await locator.screenshot({ path: absolutePath });
    } else {
      await page.screenshot({ path: absolutePath, fullPage: fullPage === true });
    }
    return { finalUrl: page.url(), title: await page.title().catch(() => ''), channel };
  }, { launcher });

  const size = readPngSize(readFileSync(absolutePath));
  return {
    path: absolutePath,
    width: size.width,
    height: size.height,
    dpr,
    cssWidth: width,
    cssHeight: height,
    fullPage: fullPage === true,
    selector: selector ?? '',
    url: result.finalUrl,
    title: result.title,
    channel: result.channel ?? '',
    profileDevice: options.profileDevice,
  };
}
