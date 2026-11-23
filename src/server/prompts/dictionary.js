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

// 关键词扫描：返回 {moods:[], tags:[], bpm:null|n, instrumental:null|true}
function scan(text) {
  const s = String(text || '').toLowerCase();
  const moods = []; const tags = []; let bpm = null; let instrumental = null;
  for (const e of ENTRIES) {
    for (const a of e.aliases) {
      if (a && s.includes(a.toLowerCase())) {
        if (e.mood && !moods.includes(e.mood)) moods.push(e.mood);
        for (const t of e.tags || []) if (!tags.includes(t)) tags.push(t);
        if (e.bpm && bpm === null) bpm = e.bpm;
        if (e.instrumental) instrumental = true;
        break;
      }
    }
  }
  return { moods, tags, bpm, instrumental };
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
function defaultQuestions(card) {
  const qs = [];
  if (!card.mood || !card.mood.length) {
    qs.push(question(qs.length, '你想要什么样的情绪基调？', ['欢快明亮', '安静治愈', '热血带感', '忧伤抒情'], 0));
  }
  if (card.vocal === 'unknown' || !card.vocal) {
    qs.push(question(qs.length, '要人声演唱还是纯音乐？', ['人声演唱', '纯音乐（无人声）'], 0));
  }
  if (!card.genre_hypotheses || !card.genre_hypotheses.length) {
    qs.push(question(qs.length, '更偏好哪种风格？', ['流行', '电子', '民谣', '国风'], 0));
  }
  return qs.slice(0, 2); // 每轮 ≤2 题
}

module.exports = { ENTRIES, EMOTION_MAP, scan, heuristicIntent, defaultQuestions, question };
