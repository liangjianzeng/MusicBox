// 手写 WAV：正弦样本生成（44 字节 RIFF 头 + PCM16，真实可播放）与头部解析（2026-11-23）
'use strict';
const fs = require('node:fs');

// 生成正弦 wav：默认 440Hz / 44100Hz / 16bit / 单声道 / 30s，返回 {abs, bytes, seconds}
function writeSineWav(absPath, opts) {
  opts = opts || {};
  const seconds = opts.seconds || 30;
  const freq = opts.freq || 440;
  const rate = opts.sampleRate || 44100;
  const channels = opts.channels || 1;
  const bits = opts.bits || 16;
  const amp = opts.amp === undefined ? 0.3 : opts.amp;
  const frames = Math.round(seconds * rate);
  const bytesPerFrame = channels * (bits / 8);
  const dataSize = frames * bytesPerFrame;

  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + dataSize, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);            // fmt 块大小
  head.writeUInt16LE(1, 20);             // PCM
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * bytesPerFrame, 28); // byteRate
  head.writeUInt16LE(bytesPerFrame, 32); // blockAlign
  head.writeUInt16LE(bits, 34);
  head.write('data', 36);
  head.writeUInt32LE(dataSize, 40);

  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < frames; i++) {
    let s = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
    // 首尾 20ms 淡入淡出，避免爆音
    const edge = Math.min(i, frames - i, rate * 0.02);
    if (edge < rate * 0.02) s *= edge / (rate * 0.02);
    const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    for (let ch = 0; ch < channels; ch++) data.writeInt16LE(v, i * bytesPerFrame + ch * 2);
  }
  fs.writeFileSync(absPath, Buffer.concat([head, data]));
  return { abs: absPath, bytes: head.length + dataSize, seconds };
}

// 解析 44 字节 wav 头（非 canonical 时返回 null）
function parseWavHeader(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  if (buf.toString('ascii', 12, 16) !== 'fmt ') return null;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  let dataSize = 0, dataAt = -1;
  let pos = 36;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const sz = buf.readUInt32LE(pos + 4);
    if (id === 'data') { dataSize = sz; dataAt = pos + 8; break; }
    pos += 8 + sz + (sz % 2);
  }
  if (dataAt === -1) return null;
  const seconds = dataSize / (sampleRate * channels * (bits / 8));
  return { channels, sampleRate, bits, dataSize, dataAt, seconds };
}

module.exports = { writeSineWav, parseWavHeader };
