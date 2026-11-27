/**
 * dsh-ui-restore · 风格指标
 *
 * 纯 Node 实现的「风格指纹」：只解码 PNG（复用 diff.js 的 decodePng / compositeOnWhite），
 * 不依赖浏览器、canvas、native 模块或外部服务。指标只作证据使用——本模块不返回 pass/fail，
 * 也不参与 ui_diff 的判定；阈值与权重集中在本文件顶部常量里，方便回测与调参。
 *
 * 指标口径（除 width/height/colorCount 外均归一化到 0-1）：
 * - background   背景色：全图占比最高的量化主色及其占比（不把白底当成内容主色）
 * - palette      全图前 8 主色（兼容字段，白底会占据头部，仅用于展示/排查）
 * - contentPalette 内容色板：先剔除与背景色相近的像素，再取内容像素中占比最高的前 16 色；
 *                ratio 在这些主色内归一（用于色板比较，避免大面积白底稀释色相）
 * - colorCount   全图量化后不同颜色数（5 位/通道，最多 32768 个桶）
 * - meanLuma     平均相对亮度（Rec.601，再除以 255）
 * - meanSat      平均 HSL 饱和度（(max-min)/max）
 * - flatRatio    全图前 3 主色覆盖率（越高画面越「平」，大片纯色）
 * - edgeDensity  相邻像素亮度梯度超过阈值的像素占比
 * - fillRatio    与背景色通道差超过阈值的像素占比（内容填充率）
 * - bbox         内容像素的包围盒；没有内容时宽高为 0
 *
 * 色板距离（paletteDistance）：
 *   backgroundDistance = clamp(ΔE76(backgroundRef, backgroundOut) / backgroundScale, 0, 1)
 *   contentDistance    = EMD(contentPaletteRef, contentPaletteOut)
 *   paletteDistance    = backgroundWeight × backgroundDistance + contentWeight × contentDistance
 * 其中 EMD 在 CIELAB 空间做双向质量匹配：按「距离最近优先」分配两侧质量，距离按
 * sqrt((ΔL·lightnessWeight)² + Δa² + Δb²) / labScale 归一（降低明度权重、突出色相/彩度）；
 * 超过 maxMatchDistance 的颜色对不参与匹配，剩余质量按「未匹配色质量」以满惩罚计入。
 *
 * 分项差异（deltas）：相对差 |a-b| / max(a, b, floor)，避免 0.007 级绝对差被权重压没。
 *
 * 风格分：
 *   penalty = Σ(weight_i × delta_i) / Σ(weight_i)
 *   score   = clamp(1 - penalty, 0, 1)
 * delta 全部归一化到 0-1；权重见 STYLE_CONSTANTS.scoreWeights。风格分只作证据，
 * 不参与 ui_diff 的 pass/threshold 判定。
 *
 * @module dsh-ui-restore/style
 */
import { compositeOnWhite, decodePng } from './diff.js';

/** 全部阈值与权重集中在这里，便于回测；修改会同时影响 analyzeStyle 与 compareStyles。 */
export const STYLE_CONSTANTS = Object.freeze({
  /** 主色板量化位数（5 位/通道 → 32768 个颜色桶）。 */
  quantizationBits: 5,
  /** palette（全图主色）保留数量，保持兼容。 */
  paletteSize: 8,
  /** contentPalette（内容色板）保留数量；用于色板距离的 EMD。 */
  contentPaletteSize: 16,
  /** flatRatio 统计的全图主色数量。 */
  flatTopColors: 3,
  /** 内容像素判定：与背景色的单通道最大差超过该值（0-255）。 */
  fillTolerance: 24,
  /** 边缘像素判定：相邻像素亮度梯度超过该值（0-255）。 */
  edgeThreshold: 24,
  /** CIELAB 色差归一化尺度；越小对色相/彩度差异越敏感。 */
  labScale: 60,
  /** Lab ΔL 权重；低于 1 表示更看重色相/彩度而不是明度。 */
  lightnessWeight: 0.2,
  /** EMD 允许匹配的最大归一化色差；超过即计入「未匹配色质量」。 */
  maxMatchDistance: 0.55,
  /** 背景色 Lab 差归一化尺度（背景差异单独放大）。 */
  backgroundScale: 40,
  /** paletteDistance 中背景色与内容色板的权重。 */
  backgroundWeight: 0.35,
  contentWeight: 0.65,
  /** 分项相对差的分母下限，避免极小值放大噪声。 */
  deltaFloors: Object.freeze({
    luma: 0.1,
    sat: 0.02,
    edgeDensity: 0.01,
    fillRatio: 0.01,
  }),
  /** 风格分权重（会被归一化，允许不写满 1）。 */
  scoreWeights: Object.freeze({
    palette: 0.55,
    luma: 0.1,
    sat: 0.15,
    edgeDensity: 0.1,
    fillRatio: 0.1,
  }),
  /** notes 里「明显差异」的提示阈值（分项 delta 为相对差）。 */
  noteThresholds: Object.freeze({
    palette: 0.2,
    luma: 0.12,
    sat: 0.15,
    edgeDensity: 0.15,
    fillRatio: 0.12,
  }),
});

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}

function lumaOf(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function toHex(r, g, b) {
  const channel = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function parseHex(color) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color ?? ''));
  if (!match) return [255, 255, 255];
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** sRGB → CIELAB（D65）。色板比较用 Lab，a/b 分量直接反映色相与彩度。 */
function hexToLab(color) {
  const [r8, g8, b8] = parseHex(color);
  const linear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const r = linear(r8 / 255);
  const g = linear(g8 / 255);
  const b = linear(b8 / 255);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (value) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** 色相/彩度敏感的颜色距离：降低 ΔL 权重后按 labScale 归一。 */
function colorDistance(labA, labB) {
  const dl = (labA[0] - labB[0]) * STYLE_CONSTANTS.lightnessWeight;
  const da = labA[1] - labB[1];
  const db = labA[2] - labB[2];
  return Math.min(1, Math.sqrt(dl * dl + da * da + db * db) / STYLE_CONSTANTS.labScale);
}

/** 背景色距离：单独归一，背景差异有独立权重。 */
function backgroundDistance(backgroundA, backgroundB) {
  const labA = hexToLab(backgroundA?.color);
  const labB = hexToLab(backgroundB?.color);
  const delta = Math.sqrt((labA[0] - labB[0]) ** 2 + (labA[1] - labB[1]) ** 2 + (labA[2] - labB[2]) ** 2);
  return clamp01(delta / STYLE_CONSTANTS.backgroundScale);
}

/**
 * 双向质量匹配（EMD 近似）：按距离从近到远分配两侧质量；
 * 距离超过 maxMatchDistance 的颜色对不匹配，剩余质量按「未匹配色质量」满惩罚。
 */
function contentDistance(refPalette, outPalette) {
  const ref = refPalette ?? [];
  const out = outPalette ?? [];
  if (ref.length === 0 && out.length === 0) return 0;
  if (ref.length === 0 || out.length === 0) return 1;

  const refEntries = ref.map((entry) => ({ mass: num(entry.ratio), lab: hexToLab(entry.color) }));
  const outEntries = out.map((entry) => ({ mass: num(entry.ratio), lab: hexToLab(entry.color) }));
  const pairs = [];
  for (let i = 0; i < refEntries.length; i += 1) {
    for (let j = 0; j < outEntries.length; j += 1) {
      const distance = colorDistance(refEntries[i].lab, outEntries[j].lab);
      if (distance <= STYLE_CONSTANTS.maxMatchDistance) pairs.push({ i, j, distance });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance);
  const refRemaining = refEntries.map((entry) => entry.mass);
  const outRemaining = outEntries.map((entry) => entry.mass);
  let cost = 0;
  for (const pair of pairs) {
    const mass = Math.min(refRemaining[pair.i], outRemaining[pair.j]);
    if (mass <= 0) continue;
    refRemaining[pair.i] -= mass;
    outRemaining[pair.j] -= mass;
    cost += pair.distance * mass;
  }
  const unmatchedMass = (
    refRemaining.reduce((sum, value) => sum + value, 0)
    + outRemaining.reduce((sum, value) => sum + value, 0)
  ) / 2;
  return clamp01(cost + unmatchedMass);
}

/** 色板距离：背景色单独比较 + 内容色板 EMD。 */
function paletteDistance(reference, output) {
  const bg = backgroundDistance(reference.background, output.background);
  const content = contentDistance(reference.contentPalette, output.contentPalette);
  return clamp01(
    STYLE_CONSTANTS.backgroundWeight * bg + STYLE_CONSTANTS.contentWeight * content,
  );
}

/** 分项相对差：|a-b| / max(a, b, floor)。 */
function relativeDelta(a, b, floor) {
  const left = num(a);
  const right = num(b);
  const denominator = Math.max(left, right, floor);
  return denominator > 0 ? clamp01(Math.abs(left - right) / denominator) : 0;
}

/**
 * 分析一张 PNG 的风格指纹。
 * @param {Buffer} pngBuffer PNG 文件缓冲（8 位、非隔行，与 ui_diff 的输入一致）
 * @returns {{
 *   width:number, height:number,
 *   background:{color:string, ratio:number},
 *   palette:{color:string, ratio:number}[],
 *   contentPalette:{color:string, ratio:number}[],
 *   colorCount:number, meanLuma:number, meanSat:number, flatRatio:number,
 *   edgeDensity:number, fillRatio:number,
 *   bbox:{x:number,y:number,width:number,height:number,ratio:number}
 * }}
 */
export function analyzeStyle(pngBuffer) {
  const { width, height, rgba } = decodePng(pngBuffer);
  const rgb = compositeOnWhite(rgba);
  const total = width * height;
  const bits = STYLE_CONSTANTS.quantizationBits;
  const shift = 8 - bits;
  const buckets = new Map();
  const lumaValues = new Float32Array(total);
  let sumLuma = 0;
  let sumSat = 0;

  for (let index = 0; index < total; index += 1) {
    const offset = index * 3;
    const r = rgb[offset];
    const g = rgb[offset + 1];
    const b = rgb[offset + 2];
    const value = lumaOf(r, g, b);
    lumaValues[index] = value;
    sumLuma += value;
    const max = Math.max(r, g, b);
    if (max > 0) sumSat += (max - Math.min(r, g, b)) / max;

    const key = ((r >> shift) << (bits * 2)) | ((g >> shift) << bits) | (b >> shift);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
  }

  const palette = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, STYLE_CONSTANTS.paletteSize)
    .map((bucket) => ({
      color: toHex(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count),
      ratio: round(bucket.count / total),
    }));

  // 背景色取占比最高的主色：内容像素 = 与背景色差异超过容差的像素。
  const background = palette.length > 0
    ? { color: palette[0].color, ratio: palette[0].ratio }
    : { color: '#ffffff', ratio: 1 };
  const backgroundRgb = parseHex(background.color);
  const contentBuckets = new Map();
  let contentPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const r = rgb[offset];
      const g = rgb[offset + 1];
      const b = rgb[offset + 2];
      const distance = Math.max(
        Math.abs(r - backgroundRgb[0]),
        Math.abs(g - backgroundRgb[1]),
        Math.abs(b - backgroundRgb[2]),
      );
      if (distance <= STYLE_CONSTANTS.fillTolerance) continue;
      contentPixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const key = ((r >> shift) << (bits * 2)) | ((g >> shift) << bits) | (b >> shift);
      const bucket = contentBuckets.get(key);
      if (bucket) {
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        bucket.count += 1;
      } else {
        contentBuckets.set(key, { r, g, b, count: 1 });
      }
    }
  }

  const contentTop = [...contentBuckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, STYLE_CONSTANTS.contentPaletteSize);
  const contentTopMass = contentTop.reduce((sum, bucket) => sum + bucket.count, 0);
  // 内容色板只在主要色之间归一：大面积白底不参与，避免稀释色相差异。
  const contentPalette = contentTop.map((bucket) => ({
    color: toHex(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count),
    ratio: round(bucket.count / contentTopMass),
  }));

  let edgePixels = 0;
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const index = y * width + x;
      const gx = Math.abs(lumaValues[index + 1] - lumaValues[index]);
      const gy = Math.abs(lumaValues[index + width] - lumaValues[index]);
      if (Math.max(gx, gy) > STYLE_CONSTANTS.edgeThreshold) edgePixels += 1;
    }
  }
  const gradientCandidates = Math.max(0, (width - 1) * (height - 1));
  const edgeDensity = gradientCandidates === 0 ? 0 : edgePixels / gradientCandidates;
  const flatRatio = palette
    .slice(0, STYLE_CONSTANTS.flatTopColors)
    .reduce((sum, entry) => sum + entry.ratio, 0);

  return {
    width,
    height,
    background,
    palette,
    contentPalette,
    colorCount: buckets.size,
    meanLuma: round(sumLuma / total / 255),
    meanSat: round(sumSat / total),
    flatRatio: round(flatRatio),
    edgeDensity: round(edgeDensity),
    fillRatio: round(contentPixels / total),
    bbox: contentPixels > 0
      ? {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        ratio: round(contentPixels / total),
      }
      : { x: 0, y: 0, width: 0, height: 0, ratio: 0 },
  };
}

function noteText(locale, key, values = {}) {
  const zh = {
    summary: `风格分 ${values.score}：权重 色板 ${values.palette} / 明度 ${values.luma} / 饱和 ${values.sat} / 边缘密度 ${values.edgeDensity} / 填充率 ${values.fillRatio}。`,
    paletteFar: `色板距离 ${values.delta}（> ${values.threshold}）：背景或内容配色与参考差异明显，优先核对品牌色、背景色与中性色。`,
    paletteNear: `色板距离 ${values.delta}：背景与内容配色和参考接近。`,
    lumaNear: `整体明度接近（Δ ${values.delta}）。`,
    lumaHigh: `整体明度偏亮（Δ +${values.delta}）：背景或大面积色块比参考更浅。`,
    lumaLow: `整体明度偏暗（Δ -${values.delta}）：背景或大面积色块比参考更深。`,
    satNear: `整体饱和度接近（Δ ${values.delta}）。`,
    satHigh: `整体饱和度偏高（Δ +${values.delta}）：配色比参考更艳。`,
    satLow: `整体饱和度偏低（Δ -${values.delta}）：配色比参考更灰或更淡。`,
    edgeNear: `边缘密度接近（Δ ${values.delta}）。`,
    edgeHigh: `边缘密度偏高（Δ +${values.delta}）：描边、阴影或纹理细节可能比参考多。`,
    edgeLow: `边缘密度偏低（Δ -${values.delta}）：分隔线、图标或纹理细节可能比参考少。`,
    fillNear: `填充率接近（Δ ${values.delta}）。`,
    fillHigh: `填充率偏高（Δ +${values.delta}）：内容或色块面积比参考大，留白偏少。`,
    fillLow: `填充率偏低（Δ -${values.delta}）：内容或色块面积比参考小，留白偏多。`,
  };
  const en = {
    summary: `Style score ${values.score} (weights: palette ${values.palette} / luma ${values.luma} / saturation ${values.sat} / edge density ${values.edgeDensity} / fill ratio ${values.fillRatio}).`,
    paletteFar: `Palette distance ${values.delta} (> ${values.threshold}): background or content colors differ clearly; check brand, background and neutral colors first.`,
    paletteNear: `Palette distance ${values.delta}: background and content colors are close to the reference.`,
    lumaNear: `Overall luminance is close (Δ ${values.delta}).`,
    lumaHigh: `Overall luminance is higher (Δ +${values.delta}): background or large fills are lighter than the reference.`,
    lumaLow: `Overall luminance is lower (Δ -${values.delta}): background or large fills are darker than the reference.`,
    satNear: `Overall saturation is close (Δ ${values.delta}).`,
    satHigh: `Overall saturation is higher (Δ +${values.delta}): the palette is more vivid than the reference.`,
    satLow: `Overall saturation is lower (Δ -${values.delta}): the palette is grayer or paler than the reference.`,
    edgeNear: `Edge density is close (Δ ${values.delta}).`,
    edgeHigh: `Edge density is higher (Δ +${values.delta}): strokes, shadows or texture may be busier than the reference.`,
    edgeLow: `Edge density is lower (Δ -${values.delta}): separators, icons or texture may be sparser than the reference.`,
    fillNear: `Fill ratio is close (Δ ${values.delta}).`,
    fillHigh: `Fill ratio is higher (Δ +${values.delta}): content or fill areas are larger and whitespace smaller than the reference.`,
    fillLow: `Fill ratio is lower (Δ -${values.delta}): content or fill areas are smaller and whitespace larger than the reference.`,
  };
  const table = locale === 'en' ? en : zh;
  return table[key] ?? key;
}

function directionalNote({ locale, keyNear, keyHigh, keyLow, delta, sign, threshold }) {
  const values = { delta: round(delta), threshold: round(threshold) };
  if (delta <= threshold) return noteText(locale, keyNear, values);
  return noteText(locale, sign > 0 ? keyHigh : keyLow, values);
}

function buildNotes({ reference, output, deltas, score, locale }) {
  const thresholds = STYLE_CONSTANTS.noteThresholds;
  const weights = STYLE_CONSTANTS.scoreWeights;
  const notes = [
    noteText(locale, 'summary', {
      score: round(score),
      palette: weights.palette,
      luma: weights.luma,
      sat: weights.sat,
      edgeDensity: weights.edgeDensity,
      fillRatio: weights.fillRatio,
    }),
  ];

  notes.push(
    deltas.paletteDistance > thresholds.palette
      ? noteText(locale, 'paletteFar', { delta: deltas.paletteDistance, threshold: thresholds.palette })
      : noteText(locale, 'paletteNear', { delta: deltas.paletteDistance }),
  );
  const signed = (value) => num(value);
  notes.push(directionalNote({
    locale,
    keyNear: 'lumaNear',
    keyHigh: 'lumaHigh',
    keyLow: 'lumaLow',
    delta: deltas.luma,
    sign: signed(output.meanLuma) - signed(reference.meanLuma),
    threshold: thresholds.luma,
  }));
  notes.push(directionalNote({
    locale,
    keyNear: 'satNear',
    keyHigh: 'satHigh',
    keyLow: 'satLow',
    delta: deltas.sat,
    sign: signed(output.meanSat) - signed(reference.meanSat),
    threshold: thresholds.sat,
  }));
  notes.push(directionalNote({
    locale,
    keyNear: 'edgeNear',
    keyHigh: 'edgeHigh',
    keyLow: 'edgeLow',
    delta: deltas.edgeDensity,
    sign: signed(output.edgeDensity) - signed(reference.edgeDensity),
    threshold: thresholds.edgeDensity,
  }));
  notes.push(directionalNote({
    locale,
    keyNear: 'fillNear',
    keyHigh: 'fillHigh',
    keyLow: 'fillLow',
    delta: deltas.fillRatio,
    sign: signed(output.fillRatio) - signed(reference.fillRatio),
    threshold: thresholds.fillRatio,
  }));
  return notes;
}

/**
 * 比较两份已完成的风格分析（ui_diff 里先各分析一次，避免重复解码）。
 * @param {ReturnType<typeof analyzeStyle>} reference
 * @param {ReturnType<typeof analyzeStyle>} output
 * @param {{locale?: 'zh'|'en'}} [options]
 * @returns {{
 *   score:number,
 *   deltas:{paletteDistance:number,luma:number,sat:number,edgeDensity:number,fillRatio:number},
 *   notes:string[]
 * }}
 */
export function compareStyleAnalyses(reference, output, options = {}) {
  if (!reference || !output) throw new Error('compareStyleAnalyses 需要两份 analyzeStyle 结果');
  const locale = options.locale === 'en' ? 'en' : 'zh';
  const deltas = {
    paletteDistance: round(paletteDistance(reference, output)),
    luma: round(relativeDelta(reference.meanLuma, output.meanLuma, STYLE_CONSTANTS.deltaFloors.luma)),
    sat: round(relativeDelta(reference.meanSat, output.meanSat, STYLE_CONSTANTS.deltaFloors.sat)),
    edgeDensity: round(relativeDelta(reference.edgeDensity, output.edgeDensity, STYLE_CONSTANTS.deltaFloors.edgeDensity)),
    fillRatio: round(relativeDelta(reference.fillRatio, output.fillRatio, STYLE_CONSTANTS.deltaFloors.fillRatio)),
  };
  const weights = STYLE_CONSTANTS.scoreWeights;
  const weightSum = weights.palette + weights.luma + weights.sat + weights.edgeDensity + weights.fillRatio;
  const penalty = weightSum > 0
    ? (weights.palette * deltas.paletteDistance
      + weights.luma * deltas.luma
      + weights.sat * deltas.sat
      + weights.edgeDensity * deltas.edgeDensity
      + weights.fillRatio * deltas.fillRatio) / weightSum
    : 0;
  const score = round(clamp01(1 - penalty));
  return { score, deltas, notes: buildNotes({ reference, output, deltas, score, locale }) };
}

/**
 * 比较参考图与产出图的风格。
 * @param {Buffer} referenceBuffer 参考图 PNG
 * @param {Buffer} outputBuffer 产出图 PNG
 * @param {{locale?: 'zh'|'en'}} [options]
 * @returns {{
 *   score:number,
 *   deltas:{paletteDistance:number,luma:number,sat:number,edgeDensity:number,fillRatio:number},
 *   notes:string[]
 * }}
 */
export function compareStyles(referenceBuffer, outputBuffer, options = {}) {
  return compareStyleAnalyses(analyzeStyle(referenceBuffer), analyzeStyle(outputBuffer), options);
}
