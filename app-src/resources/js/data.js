/* 数据层：词频、词典、例句索引、在线翻译 */
const DATA = (() => {
  let freq = null, dictEn = null, zhTop = null, enTop = null, testbank = null, tb3 = null;
  let cognates = null;
  const exCache = new Map();
  const NCHUNKS = 24;
  const BAND_RANGES = [[1,500],[501,1000],[1001,2000],[2001,3000],[3001,5000],[5001,8000],[8001,12000],[12001,20000]];
  const BAND_SIZES = [500,500,1000,1000,2000,3000,4000,8000];
  const BAND_NAMES = ['前 500','500–1k','1k–2k','2k–3k','3k–5k','5k–8k','8k–12k','12k–20k'];

  async function jfetch(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.json();
  }

  async function init() {
    [freq, dictEn, zhTop, enTop, testbank, cognates, tb3] = await Promise.all([
      jfetch('data/freq.json'), jfetch('data/dict-en.json'),
      jfetch('data/zh-top.json'), jfetch('data/en-top.json'),
      jfetch('data/testbank.json'), jfetch('data/cognate.json'),
      jfetch('data/testbank3.json'),
    ]);
    cognates = new Set(cognates);
    if (!tb3 || !tb3.bands) throw new Error('testbank3.json 缺失：词汇测试无法出题');
    // 把词频表接入变位引擎:用于规则反查消歧与代词剥离真实性验证
    // 必须在数据加载完成后接线——本文件先于 conj.js 解析，顶层接线是死代码
    if (typeof CONJ !== 'undefined' && CONJ.setFreqChecker) {
      CONJ.setFreqChecker(w => (freq && freq[w]) || 0);
    }
  }

  function isCognate(w) { return !!cognates && cognates.has(w.toLowerCase()); }
  function bandOf(rank) {
    for (let i = 0; i < 8; i++) if (rank <= BAND_RANGES[i][1]) return i;
    return 7;
  }

  function hsh(w) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 131 + w.charCodeAt(i)) & 0x7fffffff;
    return h % NCHUNKS;
  }

  async function exShard(i) {
    let chunk = exCache.get(i);
    if (chunk === undefined) {
      chunk = jfetch(`data/ex/ex_${String(i).padStart(2, '0')}.json`).catch(() => ({}));
      exCache.set(i, chunk);
    }
    return chunk;
  }

  async function getExamples(w) {
    w = w.toLowerCase();
    const i = hsh(w);
    let chunk = exCache.get(i);
    if (chunk === undefined) {
      chunk = jfetch(`data/ex/ex_${String(i).padStart(2, '0')}.json`).catch(() => ({}));
      exCache.set(i, chunk);
    }
    chunk = await chunk;
    return chunk[w] || null;
  }

  /* ---------- 大词库（24.6 万条，64 分片懒加载） ---------- */
  const DICT_SHARDS = 64;
  const dictShardCache = new Map();
  function dictShardOf(w) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 131 + w.charCodeAt(i)) & 0x7fffffff;
    return h % DICT_SHARDS;
  }
  async function bigDictLookup(lw) {
    const i = dictShardOf(lw);
    let shard = dictShardCache.get(i);
    if (shard === undefined) {
      shard = jfetch(`data/dict/dict_${String(i).padStart(2, '0')}.json`).catch(() => ({}));
      dictShardCache.set(i, shard);
    }
    shard = await shard;
    return shard[lw] || null;   // {p: 词性, g: [释义...]}
  }

  function staticZh(w) { return (zhTop && zhTop[w]) || (testbank && testbank.zh[w]) || null; }
  function staticEn(w) {
    if (dictEn && dictEn[w]) return dictEn[w];
    if (enTop && enTop[w]) return enTop[w];
    return null;
  }
  function rankOf(w) { return freq ? (freq[w] || 0) : 0; }

  /* ---------- 在线翻译（带缓存与多级回退） ---------- */
  const LINGVA = ['lingva.ml', 'translate.plausibility.cloud', 'lingva.lunar.icu'];
  async function gtx(q, tl) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl=${tl}&dt=t&q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('gtx ' + r.status);
    const d = await r.json();
    return d[0].map(s => (s && s[0]) || '').join('').trim();
  }
  async function lingva(q, tl) {
    let last;
    for (const host of LINGVA) {
      try {
        const t = tl === 'zh-CN' ? 'zh' : tl;
        const r = await fetch(`https://${host}/api/v1/es/${t}/${encodeURIComponent(q)}`);
        if (!r.ok) continue;
        const d = await r.json();
        if (d.translation) return d.translation.trim();
      } catch (e) { last = e; }
    }
    throw last || new Error('lingva failed');
  }
  async function mymemory(q, tl) {
    const pair = tl === 'zh-CN' ? 'es|zh-CN' : 'es|en';
    const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(pair)}`);
    const d = await r.json();
    const t = d && d.responseData && d.responseData.translatedText;
    if (!t) throw new Error('mymemory empty');
    return t.trim();
  }
  async function translate(q, tl) {
    const key = `t:${tl}:${q.toLowerCase()}`;
    const hit = await DB.cacheGet(key);
    if (hit) return hit.v;
    let out = null;
    for (const fn of [gtx, lingva, mymemory]) {
      try { out = await fn(q, tl); if (out) break; } catch (e) { /* 下一家 */ }
    }
    if (out) DB.cacheSet(key, { v: out, t: Date.now() });
    return out;
  }

  /* ---------- 词条组装 ---------- */
  // 返回 {zh, en, zhLive, enLive, rank, examples}
  async function lookup(raw) {
    const w = raw.trim();
    const lw = w.toLowerCase();
    const single = !/\s/.test(lw) && /^[\p{L}\p{M}]+$/u.test(lw);
    const entry = { word: w, lw, single, rank: single ? rankOf(lw) : 0,
                    zh: null, en: null, examples: null };
    if (single) {
      entry.zh = staticZh(lw);
      entry.en = staticEn(lw);
      entry.examples = await getExamples(lw);
      entry.big = await bigDictLookup(lw);   // 大词库：词性+英文释义
    }
    if (!entry.zh) {
      entry.zhLive = true;
      try { entry.zh = await translate(w, 'zh-CN'); } catch (e) {}
    }
    if (!entry.en) {
      entry.enLive = true;
      try { entry.en = await translate(w, 'en'); } catch (e) {}
    }
    return entry;
  }

  return { init, rankOf, staticZh, staticEn, getExamples, exShard, NEX: 24, translate, lookup, isCognate, bandOf, bigDictLookup,
           BAND_RANGES, BAND_SIZES, BAND_NAMES, get TB3(){return tb3},
           get freq(){return freq}, get testbank(){return testbank} };
})();
