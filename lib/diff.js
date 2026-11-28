/**
 * dsh-ui-restore · 像素级差异
 *
 * 编解码不在这里：PNG/JPEG 的统一解码由 image.js 的 decodeImage 负责（PNG 用内置
 * node:zlib 解码器，JPEG 用 jpeg-js），本模块只做对齐、逐像素比较与产物渲染；
 * 输出图固定为 PNG。PNG 编解码器整体搬到 image.js，这里 re-export 保持旧导入路径。
 *
 * 对齐规则（等价于 canvas 的 contain 缩放）：把截图按统一比例缩放，使整张截图
 * 完整落进设计稿画布，居中留白；缩放用面积平均（缩小）/双线性（放大），
 * 因此 2x DPR 截图缩到 1x 设计稿时不会引入采样偏移。画布外与留白都按白色
 * 参与比较，尺寸不一致不会掩盖缺失内容。
 *
 * @module dsh-ui-restore/diff
 */
import { decodeImage, decodePng, encodePng, readImageSize } from './image.js';

export { decodePng, encodePng };

/**
 * 兼容旧名：按文件头识别 PNG/JPEG 后读取尺寸（实现见 image.js 的 readImageSize）。
 * lib/browser.js、lib/report.js 与自测仍从 diff.js 取这个名字。
 */
export function readPngSize(buffer) {
  return readImageSize(buffer);
}

/** 把 RGBA 合成到白底，返回 RGB 三通道缓冲。 */
export function compositeOnWhite(rgba) {
  const pixels = rgba.length / 4;
  const rgb = new Uint8Array(pixels * 3);
  for (let index = 0; index < pixels; index += 1) {
    const source = index * 4;
    const alpha = rgba[source + 3] / 255;
    const target = index * 3;
    rgb[target] = Math.round(rgba[source] * alpha + 255 * (1 - alpha));
    rgb[target + 1] = Math.round(rgba[source + 1] * alpha + 255 * (1 - alpha));
    rgb[target + 2] = Math.round(rgba[source + 2] * alpha + 255 * (1 - alpha));
  }
  return rgb;
}

/** RGB → RGBA（不透明）。 */
function rgbToRgba(rgb, width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0, src = 0, dst = 0; index < width * height; index += 1, src += 3, dst += 4) {
    rgba[dst] = rgb[src];
    rgba[dst + 1] = rgb[src + 1];
    rgba[dst + 2] = rgb[src + 2];
    rgba[dst + 3] = 255;
  }
  return rgba;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * 面积平均（缩小）/ 双线性（放大）重采样 RGB。
 */
export function resampleRgb(src, srcWidth, srcHeight, dstWidth, dstHeight) {
  const dst = new Uint8Array(dstWidth * dstHeight * 3);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  const downscale = dstWidth <= srcWidth && dstHeight <= srcHeight;

  if (downscale) {
    for (let y = 0; y < dstHeight; y += 1) {
      const y0 = Math.floor(y * scaleY);
      const y1 = Math.min(srcHeight, Math.max(y0 + 1, Math.ceil((y + 1) * scaleY)));
      for (let x = 0; x < dstWidth; x += 1) {
        const x0 = Math.floor(x * scaleX);
        const x1 = Math.min(srcWidth, Math.max(x0 + 1, Math.ceil((x + 1) * scaleX)));
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let sy = y0; sy < y1; sy += 1) {
          let offset = (sy * srcWidth + x0) * 3;
          for (let sx = x0; sx < x1; sx += 1) {
            r += src[offset];
            g += src[offset + 1];
            b += src[offset + 2];
            offset += 3;
            count += 1;
          }
        }
        const target = (y * dstWidth + x) * 3;
        dst[target] = Math.round(r / count);
        dst[target + 1] = Math.round(g / count);
        dst[target + 2] = Math.round(b / count);
      }
    }
    return dst;
  }

  for (let y = 0; y < dstHeight; y += 1) {
    const sy = clamp((y + 0.5) * scaleY - 0.5, 0, srcHeight - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcHeight - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dstWidth; x += 1) {
      const sx = clamp((x + 0.5) * scaleX - 0.5, 0, srcWidth - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * srcWidth + x0) * 3;
      const i10 = (y0 * srcWidth + x1) * 3;
      const i01 = (y1 * srcWidth + x0) * 3;
      const i11 = (y1 * srcWidth + x1) * 3;
      const target = (y * dstWidth + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const top = src[i00 + channel] * (1 - fx) + src[i10 + channel] * fx;
        const bottom = src[i01 + channel] * (1 - fx) + src[i11 + channel] * fx;
        dst[target + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return dst;
}

function luma(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/**
 * 生成差异热力图：底图为对齐截图的低对比灰度，差异像素标红。
 */
function buildHeatmap(aligned, width, height, mask) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * 3;
    const gray = luma(aligned[source], aligned[source + 1], aligned[source + 2]);
    const dim = Math.round(255 - (255 - gray) * 0.45);
    const target = index * 4;
    if (mask[index]) {
      rgba[target] = Math.round(dim * 0.12 + 230 * 0.88);
      rgba[target + 1] = Math.round(dim * 0.12 + 57 * 0.88);
      rgba[target + 2] = Math.round(dim * 0.12 + 70 * 0.88);
      rgba[target + 3] = 255;
    } else {
      rgba[target] = dim;
      rgba[target + 1] = dim;
      rgba[target + 2] = dim;
      rgba[target + 3] = 255;
    }
  }
  return rgba;
}

/** 生成左右对照图（设计稿 | 对齐后的截图），中间 12px 分隔。 */
function buildSideBySide(design, aligned, width, height) {
  const gutter = 12;
  const totalWidth = width * 2 + gutter;
  const rgba = new Uint8Array(totalWidth * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const designIndex = (y * width + x) * 3;
      const leftTarget = (y * totalWidth + x) * 4;
      rgba[leftTarget] = design[designIndex];
      rgba[leftTarget + 1] = design[designIndex + 1];
      rgba[leftTarget + 2] = design[designIndex + 2];
      rgba[leftTarget + 3] = 255;

      const shotTarget = (y * totalWidth + width + gutter + x) * 4;
      rgba[shotTarget] = aligned[designIndex];
      rgba[shotTarget + 1] = aligned[designIndex + 1];
      rgba[shotTarget + 2] = aligned[designIndex + 2];
      rgba[shotTarget + 3] = 255;
    }
    for (let gx = width; gx < width + gutter; gx += 1) {
      const target = (y * totalWidth + gx) * 4;
      rgba[target] = 226;
      rgba[target + 1] = 232;
      rgba[target + 2] = 240;
      rgba[target + 3] = 255;
    }
  }
  return { width: totalWidth, height, rgba };
}

const NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

function severityForRegion(pixels, total) {
  if (pixels >= 2000 || pixels / total >= 0.005) return 'high';
  if (pixels >= 200 || pixels / total >= 0.0005) return 'medium';
  return 'low';
}

/**
 * 连通域标记：8 邻接，输出包围盒列表。
 */
function findRegions(mask, width, height, { minPixels = 12, maxRegions = 24 } = {}) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const regions = [];
  const total = width * height;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let pixels = 0;
    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = (index - x) / width;
      pixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
    if (pixels >= minPixels) {
      regions.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        pixels,
        ratio: Number((pixels / total).toFixed(4)),
        severity: severityForRegion(pixels, total),
      });
    }
  }
  regions.sort((a, b) => b.pixels - a.pixels);
  const kept = regions.slice(0, maxRegions).map((region, index) => ({ index: index + 1, ...region }));
  const dropped = regions.slice(maxRegions);
  const droppedPixels = dropped.reduce((sum, region) => sum + region.pixels, 0);
  return { regions: kept, dropped: dropped.length, droppedPixels };
}

/**
 * 比较设计稿与截图（PNG / JPEG 均可，按文件头识别；输出固定 PNG）。
 * @param {Buffer} designBuffer 设计稿图片（PNG/JPEG）
 * @param {Buffer} shotBuffer 截图图片（PNG/JPEG）
 * @param {{ tolerance?: number, threshold?: number, minRegionPixels?: number, maxRegions?: number }} [options]
 * @returns {{
 *   score: number, diffRatio: number, mismatchPixels: number, totalPixels: number,
 *   regions: object[], droppedRegions: number, scale: number,
 *   sizeMismatch: object, canvas: {width:number,height:number},
 *   diffPng: Buffer, sideBySidePng: Buffer, threshold: number, tolerance: number, pass: boolean
 * }}
 */
export function diffImages(designBuffer, shotBuffer, options = {}) {
  const tolerance = Number.isFinite(options.tolerance) ? Math.max(0, Math.min(255, options.tolerance)) : 24;
  const threshold = Number.isFinite(options.threshold) ? Math.max(0, Math.min(1, options.threshold)) : 0.01;
  const design = decodeImage(designBuffer);
  const shot = decodeImage(shotBuffer);
  const designRgb = compositeOnWhite(design.rgba);
  const shotRgb = compositeOnWhite(shot.rgba);

  const width = design.width;
  const height = design.height;
  const scale = Math.min(width / shot.width, height / shot.height);
  const resizedWidth = Math.max(1, Math.round(shot.width * scale));
  const resizedHeight = Math.max(1, Math.round(shot.height * scale));
  const scaled = resizedWidth === shot.width && resizedHeight === shot.height
    ? shotRgb
    : resampleRgb(shotRgb, shot.width, shot.height, resizedWidth, resizedHeight);

  const aligned = new Uint8Array(width * height * 3).fill(255);
  const offsetX = Math.max(0, Math.floor((width - resizedWidth) / 2));
  const offsetY = Math.max(0, Math.floor((height - resizedHeight) / 2));
  const copyWidth = Math.min(resizedWidth, width - offsetX);
  const copyHeight = Math.min(resizedHeight, height - offsetY);
  for (let y = 0; y < copyHeight; y += 1) {
    const sourceStart = y * resizedWidth * 3;
    const targetStart = ((y + offsetY) * width + offsetX) * 3;
    aligned.set(scaled.subarray(sourceStart, sourceStart + copyWidth * 3), targetStart);
  }

  const mask = new Uint8Array(width * height);
  let mismatchPixels = 0;
  for (let index = 0; index < width * height; index += 1) {
    const source = index * 3;
    const delta = Math.max(
      Math.abs(designRgb[source] - aligned[source]),
      Math.abs(designRgb[source + 1] - aligned[source + 1]),
      Math.abs(designRgb[source + 2] - aligned[source + 2]),
    );
    if (delta > tolerance) {
      mask[index] = 1;
      mismatchPixels += 1;
    }
  }

  const totalPixels = width * height;
  const diffRatio = Number((mismatchPixels / totalPixels).toFixed(4));
  const score = Number((1 - mismatchPixels / totalPixels).toFixed(4));
  const regionResult = findRegions(mask, width, height, {
    minPixels: Number.isFinite(options.minRegionPixels) ? options.minRegionPixels : 12,
    maxRegions: Number.isFinite(options.maxRegions) ? options.maxRegions : 24,
  });
  const heatmap = buildHeatmap(aligned, width, height, mask);
  const sideBySide = buildSideBySide(designRgb, aligned, width, height);

  return {
    score,
    diffRatio,
    mismatchPixels,
    totalPixels,
    regions: regionResult.regions,
    droppedRegions: regionResult.dropped,
    droppedPixels: regionResult.droppedPixels,
    scale: Number(scale.toFixed(4)),
    sizeMismatch: {
      design: { width: design.width, height: design.height },
      shot: { width: shot.width, height: shot.height },
      rescaled: { width: resizedWidth, height: resizedHeight },
      offset: { x: offsetX, y: offsetY },
      aspectDelta: Number(Math.abs(width / height - shot.width / shot.height).toFixed(4)),
      mismatch: Math.abs(width / height - shot.width / shot.height) > 0.01,
    },
    canvas: { width, height },
    diffPng: encodePng({ width, height, rgba: heatmap }),
    sideBySidePng: encodePng({ width: sideBySide.width, height: sideBySide.height, rgba: sideBySide.rgba }),
    threshold,
    tolerance,
    pass: diffRatio <= threshold,
  };
}

/** 把 RGBA 缓冲转成 PNG（供自制夹具与测试使用）。 */
export function rgbaToPng(width, height, rgba) {
  return encodePng({ width, height, rgba });
}

/** 便捷：由 RGB 缓冲生成 PNG。 */
export function rgbToPng(width, height, rgb) {
  return encodePng({ width, height, rgba: rgbToRgba(rgb, width, height) });
}
