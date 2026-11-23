/**
 * dsh-ui-restore · 像素级差异
 *
 * 只用 Node 内置能力（node:zlib）读写 PNG，不依赖 canvas、native 模块或外部服务。
 *
 * 对齐规则（等价于 canvas 的 contain 缩放）：把截图按统一比例缩放，使整张截图
 * 完整落进设计稿画布，居中留白；缩放用面积平均（缩小）/双线性（放大），
 * 因此 2x DPR 截图缩到 1x 设计稿时不会引入采样偏移。画布外与留白都按白色
 * 参与比较，尺寸不一致不会掩盖缺失内容。
 *
 * @module dsh-ui-restore/diff
 */
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是合法的 PNG 文件（签名不匹配）');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** 读取 PNG 头部尺寸（比完整解码便宜）。 */
export function readPngSize(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是合法的 PNG 文件（签名或头部不完整）');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return {
    width,
    height,
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

function unfilter(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const output = Buffer.alloc(stride * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset];
    offset += 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[offset];
      offset += 1;
      const left = x >= bytesPerPixel ? output[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? output[prevStart + x] : 0;
      const upLeft = x >= bytesPerPixel && y > 0 ? output[prevStart + x - bytesPerPixel] : 0;
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          restored = value + predictor;
          break;
        }
        default:
          throw new Error(`PNG 行过滤类型非法：${filter}`);
      }
      output[rowStart + x] = restored & 0xff;
    }
  }
  return output;
}

/**
 * 解码 PNG 为 RGBA（8 位、非隔行）。
 * 支持颜色类型 0/2/3/4/6，调色板与 tRNS 透明。
 */
export function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) throw new Error('PNG 缺少 IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (width === 0 || height === 0) throw new Error('PNG 尺寸为 0');
  if (interlace !== 0) throw new Error('暂不支持隔行扫描（interlaced）PNG，请另存为标准 PNG');
  if (bitDepth !== 8) {
    throw new Error(`暂不支持 ${bitDepth} 位深 PNG（截图与设计稿请使用 8 位 PNG，16 位请先转换）`);
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 PNG 颜色类型：${colorType}`);

  const palette = chunks.find((chunk) => chunk.type === 'PLTE')?.data;
  const transparency = chunks.find((chunk) => chunk.type === 'tRNS')?.data;
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  if (idat.length === 0) throw new Error('PNG 缺少 IDAT 数据');

  const raw = inflateSync(idat);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new Error(`PNG 像素数据不完整（期望 ${(stride + 1) * height}，实际 ${raw.length}）`);
  }
  const pixels = unfilter(raw, width, height, channels);

  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0, src = 0; index < width * height; index += 1, src += channels) {
    let r;
    let g;
    let b;
    let a = 255;
    switch (colorType) {
      case 0: {
        r = pixels[src];
        g = r;
        b = r;
        if (transparency && transparency.length >= 2) {
          const key = transparency.readUInt16BE(0);
          if (r === key) a = 0;
        }
        break;
      }
      case 2: {
        r = pixels[src];
        g = pixels[src + 1];
        b = pixels[src + 2];
        if (transparency && transparency.length >= 6) {
          const kr = transparency.readUInt16BE(0);
          const kg = transparency.readUInt16BE(2);
          const kb = transparency.readUInt16BE(4);
          if (r === kr && g === kg && b === kb) a = 0;
        }
        break;
      }
      case 3: {
        const paletteIndex = pixels[src];
        if (!palette || palette.length < (paletteIndex + 1) * 3) {
          throw new Error('PNG 调色板数据缺失');
        }
        r = palette[paletteIndex * 3];
        g = palette[paletteIndex * 3 + 1];
        b = palette[paletteIndex * 3 + 2];
        if (transparency && paletteIndex < transparency.length) a = transparency[paletteIndex];
        break;
      }
      case 4: {
        r = pixels[src];
        g = r;
        b = r;
        a = pixels[src + 1];
        break;
      }
      default: {
        r = pixels[src];
        g = pixels[src + 1];
        b = pixels[src + 2];
        a = pixels[src + 3];
        break;
      }
    }
    const target = index * 4;
    rgba[target] = r;
    rgba[target + 1] = g;
    rgba[target + 2] = b;
    rgba[target + 3] = a;
  }
  return { width, height, rgba };
}

function writeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** 把 RGBA 编码成 8 位 PNG。 */
export function encodePng({ width, height, rgba }) {
  if (!(width > 0) || !(height > 0)) throw new Error('PNG 宽高必须为正');
  const stride = width * 4;
  if (rgba.length < stride * height) throw new Error('RGBA 数据长度不足');
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    for (let x = 0; x < stride; x += 1) raw[rowOffset + 1 + x] = rgba[y * stride + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', idat),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
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
 * 比较设计稿与截图。
 * @param {Buffer} designBuffer 设计稿 PNG
 * @param {Buffer} shotBuffer 截图 PNG
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
  const design = decodePng(designBuffer);
  const shot = decodePng(shotBuffer);
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
