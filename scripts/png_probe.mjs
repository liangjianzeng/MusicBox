// 真机截图元素定位探针：零依赖解码 PNG，扫描指定带状区域内的亮色像素簇（文本行/按钮），
// 输出簇的真实像素包围盒中心，供 adb input tap 使用。用法: node png_probe.mjs <png> [x0 x1 y0 y1 lumThresh]
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const [x0 = 0, x1 = 1e9, y0 = 0, y1 = 1e9, th = 190] = process.argv.slice(3).map(Number);
const buf = readFileSync(file);
if (buf.subarray(1, 4).toString() !== 'PNG') throw new Error('not png');
let p = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
const idat = [];
while (p < buf.length) {
  const len = buf.readUInt32BE(p);
  const type = buf.subarray(p + 4, p + 8).toString();
  const data = buf.subarray(p + 8, p + 8 + len);
  if (type === 'IHDR') {
    w = data.readUInt32BE(0); h = data.readUInt32BE(4);
    bitDepth = data[8]; colorType = data[9];
    if (data[12] !== 0 || bitDepth !== 8) throw new Error('unsupported png ' + bitDepth + '/' + colorType);
  } else if (type === 'IDAT') idat.push(Buffer.from(data));
  else if (type === 'IEND') break;
  p += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1; // RGBA / RGB / G
const stride = w * ch;
// 反滤波
const img = Buffer.alloc(h * stride);
for (let y = 0; y < h; y++) {
  const ft = raw[y * (stride + 1)];
  const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  const row = img.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
  for (let i = 0; i < stride; i++) {
    const a = i >= ch ? row[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
    let v = rowIn[i];
    if (ft === 1) v = (v + a) & 255;
    else if (ft === 2) v = (v + b) & 255;
    else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
    else if (ft === 4) {
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    row[i] = v;
  }
}
// 行直方图：带状区域内亮度>=th 的像素数；连续亮行（间隙≤10）聚为一个簇
const out = [];
let cur = null;
for (let y = y0; y < Math.min(y1, h); y++) {
  let n = 0, xs = 1e9, xl = -1;
  for (let x = Math.max(x0, 0); x < Math.min(x1, w); x++) {
    const i = y * stride + x * ch;
    const lum = (img[i] * 3 + img[i + 1] * 6 + img[i + 2]) / 10;
    if (lum >= th) { n++; if (x < xs) xs = x; if (x > xl) xl = x; }
  }
  if (n >= 6) {
    if (cur && y - cur.y1 <= 10) { cur.y1 = y; cur.n += n; cur.xs = Math.min(cur.xs, xs); cur.xl = Math.max(cur.xl, xl); }
    else { cur = { y0: y, y1: y, n, xs, xl }; out.push(cur); }
  }
}
console.log(`size=${w}x${h} bands=`);
for (const b of out) {
  console.log(`y ${b.y0}..${b.y1} (cy=${(b.y0 + b.y1) >> 1}) x ${b.xs}..${b.xl} (cx=${(b.xs + b.xl) >> 1}) px=${b.n}`);
}
