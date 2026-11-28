// mood/genre 中文词典（40+ 词条）：LLM 不可达时的确定性启发式兜底与参数补全（2026-11-23）
'use strict';

// —— 词条表：alias 命中即取属性；合计 40+ 词条 ——
const ENTRIES = [
  // mood（24）
  { key: '欢快', type: 'mood', aliases: ['欢快', '开心', '高兴', '快乐', '愉悦', '活泼', '嗨', '嗨起来'], mood: '欢快', tags: ['upbeat', 'happy'], bpm: 122 },
  { key: '治愈', type: 'mood', aliases: ['治愈', '温暖', '温馨', '暖心'], mood: '治愈', tags: ['warm', 'healing'], bpm: 92 },
  { key: '平静', type: 'mood', aliases: ['平静', '安静', '放松', '舒缓', '减压', '静心'], mood: '平静', tags: ['calm', 'relax'], bpm: 80 },
  { key: '助眠', type: 'mood', aliases: ['助眠', '睡觉', '失眠', '催眠'], mood: '助眠', tags: ['ambient', 'sleep'], bpm: 62, instrumental: true },
  { key: '悲伤', type: 'mood', aliases: ['悲伤', '难过', '伤心', '失恋', '想哭'], mood: '悲伤', tags: ['sad', 'melancholy'], bpm: 72 },
  { key: '忧郁', type: 'mood', aliases: ['忧郁', 'emo', '低落', '致郁'], mood: '忧郁', tags: ['melancholic'], bpm: 76 },
  // 微醺：真实需求（「来点微醺感的歌」）在 24 档心情里无处可选，用户只能退选 忧郁/夜晚，
  // 出来是苦情骨架 —— 2026-11-27 真机验收用户当场反馈「这旋律风格不喜欢」。补一档慵懒微醺。
  { key: '浪漫', type: 'mood', aliases: ['浪漫', '告白', '表白', '恋爱'], mood: '浪漫', tags: ['romantic', 'love'], bpm: 96 },
  { key: '甜蜜', type: 'mood', aliases: ['甜蜜', '甜', '甜甜的', '撒糖'], mood: '甜蜜', tags: ['sweet', 'cute'], bpm: 108 },
  { key: '热血', type: 'mood', aliases: ['热血', '燃', '劲爆', '燃爆', '带感'], mood: '热血', tags: ['epic', 'power'], bpm: 140 },
  { key: '励志', type: 'mood', aliases: ['励志', '奋斗', '加油', '逆袭', '拼搏'], mood: '励志', tags: ['inspirational', ' anthemic'.trim()], bpm: 128 },
  { key: '孤独', type: 'mood', aliases: ['孤独', '寂寞', '一个人'], mood: '孤独', tags: ['lonely'], bpm: 74 },
  { key: '思念', type: 'mood', aliases: ['思念', '想念', '牵挂'], mood: '思念', tags: ['missing', 'nostalgic'], bpm: 84 },
  { key: '怀旧', type: 'mood', aliases: ['怀旧', '回忆', '青春', '旧时光', '童年'], mood: '怀旧', tags: ['nostalgia'], bpm: 88 },
  { key: '梦幻', type: 'mood', aliases: ['梦幻', '仙境', '飘渺', '空灵'], mood: '梦幻', tags: ['dreamy', 'ethereal'], bpm: 90 },
  { key: '神秘', type: 'mood', aliases: ['神秘', '悬疑', '暗黑'], mood: '神秘', tags: ['mysterious', 'dark'], bpm: 96 },
  { key: '紧张', type: 'mood', aliases: ['紧张', '刺激', '紧迫', '追逐'], mood: '紧张', tags: ['tense', 'action'], bpm: 146 },
  { key: '史诗', type: 'mood', aliases: ['史诗', '宏大', '大气', '磅礴'], mood: '史诗', tags: ['epic', 'orchestral'], bpm: 110 },
  { key: '夏日', type: 'mood', aliases: ['夏天', '夏日', '海边', '沙滩', '度假'], mood: '夏日', tags: ['summer', 'tropical'], bpm: 116 },
  { key: '雨天', type: 'mood', aliases: ['下雨', '雨天', '阴雨', '雨季'], mood: '雨天', tags: ['rainy', 'lofi'], bpm: 78 },
  { key: '清晨', type: 'mood', aliases: ['早晨', '清晨', '起床', '早安'], mood: '清晨', tags: ['morning', 'fresh'], bpm: 100 },
  { key: '夜', type: 'mood', aliases: ['夜晚', '深夜', '夜里', '晚安', '夜跑'], mood: '夜晚', tags: ['night'], bpm: 86 },
  { key: '圣诞', type: 'mood', aliases: ['圣诞', '新年', '节日', '春节', '过年'], mood: '节日', tags: ['festive', 'holiday'], bpm: 118 },
  { key: '儿童', type: 'mood', aliases: ['儿歌', '小朋友', '宝宝', '幼儿园', '童话'], mood: '童趣', tags: ['kids', 'playful'], bpm: 112 },
  { key: '国潮', type: 'mood', aliases: ['国潮', '中国风', '古风', '武侠', '仙侠'], mood: '国风', tags: ['chinese', 'guofeng'], bpm: 98 },
  // genre（18）
  { key: '流行', type: 'genre', aliases: ['流行', 'pop', '华语流行'], tags: ['pop'] },
  { key: '电子', type: 'genre', aliases: ['电子', 'electronic', 'edm', '电音'], tags: ['electronic', 'edm'] },
  { key: '摇滚', type: 'genre', aliases: ['摇滚', 'rock'], tags: ['rock'] },
  { key: '民谣', type: 'genre', aliases: ['民谣', 'folk'], tags: ['folk', 'acoustic'] },
  { key: '古典', type: 'genre', aliases: ['古典', 'classical', '交响', '管弦'], tags: ['classical', 'orchestral'] },
  { key: '爵士', type: 'genre', aliases: ['爵士', 'jazz'], tags: ['jazz'] },
  { key: '嘻哈', type: 'genre', aliases: ['嘻哈', 'hiphop', 'hip-hop', '说唱', 'rap'], tags: ['hiphop', 'rap'] },
  { key: 'R&B', type: 'genre', aliases: ['r&b', 'rb', '节奏布鲁斯', 'soul', '灵魂乐'], tags: ['rnb', 'soul'] },
  { key: '蓝调', type: 'genre', aliases: ['蓝调', '布鲁斯', 'blues'], tags: ['blues'] },
  { key: '乡村', type: 'genre', aliases: ['乡村', 'country'], tags: ['country'] },
  { key: '朋克', type: 'genre', aliases: ['朋克', 'punk'], tags: ['punk'] },
  { key: '金属', type: 'genre', aliases: ['金属', 'metal'], tags: ['metal'] },
  { key: '后摇', type: 'genre', aliases: ['后摇', 'post-rock', 'postrock'], tags: ['post-rock'] },
  { key: '轻音乐', type: 'genre', aliases: ['轻音乐', '纯音乐', '器乐', 'instrumental'], tags: ['instrumental', 'easy-listening'], instrumental: true },
  { key: 'LoFi', type: 'genre', aliases: ['lofi', 'lo-fi', '低保真', '学习音乐'], tags: ['lofi', 'chillhop'] },
  { key: '舞曲', type: 'genre', aliases: ['舞曲', 'dance', '迪斯科', 'disco', '蹦迪'], tags: ['dance', 'disco'] },
  { key: '国风', type: 'genre', aliases: ['国风', '古筝', '琵琶', '笛子', '二胡'], tags: ['guofeng', 'chinese-traditional'] },
  { key: '氛围', type: 'genre', aliases: ['氛围', 'ambient', '背景音乐', '纯背景'], tags: ['ambient'], instrumental: true },
];

// 情绪→mood（执行器 ASR 情绪标签兜底映射）
const EMOTION_MAP = {
  happy: '欢快', joyful: '欢快', excited: '热血', sad: '悲伤', melancholic: '忧郁',
  angry: '紧张', fearful: '神秘', disgusted: '神秘', neutral: '', surprised: '欢快', calm: '平静', gentle: '治愈',
};

// —— 四个维度，各管各的（2026-11-27 真机后重新归类，见 docs/ia-review-2026-11-27.md §二）——
//   曲风 genre   = 编曲骨架（流行/古典/爵士…）      → ENTRIES(type=genre)
//   情绪 mood    = 这首歌唱的是什么心情              → ENTRIES(type=mood)
//   人声 voice   = **谁在唱、怎么唱**（性别/演唱状态）→ VOICE_WORDS   ← 歌声不是曲声！
//   质感 style   = 乐器与制作质感（钢琴/弦乐/黑胶…）  → STYLE_WORDS
// 以前 女声/男声 被塞进 STYLE_WORDS，于是"谁来唱"和"用什么乐器"抢同一份 tags 配额，
// 还能被挤掉 —— 用户勾了女声却拿到男声（2026-11-27 真机）。性别是演唱维度，不是装饰词。
const STYLE_WORDS = [
  { zh: '复古', en: 'retro' },
  { zh: '合成器', en: 'synth' },
  { zh: '空灵', en: 'ethereal' },
  { zh: '低保真', en: 'lofi' },
  { zh: '温暖', en: 'warm' },
  { zh: '弦乐铺底', en: 'strings' },
  { zh: '钢琴', en: 'piano' },
  { zh: '电吉他', en: 'electric guitar' },
  { zh: '木吉他', en: 'acoustic guitar' },
  { zh: '萨克斯', en: 'saxophone' },
  { zh: '二胡', en: 'erhu' },
  { zh: '古筝', en: 'guzheng' },
  { zh: '鼓点强劲', en: 'heavy drums' },
  { zh: '鼓机 808', en: '808' },
  { zh: '现场感', en: 'live' },
  { zh: '黑胶噪点', en: 'vinyl crackle' },
  { zh: '大混响', en: 'reverb' },
  { zh: '节奏切分', en: 'syncopated' },
  { zh: '情绪渐强', en: 'building' },
  { zh: '循环洗脑', en: 'hypnotic' },
];

// —— 人声维度：谁在唱（gender，互斥单选）+ 怎么唱（delivery）+ 人声编排（layer）——
// 与曲风/质感正交：同一份编曲可以女声唱也可以男声唱，可以清醒唱也可以微醺唱；
// 反过来，"微醺"不是情绪（开心的事能微醺唱，难过的事也能），"女声"更不是风格点缀。
const VOICE_WORDS = [
  { zh: '女声', en: 'female vocal', dim: 'gender', aliases: ['女声','女歌手','女生唱','女主唱','female','female vocal','women vocal'] },
  { zh: '男声', en: 'male vocal', dim: 'gender', aliases: ['男声','男歌手','男生唱','男主唱','male','male vocal','men vocal'] },
  { zh: '童声', en: 'children vocal', dim: 'gender', aliases: ['童声','童音','孩子唱','children','kids vocal'] },
  { zh: '合唱', en: 'choir', dim: 'gender', aliases: ['合唱','合声','群唱','choir','gang vocal'] },
  { zh: '微醺', en: 'tipsy vocal', dim: 'delivery', aliases: ['微醺','醺','醉','喝一点','喝了一点','半醉','上头','微醺感','tipsy','half drunk','slurred'] },
  { zh: '气声', en: 'breathy', dim: 'delivery', aliases: ['气声','气音','轻声唱','breathy','whispery'] },
  { zh: '烟嗓', en: 'husky vocal', dim: 'delivery', aliases: ['烟嗓','沙哑','嘶哑','husky','raspy'] },
  { zh: '哭腔', en: 'crying vocal', dim: 'delivery', aliases: ['哭腔','哽咽','带哭','哭唱','crying','choking'] },
  { zh: '嘶吼', en: 'screaming vocal', dim: 'delivery', aliases: ['嘶吼','吼','爆吼','scream','shout'] },
  { zh: '念白', en: 'spoken word', dim: 'delivery', aliases: ['念白','说白','半说半唱','spoken','spoken word'] },
  { zh: '拖拍', en: 'behind the beat', dim: 'delivery', aliases: ['拖拍','拖半拍','落后拍','behind the beat','laid back vocal'] },
  { zh: '和声层叠', en: 'harmonies', dim: 'layer', aliases: ['和声','层叠人声','harmonies','harmony'] },
];
// 下发给 APK 的选择项目录（契约 v3.2）：中文给用户看，英文给模型用。
// App 侧必须以此为准（本地只留同构兜底），杜绝两处词表各写一份导致的漂移。
function catalog() {
  const moods = [];
  const genres = [];
  for (const e of ENTRIES) {
    if (e.type === 'mood' && e.mood && !moods.some((m) => m.zh === e.mood)) {
      moods.push({ zh: e.mood, bpm: e.bpm || null });
    }
    if (e.type === 'genre') {
      const tags = e.tags || [];
      genres.push({ zh: e.key, en: tags[0] || String(e.key).toLowerCase(), tags, instrumental: !!e.instrumental });
    }
  }
  return {
    moods,
    genres,
    style_words: STYLE_WORDS.map((w) => ({ zh: w.zh, en: w.en })),
    // 人声维度（新增，向后兼容：不认识它的旧 App 忽略即可，不会白屏）
    voice: VOICE_WORDS.map((w) => ({ zh: w.zh, en: w.en, dim: w.dim })),
  };
}

// 英文规范词 → 中文（意图卡「流派假设」常是英文 tags，展示要翻回中文）
const _ZH_BY_EN = (() => {
  const m = Object.create(null);
  for (const e of ENTRIES) for (const t of e.tags || []) if (t && !m[t]) m[t] = e.key;
  for (const w of STYLE_WORDS) if (!m[w.en]) m[w.en] = w.zh;
  for (const w of VOICE_WORDS) if (!m[w.en]) m[w.en] = w.zh;
  return m;
})();
function zhFor(word) {
  const s = String(word || '').trim();
  if (!s) return '';
  return _ZH_BY_EN[s.toLowerCase()] || s; // 查不到原样回显，不编造
}


// 关键词扫描：返回 {moods:[], tags:[], bpm:null|n, instrumental:null|true}
function scan(text) {
  const s = String(text || '').toLowerCase();
  const moods = []; const tags = []; const gender = [];
  let bpm = null; let instrumental = null;
  const push = (t) => { if (t && !tags.includes(t)) tags.push(t); };
  // 自由文本里的英文词必须整词匹配，否则「alive」会命中「现场感(live)」、
  // 「delivery」会命中「live」—— 中文词仍按子串匹配（'钢琴'、'弦乐铺底'）。
  const hit = (k) => {
    const key = String(k || '').toLowerCase().trim();
    if (!key) return false;
    return /^[a-z0-9 +_-]+$/.test(key)
      ? new RegExp('(^|[^a-z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])').test(s)
      : s.includes(key);
  };
  // tags 有 cap（契约 ≤6），而一首歌真正想说的常常有十来个词 —— 谁先占位就成了价值判断。
  // 排序：**性别 > 曲风 > 情绪 > 质感**。理由是真机教训：曲风决定编曲（决定"会不会把摊牌
  // 做成咖啡馆 BGM"），质感词是锦上添花；上一次 female vocal 被挤掉，用户要女声拿到男声。
  const genre = [];
  for (const e of ENTRIES) {
    for (const a of e.aliases) {
      if (hit(a)) {
        if (e.mood && !moods.includes(e.mood)) moods.push(e.mood);
        const bucket = e.type === 'genre' ? genre : tags;
        for (const t of e.tags || []) if (!bucket.includes(t)) bucket.push(t);
        if (e.bpm && bpm === null) bpm = e.bpm;
        if (e.instrumental) instrumental = true;
        break;
      }
    }
  }
  // 自由文本里的人声词与点缀词都要被认出来：以前 scan 完全不查这两类，用户在「灵感描述」
  // 里写「女声」「钢琴」「弦乐铺底」，一个字都进不了引擎 —— "我明明写了女声却拿到男声"的另一半根因。
  const delivery = [];
  for (const w of VOICE_WORDS.concat(STYLE_WORDS)) {
    const keys = [w.zh, w.en].concat(w.aliases || []);
    if (!keys.some(hit)) continue;
    const t = w.en;
    if (w.dim === 'gender') { if (!gender.includes(t)) gender.push(t); }
    else if (w.dim === 'delivery' || w.dim === 'layer') { if (!delivery.includes(t)) delivery.push(t); }
    else push(t);
  }
  return { moods, tags: gender.concat(genre).concat(tags).concat(delivery), bpm, instrumental };
}

// 词典版意图启发式编译（LLM 不可达时；confidence<0.5）
function heuristicIntent(text) {
  const r = scan(text);
  const vocal = r.instrumental ? 'instrumental' : 'unknown';
  return {
    mood: r.moods.slice(0, 3),
    scene_desc: String(text || '').slice(0, 200),
    genre_hypotheses: (r.tags.length ? r.tags : ['pop']).slice(0, 3),
    vocal,
    duration_hint: '',
    confidence: 0.4,
    bpm: r.bpm,
    tags: r.tags.length ? r.tags : ['pop'],
  };
}

// 标准澄清题（保证 options 2-4 个、必带 recommended_idx）
function question(id, q, options, recommendedIdx) {
  return { q_idx: id, q, options: options.slice(0, 4).map((label, idx) => ({ idx, label })), recommended_idx: Math.min(recommendedIdx, Math.max(0, Math.min(4, options.length) - 1)) };
}
// v5.5.8：兜底题量按卡分档。默认仍是 2（= v1 原值，存量三档与存量卡行为不变），
// 只有伴创卡传 3 进来才会一次问三题。
function defaultQuestions(card, budget) {
  const qs = [];
  if (!card.mood || !card.mood.length) {
    qs.push(question(qs.length, '你想要什么样的情绪基调？', ['欢快明亮', '安静治愈', '热血带感', '忧伤抒情'], 0));
  }
  if (card.vocal === 'unknown' || !card.vocal) {
    // 「谁来唱」这题带 set：回填走显式通道，不再靠 dict.scan 猜"女声/男声"字面（勾女声出男声的根因）
    qs.push({ ...question(qs.length, '要人声演唱还是纯音乐？', ['人声演唱', '纯音乐（无人声）'], 0),
      options: [
        { idx: 0, label: '人声演唱', set: { vocal: 'song', tags_add: ['female vocal'], dim: 'gender' } },
        { idx: 1, label: '纯音乐（无人声）', set: { vocal: 'instrumental' } },
      ] });
  }
  if (!card.genre_hypotheses || !card.genre_hypotheses.length) {
    qs.push({ ...question(qs.length, '更偏好哪种风格？', ['流行', '电子', '民谣', '国风'], 0),
      options: [
        { idx: 0, label: '流行', set: { genre_add: ['pop'], tags_add: ['pop'] } },
        { idx: 1, label: '电子', set: { genre_add: ['electronic'], tags_add: ['electronic'] } },
        { idx: 2, label: '民谣', set: { genre_add: ['folk'], tags_add: ['folk'] } },
        { idx: 3, label: '国风', set: { genre_add: ['chinese style'], tags_add: ['chinese style'] } },
      ] });
  }
  const cap = Number.isFinite(budget) && budget >= 1 && budget <= 3 ? Math.trunc(budget) : 2;
  return qs.slice(0, cap); // 每轮题量按卡分档（v5.5.8）
}

module.exports = { ENTRIES, EMOTION_MAP, STYLE_WORDS, VOICE_WORDS, scan, heuristicIntent, defaultQuestions, question, catalog, zhFor };
