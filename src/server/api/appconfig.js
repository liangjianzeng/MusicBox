// APK 远程配置下发（2026-11-24）：GET /v1/app/config，无鉴权、限流。
// 下发：定价 + 功能开关(灰度按设备/用户命中) + 模型默认走向与可选模型 + 版本策略 + 公告 + 审核开关。
'use strict';
const store = require('../core/store');
const M = require('../core/modelnodes');
const AC = require('../core/appconfig');
const U = require('../core/util');
const config = require('../config');
const dict = require('../prompts/dictionary');

// 可选模型列表（APK 自选用）：未锁定的 kind 才下发；标签中性化，不暴露引擎名（用户面纪律）
function modelOptions(kind) {
  const def = M.defaultFor(kind);
  // 锁定/无可选节点时返回空数组而不是 null：null 会被 App 读成「没有可用模型」，
  // 用户看到的就是「没模型就不能用」。「后台统一指定」的语义由 routing.<kind>.locked 承担。
  if (def.locked) return [];
  const rows = store.all('SELECT id, engine FROM model_nodes WHERE kind=? AND enabled=1 ORDER BY priority ASC, rowid ASC', kind);
  return rows.map((r, i) => ({
    id: r.id,
    label: r.id === def.node_id ? '默认模型' : ('备选模型 ' + (i + 1)),
  }));
}

function getAppConfig(ctx) {
  if (!U.allowRate('appcfg:' + (ctx.ip || 'x'), 60, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  const blob = AC.current().blob;
  const routing = M.routingForApp();
  // 灰度判定身份：登录用户用 user_id，游客用设备/IP（仅影响 features 命中，不泄露信息）
  const auth = require('./auth');
  const u = auth.userFromRequest(ctx);
  const who = (u && u.id) || String(ctx.ip || 'anon');
  const features = {};
  for (const f of AC.flagsAll()) {
    features[f.key] = AC.featureOn(f.key, who);
  }
  const model_options = { music: modelOptions('music') };
  // 创作选择项目录（契约 v3.2）：曲风/心情/风格点缀的唯一真源 = 服务端词典，
  // App 本地只留同构兜底，杜绝两处词表各写一份导致的漂移
  const style_options = dict.catalog();
  const credits = blob.credits;
  const version_policy = blob.version_policy;
  const announcement = blob.announcement;
  const moderation = { enabled: blob.moderation_enabled !== false };
  // config_version：内容寻址，任何运营改动都会变（APK 据此决定是否刷新）
  // 人格克隆参数下发（契约 v5.6.0）：cover_strength 是**唯一**能锁住音色/性别的旋钮，
  // 它的默认值只允许有一个真源 = config.persona。端侧一旦自带 `?? 0.6` 就是第二个真源，
  // 服务端一改默认，App 显示的档位就和实际跑出来的不一致（用户看到的和听到的对不上）。
  // 进 sig：运营改默认强度时 config_version 必须变，APK 才会重新拉取。
  const persona = {
    default_cover_strength: config.persona.defaultCoverStrength,
    min_cover_strength: config.persona.minCoverStrength,
    max_cover_strength: config.persona.maxCoverStrength,
  };
  const sig = U.jstr({ routing, model_options, credits, features, version_policy, announcement, moderation, style_options, persona, v: 4 });
  const config_version = U.sha256hex(sig).slice(0, 8);
  return {
    status: 200,
    body: {
      config_version,
      credits,
      routing,
      model_options,
      features,
      version_policy,
      announcement,
      moderation,
      style_options,
      persona,
    },
  };
}

module.exports = { routes: [{ m: 'GET', p: '/v1/app/config', h: getAppConfig }] };
