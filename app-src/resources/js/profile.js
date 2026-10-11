/* 用户词汇档案：词汇量、盲点、标注阈值、设置 */
const PROFILE = (() => {
  const PKEY = 'sr-profile', SKEY = 'sr-settings';
  let profile = null, settings = null, blindSet = new Set();

  function load() {
    try { profile = JSON.parse(localStorage.getItem(PKEY)); } catch (e) { profile = null; }
    try { settings = JSON.parse(localStorage.getItem(SKEY)); } catch (e) { settings = null; }
    if (!settings) settings = { sensitivity: 1, theme: 'light', fontSize: 19 };
    if (!profile) profile = { vocab: null, unknown: true, blind: [], bands: null, ts: 0, skipped: true };
    rebuildBlind();
  }
  function rebuildBlind() {
    blindSet = new Set((profile.blind || []).map(w => w.toLowerCase()));
  }
  function save() { localStorage.setItem(PKEY, JSON.stringify(profile)); }
  function saveSettings() { localStorage.setItem(SKEY, JSON.stringify(settings)); }

  function hasProfile() { return !!(profile && profile.ts); }

  function levelLabel(v) {
    if (v < 800) return 'A1 · 入门';
    if (v < 1800) return 'A2 · 基础';
    if (v < 3500) return 'B1 · 进阶';
    if (v < 6000) return 'B2 · 中高级';
    if (v < 10000) return 'C1 · 高级';
    return 'C2 · 精通';
  }
  function threshold() { return Math.round((profile.vocab || 3500) * (settings.sensitivity || 1)); }
  function vocabText() {
    if (profile.vocab == null) return '词汇量 未测试';
    const ci = (profile.lo && profile.hi) ? `（${profile.lo.toLocaleString()}–${profile.hi.toLocaleString()}）` : '';
    return `词汇量 ≈ ${profile.vocab.toLocaleString()}${ci}`;
  }
  function cutoff() { return Math.min(0.8, Math.max(0.2, 0.5 / (settings.sensitivity || 1))); }

  // 预测"你认识这个词"的概率：按 词频带 × 同源/纯西语 双轨掌握率
  function predictKnown(word) {
    const w = word.toLowerCase();
    if (blindSet.has(w)) return 0;
    const r = DATA.rankOf(w);
    if (!r) return null;
    const bands = profile.bands;
    if (!bands || !bands.cog || !bands.non) {
      // 未测试/跳过：用测试同一套先验曲线，而不是"词频序号<=词汇量"这种假规则
      if (typeof TestStat !== 'undefined') {
        const b = DATA.bandOf(r);
        const base = TestStat.priorMean(b, { m0: 1 });
        return DATA.isCognate(w) ? TestStat.pEff(base, true) : base;
      }
      return r <= (profile.vocab || 3500) ? 0.75 : 0.25;
    }
    const b = DATA.bandOf(r);
    const arr = DATA.isCognate(w) ? bands.cog : bands.non;
    return arr[b];   // 存档时已平滑
  }

  function isHard(word) {
    const w = word.toLowerCase();
    if (blindSet.has(w)) return true;
    if (word.toUpperCase() === word && word.length > 1) return false; // 全大写多为专名/缩写
    const pk = predictKnown(w);
    if (pk === null) return true;          // 词频表外的低频词
    return pk < cutoff();
  }

  function addBlind(words) {
    let added = false;
    for (const w of words) {
      const lw = w.toLowerCase();
      if (!blindSet.has(lw)) { blindSet.add(lw); profile.blind.push(lw); added = true; }
    }
    if (added) save();
  }
  function removeBlind(word) {
    const lw = word.toLowerCase();
    if (blindSet.has(lw)) {
      blindSet.delete(lw);
      profile.blind = profile.blind.filter(w => w !== lw);
      save();
    }
  }

  function setTestResult(res) { profile = res; rebuildBlind(); save(); }
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', settings.theme || 'light');
    document.documentElement.style.setProperty('--reader-font-size', (settings.fontSize || 19) + 'px');
  }
  function cycleTheme() {
    const order = ['light', 'sepia', 'dark'];
    settings.theme = order[(order.indexOf(settings.theme || 'light') + 1) % 3];
    saveSettings(); applyTheme();
    return { light: '明亮', sepia: '护眼', dark: '夜间' }[settings.theme];
  }
  function bumpFont(d) {
    let s = (settings.fontSize || 19) + d;
    s = Math.max(12, Math.min(36, s));
    settings.fontSize = s;
    saveSettings(); applyTheme();
    return settings.fontSize;
  }
  function resetFont() {
    settings.fontSize = 19;
    saveSettings(); applyTheme();
    return 19;
  }

  load();
  return {
    get p() { return profile; }, get s() { return settings; },
    hasProfile, levelLabel, threshold, cutoff, isHard, predictKnown, addBlind, removeBlind, vocabText,
    setTestResult, applyTheme, cycleTheme, bumpFont, resetFont, saveSettings,
    set sensitivity(v) { settings.sensitivity = v; saveSettings(); },
    get sensitivity() { return settings.sensitivity || 1; },
  };
})();
