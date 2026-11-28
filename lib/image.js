/**
 * dsh-ui-restore · 图像编解码（PNG / JPEG）
 *
 * 统一入口 decodeImage(buffer)：按文件头识别格式（不看扩展名），返回
 * `{ width, height, rgba, format }`。lib/diff.js（像素差异）与 lib/style.js（风格指标）
 * 都走这里，避免两个模块各写一套格式判断。
 *
 * PNG：纯 Node 编解码（node:zlib），支持 8 位、非隔行、颜色类型 0/2/3/4/6
 *      （含调色板与 tRNS 透明）。PNG 编解码器在本模块，lib/diff.js 继续
 *      re-export decodePng / encodePng，并提供兼容的 readPngSize（PNG/JPEG 尺寸），
 *      旧导入路径不变。
 * JPEG：jpeg-js（纯 JS，随包依赖）。支持单帧 8 位 baseline / progressive；
 *      不支持 12 位精度、算术编码、多帧；不处理 EXIF 方向（拍歪/带旋转信息的
 *      照片请先转正，或直接导出 PNG）。
 * 其他：WebP / GIF / BMP / TIFF / AVIF / HEIC / SVG 在文件头判定阶段就给出明确
 *      报错，提示先转成 PNG 或 JPEG——比让底层解码器抛「签名不匹配」更容易排查。
 *
 * @module dsh-ui-restore/image
 */
import { deflateSync, inflateSync } from 'node:zlib';

import jpeg from 'jpeg-js';

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

// ---------------------------------------------------------------- 格式识别

const FORMAT_LABELS = Object.freeze({
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
  tiff: 'TIFF',
  avif: 'AVIF/HEIC',
  svg: 'SVG',
  unknown: '未知',
});

/** 读字节区间为 ASCII（越界返回空串）。 */
function asciiAt(buffer, start, end) {
  if (buffer.length < end) return '';
  return buffer.toString('ascii', start, end);
}

function startsWith(buffer, bytes) {
  return buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));
}

/**
 * 按文件头识别图片格式，不看扩展名。
 * @param {Buffer} buffer
 * @returns {'png'|'jpeg'|'webp'|'gif'|'bmp'|'tiff'|'avif'|'svg'|'unknown'}
 */
export function sniffImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return 'unknown';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (asciiAt(buffer, 0, 4) === 'RIFF' && asciiAt(buffer, 8, 12) === 'WEBP') return 'webp';
  if (asciiAt(buffer, 0, 4) === 'GIF8') return 'gif';
  if (asciiAt(buffer, 0, 2) === 'BM') return 'bmp';
  if (asciiAt(buffer, 0, 4) === 'II*\u0000' || asciiAt(buffer, 0, 4) === 'MM\u0000*') return 'tiff';
  if (asciiAt(buffer, 4, 8) === 'ftyp' && /^(avif|avis|heic|heix|hevc|mif1|msf1)$/.test(asciiAt(buffer, 8, 12))) return 'avif';
  const head = buffer.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart().slice(0, 8).toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return 'unknown';
}

function formatHexPreview(buffer) {
  return buffer.subarray(0, 12).toString('hex').replace(/../g, '$& ').trim() || '（空）';
}

function unsupportedFormatError(format, buffer) {
  if (format === 'svg') {
    return new Error(
      '不支持 SVG 设计稿：SVG 是矢量图，请先导出为 PNG 或 JPEG 再比较（ui_diff 只比较位图）。',
    );
  }
  if (format === 'unknown') {
    return new Error(
      `无法识别的图像格式：dsh-ui-restore 只支持 PNG 与 JPEG（按文件头识别，不看扩展名）。文件头：${formatHexPreview(buffer)}`,
    );
  }
  return new Error(
    `不支持 ${FORMAT_LABELS[format]} 图片：dsh-ui-restore 只支持 PNG 与 JPEG（不支持 WebP/GIF/BMP/TIFF/AVIF 等）。请先转换为 PNG 或 JPEG 再重试。`,
  );
}

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const actual = input === null ? 'null' : typeof input;
  throw new TypeError(`图像解码需要 Buffer 或 Uint8Array，收到 ${actual}`);
}

// ---------------------------------------------------------------- PNG

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

/**
 * 读取 PNG 头部尺寸（比完整解码便宜）。
 * @param {Buffer} buffer
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,interlace:number}}
 */
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
  // 压缩级别 6 与 9 的 PNG 体积差约 6%，但编码耗时差约 3.8 倍（实测 380ms → 100ms）；
  // 差异图是排查用的中间产物，换时间更划算。
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    PNG_SIGNATURE,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', idat),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- JPEG

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * 扫 JPEG 段读尺寸（SOF 段）；顺带确认是 8 位精度，避免把 12 位文件拖到解码器里才报错。
 */
export function readJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('不是合法的 JPEG 文件（缺少 SOI 标记）');
  }
  let offset = 2;
  while (offset + 1 < buffer.length) {
    // 段与段之间可能有填充；标记前缀允许连续多个 0xFF。
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    // 无长度的独立标记：SOI / EOI / TEM / RSTn
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2) throw new Error(`JPEG 段长度非法：${length}`);
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 8 > buffer.length) throw new Error('JPEG SOF 段不完整，无法读取尺寸');
      const precision = buffer[offset + 2];
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (precision !== 8) {
        throw new Error(`暂不支持 ${precision} 位精度 JPEG（jpeg-js 只支持 8 位；请先转换为 8 位 JPEG 或 PNG）`);
      }
      if (width === 0 || height === 0) throw new Error('JPEG 尺寸为 0');
      return {
        width,
        height,
        precision,
        components: buffer[offset + 7],
        progressive: marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce,
      };
    }
    if (marker === 0xda) break; // SOS 之后是熵编码数据，不会再出现 SOF
    offset += length;
  }
  throw new Error('JPEG 缺少 SOF 段，无法读取尺寸（文件可能被截断）');
}

/** 解码 JPEG 为 RGBA（jpeg-js；JPEG 没有透明通道，alpha 恒为 255）。 */
function decodeJpeg(buffer) {
  let decoded;
  try {
    decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  } catch (error) {
    throw new Error(
      `JPEG 解码失败：${error.message}。jpeg-js 只支持单帧 8 位 baseline/progressive JPEG；`
      + '12 位、算术编码、多帧或损坏文件请先用图片工具转成 PNG。',
    );
  }
  const width = decoded.width;
  const height = decoded.height;
  if (!(width > 0) || !(height > 0)) throw new Error(`JPEG 尺寸非法：${width}×${height}`);
  const rgba = decoded.data instanceof Uint8Array ? decoded.data : Uint8Array.from(decoded.data);
  if (rgba.length < width * height * 4) {
    throw new Error(`JPEG 像素数据不完整（期望 ${width * height * 4}，实际 ${rgba.length}）`);
  }
  return { width, height, rgba, format: 'jpeg' };
}

// ---------------------------------------------------------------- 统一入口

/**
 * 解码图片（PNG / JPEG，按文件头识别）。
 * @param {Buffer|Uint8Array} input 图片文件缓冲
 * @returns {{width:number,height:number,rgba:Uint8Array,format:'png'|'jpeg'}}
 */
export function decodeImage(input) {
  const buffer = asBuffer(input);
  if (buffer.length === 0) throw new Error('图像数据为空，无法解码');
  const format = sniffImageFormat(buffer);
  if (format === 'png') return { ...decodePng(buffer), format };
  if (format === 'jpeg') return decodeJpeg(buffer);
  throw unsupportedFormatError(format, buffer);
}

/**
 * 读取图片尺寸（PNG 走 IHDR，JPEG 走 SOF 段；不完整解码）。
 * @param {Buffer|Uint8Array} input 图片文件缓冲
 * @returns {{width:number,height:number,format:'png'|'jpeg'}} PNG 额外带 bitDepth/colorType/interlace，JPEG 额外带 precision/components/progressive
 */
export function readImageSize(input) {
  const buffer = asBuffer(input);
  const format = sniffImageFormat(buffer);
  if (format === 'png') return { ...readPngSize(buffer), format };
  if (format === 'jpeg') return { ...readJpegSize(buffer), format };
  throw unsupportedFormatError(format, buffer);
}
