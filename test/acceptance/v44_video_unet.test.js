'use strict';
// V44 · 视频主模型档位由引擎自己说了算（2026-11-28 加）
//
// 起因是实测，不是优化欲：GeekPro 那张 5060 Ti 显存 **15.93 GB**（ComfyUI
// /system_stats 自报），而 h3-fl2va 用的 int8 主模型文件是 **20,970,379,616 B
// ＝ 19.53 GiB**——文件比整张卡还大 3.6 GB。ComfyUI 加载日志原话：
//   `Model MiniMaxH3Image prepared for dynamic VRAM loading. 19999MB Staged.`
// 也就是**装不进显存**，只能停在内存里逐层往显存流；实测 5 秒定妆片跑了
// **450 秒**。NVFP4 档（10.86 GB）能整只常驻，这才是这张卡的适配套路。
//
// 但"换档"绝不许写成模板里的死文件名：那等于把某一台机器的 models 目录钉进
// 代码，换机器／换量化档／删权重都会在**派单那一刻**炸给用户的定妆视频。所以：
//   真源＝引擎自己的 `/object_info/UNETLoader`（只取单节点，不拉几 MB 的全量）；
//   探测失败／列表里没有 → **回落 int8**（＝本改动之前的行为），问不到不等于没有；
//   用了哪一档必须落执行侧日志，端上和排障时交代得出来。
//
// 判词纪律（§6.3）：①②③④ 都是纯函数级、跑真代码路径（同一个 pickVideoUnet），
// 破坏验证见 ①（把偏好表退化成"永远 int8"即红）与 ⑤（把文件名写回模板即红）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mv = require('../../src/executor/lanes/mv.js');

const INT8 = mv.DEFAULT_VIDEO_UNET;
const NVFP4 = 'MiniMax-H3_FL2VA-NVFP4.safetensors';
// 每台"引擎"用独立 base，免得缓存键撞车让一条判词替另一条作证
const cfgOf = (tag) => ({ comfyUrl: 'http://engine-' + tag + ':8188' });

describe('V44 · 视频主模型挑选（档位真源＝引擎文件列表，不许写死）', () => {
  it('V44-① 引擎里有 NVFP4：必须选 NVFP4，并且把用的哪档落到日志', async () => {
    const seen = [];
    const name = await mv.pickVideoUnet(cfgOf('nvfp4'), {
      ttlMs: 0, log: (s) => seen.push(String(s)),
      lister: async () => ['unrelated.safetensors', INT8, NVFP4],
    });
    assert.strictEqual(name, NVFP4,
      'V44-① 有 NVFP4 却选了别的＝继续 19.53 GB 流式（5 秒片 450 秒那条老路），实际 ' + name);
    assert.ok(seen.some((s) => /视频主模型=.*NVFP4/.test(s)),
      'V44-① 用了哪一档必须落执行侧日志（排障时要能交代），实际日志 ' + JSON.stringify(seen));
  });

  it('V44-② 引擎里只有 int8：走 pruned int8，不许乱挑不相干的权重', async () => {
    const name = await mv.pickVideoUnet(cfgOf('int8only'), {
      ttlMs: 0,
      lister: async () => ['some_other_model.safetensors', INT8, 'minimax_h3_image_pruned_int8_convrot.safetensors'],
    });
    assert.strictEqual(name, INT8,
      'V44-② 只有 int8 时必须落在 int8 档，且不许把**图像**档误当视频档，实际 ' + name);
    assert.ok(/fl2va/.test(name), 'V44-② 视频链路只能挑 fl2va 家族，实际 ' + name);
  });

  it('V44-③ 探测失败：回落 int8，且绝不许把异常抛给派单', async () => {
    let name;
    try {
      name = await mv.pickVideoUnet(cfgOf('down'), {
        ttlMs: 0, lister: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
      });
    } catch (e) {
      assert.fail('V44-③ 问不到档位不该拖垮定妆视频任务（问不到≠没有），实际抛出 ' + e.message);
    }
    assert.strictEqual(name, INT8, 'V44-③ 探测失败必须回落到改动前的默认档，实际 ' + name);
  });

  it('V44-④ 列表里没有任何 fl2va：回落默认，不许把空值交给模板', async () => {
    const name = await mv.pickVideoUnet(cfgOf('nomatch'), {
      ttlMs: 0, lister: async () => ['wan2.1.safetensors', 'ltx-2.5-22b-distilled-UD-Q4_K_XL.gguf'],
    });
    assert.strictEqual(name, INT8,
      'V44-④ 挑不到就该回落，交空值给模板会让 ComfyUI 在加载那一刻才报错，实际 ' + JSON.stringify(name));
    assert.ok(String(name).endsWith('.safetensors'), 'V44-④ 回落值必须是可用文件名，实际 ' + name);
  });

  it('V44-⑤ 模板不许把权重文件名写死（回归锁）', () => {
    const tplPath = path.join(__dirname, '..', '..', 'src', 'executor', 'templates', 'h3-fl2va.json');
    const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
    const unetNodes = Object.entries(tpl).filter(([, n]) => n && n.class_type === 'UNETLoader');
    assert.strictEqual(unetNodes.length, 1, 'V44-⑤ h3-fl2va 应当只有一个 UNETLoader，实际 ' + unetNodes.length);
    const v = String((unetNodes[0][1].inputs || {}).unet_name || '');
    assert.strictEqual(v, '<UNET>',
      'V44-⑤ 主模型必须由车道注入（档位真源在引擎侧），模板里写死文件名＝把一台机器的目录钉进代码，实际 '
        + JSON.stringify(v));
  });
});
