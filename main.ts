// png-squeeze: a lossless PNG recompressor for 1280x720 RGBA screenshots.
//
// For each screenshot it screens every lossless form the PNG format offers
// (palette, grey, grey+alpha, RGB, RGBA, and the single-colour tRNS key forms)
// against a battery of per-image filter strategies (each fixed filter, a
// minimum-signed-sum adaptive choice and a fewest-distinct-pairs adaptive
// choice), weighing every candidate with a level-6 zlib pass. The winner is
// then written with the strongest of several level-9 zlib settings. The whole
// search is a pure function of the input bytes, so two runs agree exactly.
//
// Local run on the practice set:
//   MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG basics

const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Assemble a PNG file from [type, data] chunk pairs. */
function pngOf(chunks) {
  let size = SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ------------------------------------------------------------------- decoder

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Read a PNG the contest accepts and expand it to RGBA bytes. */
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIG.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), {
    maxOutputLength: height * (stride + 1) + 1,
  });
  // Unfilter in place into a samples buffer.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  if (colourType === 6) return { width, height, rgba: samples };
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ------------------------------------------------------------------ analysis

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, rgba.length >>> 2);
}

/** Whether the image is fully opaque, fully grey, and its colours when there are at most 256. */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many
    ? null
    : [...counts.keys()].map((c) => {
        const b = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
      });
  return { opaque, grey, colours };
}

/** The single fully transparent value an image may key through tRNS, or null. */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ------------------------------------------------------------------- palette

/** Palette entries: transparent ones first (so tRNS stays short), then by the given order. */
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// ------------------------------------------------------------------ filtering

/** Filter one row of `cur` (previous row `prev`, pixel size `bpp`) by `type` into `out`. */
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/**
 * The filtered raw stream of an image: each row behind its filter byte.
 * `choice` is a fixed filter type, 'minsum' (least signed sum per row),
 * 'pairs' (fewest distinct neighbouring byte pairs per row) or 'brute'
 * (per row, the filter whose row compresses smallest against the 32 KiB of
 * stream already written, weighed with zlib at level 4).
 */
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  if (choice === 'brute') {
    const trial = Array.from({ length: 5 }, (_, t) => {
      const row = new Uint8Array(stride + 1);
      row[0] = t;
      return row;
    });
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      const at = y * (stride + 1);
      const before = raw.subarray(Math.max(0, at - 32768), at);
      let type = 0;
      let best = Infinity;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t].subarray(1));
        const z = before.length === 0
          ? deflateSync(trial[t], { level: 4, memLevel: 9 })
          : deflateSync(trial[t], { level: 4, memLevel: 9, dictionary: before });
        if (z.length < best) {
          best = z.length;
          type = t;
        }
      }
      raw.set(trial[type], at);
    }
    return raw;
  }
  if (typeof choice === 'number') {
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      const at = y * (stride + 1);
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
    }
    return raw;
  }
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') {
        cost = signedSum(trial[t]);
      } else {
        stamp++;
        cost = 0;
        const row = trial[t];
        for (let i = 1; i < row.length; i++) {
          const pair = (row[i - 1] << 8) | row[i];
          if (seen[pair] !== stamp) {
            seen[pair] = stamp;
            cost++;
          }
        }
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    const at = y * (stride + 1);
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// ------------------------------------------------------- optimal deflate
// A zopfli-style deflate encoder: per 512 KiB segment, one match-finding pass
// caches up to four candidate matches per position (structurally likely
// distances — the byte before, one and two rows up — are probed first, which
// raises the bar so the hash-chain walk rejects most candidates at once);
// a greedy parse prices the first Huffman table, then two shortest-path (DP)
// parses reprice from the previous parse's table. Segments are emitted as
// dynamic-Huffman blocks (fixed-Huffman when it measures smaller). The result
// is a plain zlib stream; callers keep it only when it beats zlib's own.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_CODE_OF = new Int16Array(259);
for (let c = 0; c < 29; c++) {
  const hi = c === 28 ? 258 : LEN_BASE[c] + ((1 << LEN_EXTRA[c]) - 1);
  for (let l = LEN_BASE[c]; l <= hi; l++) LEN_CODE_OF[l] = 257 + c;
}
const DIST_CODE_OF = new Int16Array(32769);
for (let c = 0; c < 30; c++) {
  const hi = DIST_BASE[c] + ((1 << DIST_EXTRA[c]) - 1);
  for (let d = DIST_BASE[c]; d <= hi; d++) DIST_CODE_OF[d] = c;
}
// Match lengths worth a DP transition: every short length, then the top of
// each length-code extra-bit range (inside a range, longer is never dearer).
const SUB_LENGTHS = [3, 4, 5, 6, 7, 8, 9, 10, 18, 34, 66, 130, 257, 258];

/** Huffman code lengths for `freq`, none longer than maxBits (heap + zlib-style overflow fix). */
function codeLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Int32Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }
  const heap = [];
  const nodes = [];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      const t = heap[p];
      heap[p] = heap[i];
      heap[i] = t;
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        const t = heap[m];
        heap[m] = heap[i];
        heap[i] = t;
        i = m;
      }
    }
    return top;
  };
  for (const s of used) push([freq[s], s]);
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    const node = nodes.length;
    nodes.push({ a, b });
    push([a[0] + b[0], -1 - node]);
  }
  const depth = new Int32Array(n);
  const walk = (item, d) => {
    if (item[1] >= 0) {
      depth[item[1]] = d;
      return;
    }
    const node = nodes[-1 - item[1]];
    walk(node.a, d + 1);
    walk(node.b, d + 1);
  };
  walk(heap[0], 0);
  const blCount = new Int32Array(maxBits + 2);
  let overflow = 0;
  for (const s of used) {
    if (depth[s] > maxBits) {
      depth[s] = maxBits;
      overflow++;
    }
    blCount[depth[s]]++;
  }
  if (overflow > 0) {
    while (overflow > 0) {
      let m = maxBits - 1;
      while (blCount[m] === 0) m--;
      blCount[m]--;
      blCount[m + 1] += 2;
      blCount[maxBits]--;
      overflow -= 2;
    }
    const sorted = [...used].sort((x, y) => freq[x] - freq[y]);
    let idx = 0;
    for (let bits = maxBits; bits >= 1; bits--) {
      let cnt = blCount[bits];
      while (cnt > 0) {
        depth[sorted[idx++]] = bits;
        cnt--;
      }
    }
  }
  for (const s of used) lengths[s] = depth[s];
  return lengths;
}

function canonicalCodes(lengths) {
  const blCount = new Int32Array(16);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const next = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Int32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) codes[i] = next[lengths[i]]++;
  return codes;
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
    this.totalBits = 0;
  }
  bits(value, count) {
    this.totalBits += count;
    this.acc |= value << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  huff(code, count) {
    let rev = 0;
    for (let i = 0; i < count; i++) rev = (rev << 1) | ((code >>> i) & 1);
    this.bits(rev, count);
  }
  align() {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
  }
}

const HASH_SIZE = 1 << 15;
const hash3 = (data, i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);
function matchLen(data, a, b, max) {
  let l = 0;
  while (l < max && data[a + l] === data[b + l]) l++;
  return l;
}
const CANDS = 4; // candidate matches cached per position

/** Candidate matches for every position of data[start, end), as CSR-style flat arrays. */
function findCandidates(data, start, end, maxChain, goodLen, probeDists) {
  const n = end - start;
  const counts = new Uint8Array(n);
  const candLen = new Uint16Array(n * CANDS);
  const candDist = new Uint16Array(n * CANDS);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);
  const buildFrom = Math.max(0, start - 32768);
  for (let p = buildFrom; p + 2 < start; p++) {
    const h = hash3(data, p);
    prev[p] = head[h];
    head[h] = p;
  }
  for (let i = 0; i < n; i++) {
    const pos = start + i;
    if (pos + 3 <= end) {
      const maxL = Math.min(258, end - pos);
      let best = 2;
      let kept = 0;
      const base = i * CANDS;
      for (const pd of probeDists) {
        const cand = pos - pd;
        if (cand < buildFrom || pd > 32768) continue;
        const l = matchLen(data, cand, pos, maxL);
        if (l >= 3) {
          candLen[base + kept] = l;
          candDist[base + kept] = pd;
          kept++;
          if (l > best) best = l;
          if (kept >= CANDS || best >= goodLen) break;
        }
      }
      let cand = head[hash3(data, pos)];
      let chain = maxChain;
      while (cand >= buildFrom && cand < pos && chain-- > 0) {
        if (best >= 64) chain = Math.min(chain, 8);
        const dist = pos - cand;
        if (dist > 32768) break;
        if (data[cand + best] === data[pos + best]) {
          const l = matchLen(data, cand, pos, maxL);
          if (l >= 3 && (l > best || kept === 0)) {
            candLen[base + kept] = l;
            candDist[base + kept] = dist;
            kept++;
            if (l > best) best = l;
            if (kept >= CANDS || best >= goodLen) break;
          }
        }
        cand = prev[cand];
      }
      counts[i] = kept;
    }
    if (pos + 2 < end) {
      const h = hash3(data, pos);
      prev[pos] = head[h];
      head[h] = pos;
    }
  }
  return { counts, candLen, candDist };
}

function tokenFreqs(tokens) {
  const litFreq = new Int32Array(286);
  const distFreq = new Int32Array(30);
  for (const t of tokens) {
    if (t.lit !== undefined) litFreq[t.lit]++;
    else {
      litFreq[LEN_CODE_OF[t.len]]++;
      distFreq[DIST_CODE_OF[t.dist]]++;
    }
  }
  litFreq[256] = 1;
  return { litFreq, distFreq };
}

function greedyTokens(data, start, end, cand) {
  const tokens = [];
  const n = end - start;
  let i = 0;
  while (i < n) {
    const c = cand.counts[i];
    if (c > 0) {
      let bi = 0;
      for (let k = 1; k < c; k++) if (cand.candLen[i * CANDS + k] > cand.candLen[i * CANDS + bi]) bi = k;
      tokens.push({ len: cand.candLen[i * CANDS + bi], dist: cand.candDist[i * CANDS + bi] });
      i += cand.candLen[i * CANDS + bi];
    } else {
      tokens.push({ lit: data[start + i] });
      i++;
    }
  }
  return tokens;
}

/** Shortest-path parse of data[start, end) priced by the given code lengths. */
function dpTokens(data, start, end, cand, litLen, distLen) {
  const n = end - start;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const pickLen = new Int32Array(n + 1);
  const pickDist = new Int32Array(n + 1);
  cost[0] = 0;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const c = LEN_CODE_OF[l];
    lenCost[l] = litLen[c] + LEN_EXTRA[c - 257];
  }
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const c = DIST_CODE_OF[d];
    distCost[d] = distLen[c] + DIST_EXTRA[c];
  }
  for (let i = 0; i < n; i++) {
    const base = cost[i];
    if (base === Infinity) continue;
    const pos = start + i;
    const lc = base + litLen[data[pos]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      pickLen[i + 1] = 0;
    }
    const cnt = cand.counts[i];
    if (cnt === 0) continue;
    const maxL = Math.min(258, end - pos);
    for (let s = 0; s < SUB_LENGTHS.length; s++) {
      const l = SUB_LENGTHS[s];
      if (l > maxL) break;
      let best = Infinity;
      let bestD = 0;
      for (let k = 0; k < cnt; k++) {
        if (cand.candLen[i * CANDS + k] >= l) {
          const d = cand.candDist[i * CANDS + k];
          const c = distCost[d];
          if (c < best) {
            best = c;
            bestD = d;
          }
        }
      }
      if (best === Infinity) continue;
      const c = base + lenCost[l] + best;
      if (c < cost[i + l]) {
        cost[i + l] = c;
        pickLen[i + l] = l;
        pickDist[i + l] = bestD;
      }
    }
    for (let k = 0; k < cnt; k++) {
      const l = cand.candLen[i * CANDS + k];
      const d = cand.candDist[i * CANDS + k];
      const c = base + lenCost[l] + distCost[d];
      if (c < cost[i + l]) {
        cost[i + l] = c;
        pickLen[i + l] = l;
        pickDist[i + l] = d;
      }
    }
  }
  const tokens = [];
  let i = n;
  while (i > 0) {
    const l = pickLen[i];
    if (l === 0) {
      tokens.push({ lit: data[start + i - 1] });
      i -= 1;
    } else {
      tokens.push({ len: l, dist: pickDist[i] });
      i -= l;
    }
  }
  tokens.reverse();
  return tokens;
}

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function writeTokens(w, tokens, litCodes, litLen, distCodes, distLen) {
  for (const t of tokens) {
    if (t.lit !== undefined) w.huff(litCodes[t.lit], litLen[t.lit]);
    else {
      const lc = LEN_CODE_OF[t.len];
      w.huff(litCodes[lc], litLen[lc]);
      const le = LEN_EXTRA[lc - 257];
      if (le) w.bits(t.len - LEN_BASE[lc - 257], le);
      const dc = DIST_CODE_OF[t.dist];
      w.huff(distCodes[dc], distLen[dc]);
      const de = DIST_EXTRA[dc];
      if (de) w.bits(t.dist - DIST_BASE[dc], de);
    }
  }
  w.huff(litCodes[256], litLen[256]);
}
function encodeDynamicBlock(w, tokens, litLen, distLen, isFinal) {
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = new Int32Array(hlit + hdist);
  for (let i = 0; i < hlit; i++) all[i] = litLen[i];
  for (let i = 0; i < hdist; i++) all[hlit + i] = distLen[i];
  const seq = [];
  for (let i = 0; i < all.length;) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    let left = run;
    if (v === 0) {
      while (left >= 11) {
        const c = Math.min(left, 138);
        seq.push({ sym: 18, count: c });
        left -= c;
      }
      if (left >= 3) {
        seq.push({ sym: 17, count: left });
        left = 0;
      }
      while (left-- > 0) seq.push({ sym: 0 });
    } else {
      seq.push({ sym: v });
      left--;
      while (left >= 3) {
        const c = Math.min(left, 6);
        seq.push({ sym: 16, count: c });
        left -= c;
      }
      while (left-- > 0) seq.push({ sym: v });
    }
    i += run;
  }
  const clFreq = new Int32Array(19);
  for (const s of seq) clFreq[s.sym]++;
  const clLen = codeLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLen[CLEN_ORDER[hclen - 1]] === 0) hclen--;
  const clCodes = canonicalCodes(clLen);
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  w.bits(isFinal ? 1 : 0, 1);
  w.bits(2, 2);
  w.bits(hlit - 257, 5);
  w.bits(hdist - 1, 5);
  w.bits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.bits(clLen[CLEN_ORDER[i]], 3);
  for (const s of seq) {
    w.huff(clCodes[s.sym], clLen[s.sym]);
    if (s.sym === 16) w.bits(s.count - 3, 2);
    else if (s.sym === 17) w.bits(s.count - 3, 3);
    else if (s.sym === 18) w.bits(s.count - 11, 7);
  }
  writeTokens(w, tokens, litCodes, litLen, distCodes, distLen);
}
const FIXED_LIT_LEN = (() => {
  const a = new Int32Array(288);
  for (let i = 0; i < 288; i++) a[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  return a;
})();
const FIXED_DIST_LEN = (() => {
  const a = new Int32Array(30);
  a.fill(5);
  return a;
})();
function encodeFixedBlock(w, tokens, isFinal) {
  const litCodes = canonicalCodes(FIXED_LIT_LEN);
  const distCodes = canonicalCodes(FIXED_DIST_LEN);
  w.bits(isFinal ? 1 : 0, 1);
  w.bits(1, 2);
  writeTokens(w, tokens, litCodes, FIXED_LIT_LEN, distCodes, FIXED_DIST_LEN);
}
function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const DP_SEGMENT = 1 << 19; // 512 KiB of input per deflate block
const DP_CHAIN = 256;

/** Optimal-parsing deflate of `data` (filtered rows of row length `rowLen`) as a zlib stream. */
function deflateOptimal(data, rowLen) {
  const w = new BitWriter();
  w.bits(0x78, 8);
  w.bits(0x9c, 8);
  const probeDists = rowLen > 0 ? [1, rowLen, 2 * rowLen] : [];
  const nSeg = Math.max(1, Math.ceil(data.length / DP_SEGMENT));
  for (let s = 0; s < nSeg; s++) {
    const start = s * DP_SEGMENT;
    const end = Math.min(data.length, start + DP_SEGMENT);
    const isFinal = s === nSeg - 1;
    if (end === start) {
      encodeFixedBlock(w, [], true);
      break;
    }
    const cand = findCandidates(data, start, end, DP_CHAIN, 96, probeDists);
    let tokens = greedyTokens(data, start, end, cand);
    for (let round = 0; round < 2; round++) {
      const { litFreq, distFreq } = tokenFreqs(tokens);
      for (let i = 0; i < 286; i++) litFreq[i] += 1;
      for (let i = 0; i < 30; i++) distFreq[i] += 1;
      const litLen = codeLengths(litFreq, 15);
      const distLen = codeLengths(distFreq, 15);
      tokens = dpTokens(data, start, end, cand, litLen, distLen);
    }
    const { litFreq, distFreq } = tokenFreqs(tokens);
    const litLen = codeLengths(litFreq, 15);
    const distLen = codeLengths(distFreq, 15);
    const wDyn = new BitWriter();
    encodeDynamicBlock(wDyn, tokens, litLen, distLen, isFinal);
    const wFix = new BitWriter();
    encodeFixedBlock(wFix, tokens, isFinal);
    if (wFix.totalBits < wDyn.totalBits) encodeFixedBlock(w, tokens, isFinal);
    else encodeDynamicBlock(w, tokens, litLen, distLen, isFinal);
  }
  w.align();
  const ad = adler32(data);
  w.bytes.push((ad >>> 24) & 0xff, (ad >>> 16) & 0xff, (ad >>> 8) & 0xff, ad & 0xff);
  return Uint8Array.from(w.bytes);
}

// ---------------------------------------------------------------------- forms

const CHANNEL_FILTERS = [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'];

/** Every lossless form worth screening for this image. */
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0, 'minsum']],
      ['luminance', [0, 'minsum']],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: CHANNEL_FILTERS });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
const PNG_FIXED = 8 + 25 + 12 + 12; // signature + IHDR + IDAT wrapper + IEND

const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const FINAL_OPTS = [
  { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
];

/** Squeeze one RGBA image into the smallest PNG we can write. */
function squeeze(image) {
  const { width, height, rgba } = image;
  let best = null;
  let bestBrute = null;
  for (const form of formsOf(rgba)) {
    const extra = chunkBytes(form) + PNG_FIXED;
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, SCREEN_OPTS);
      const bytes = z.length + extra;
      if (best === null || bytes < best.bytes) best = { form, data, bytes, choice };
      if (choice === 'brute' && (bestBrute === null || bytes < bestBrute.bytes)) bestBrute = { form, data, bytes, choice };
    }
  }
  // Final encodings of the screen winner: zlib at level 9 under three
  // settings, and the optimal-parsing deflate. Distance probes (the row
  // above) pay off only on one-byte-per-pixel streams, so they are enabled
  // for those alone.
  let winForm = best.form;
  let idat = null;
  const consider = (form, stream) => {
    const total = stream.length + chunkBytes(form) + PNG_FIXED;
    if (idat === null || total < idat.total) idat = { total, form, stream };
  };
  for (const opts of FINAL_OPTS) consider(best.form, deflateSync(best.data, opts));
  // On unfiltered multi-byte streams the optimal parse measured worse than
  // zlib on every practice image, so it is skipped there (zlib stands).
  if (!(best.choice === 0 && best.form.bpp >= 3)) {
    consider(best.form, deflateOptimal(best.data, best.form.bpp === 1 ? width + 1 : 0));
  }
  // When the brute-force row choice screened within a percent of the winner,
  // its stream gets the optimal-parsing treatment too: the two can stack.
  if (bestBrute !== null && bestBrute.data !== best.data && bestBrute.bytes <= best.bytes * 1.01) {
    consider(bestBrute.form, deflateOptimal(bestBrute.data, bestBrute.form.bpp === 1 ? width + 1 : 0));
  }
  winForm = idat.form;
  const chunks = [['IHDR', ihdrOf(width, height, winForm.colourType)]];
  if (winForm.plte !== null) chunks.push(['PLTE', winForm.plte]);
  if (winForm.trns !== null) chunks.push(['tRNS', winForm.trns]);
  chunks.push(['IDAT', idat.stream]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ----------------------------------------------------------------------- main

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image));
}
