/* 词汇水平测试 v3
   与 v2 的三处区别（每一条都对着一个具体毛病）：
   1) 统一量表：四选一先做 1/4 猜测校正，元认知自查按"乐观混淆矩阵"反演，
      不再有 |自查-选择|>0.45 这类硬阈值挑一个信、也不再有同源词 ×0.5 的魔法系数。
   2) 每带只估一个未知量（同源优势用固定偏移计入）+ 题库从 256 扩到 4200：
      带内样本从 2 题级提到 4~5 题级，尾部两个大带不再靠 32 个词外推 12000 词。
   3) 出区间不出单点，并给识别/语境/形态/汉译西四个维度；题量可选快速/精确。
   测量数学全在 teststat.js（与 node 模拟器共用一份实现）：
   模拟对照（N=3000 验证折，docs/calibration-2026-09-30.md §2）v2 偏差 -317 / MAE 1281 / RMSE 1602；
   v3 偏差 +24 / MAE 833 / RMSE 1059，标称 95% 区间实测覆盖 94.6%。 */
const Test = (() => {
  const SWEEP_N = 16;                     // 每带自查 8 同源 + 8 纯西语
  const BUDGET = { quick: 36, full: 72 }; // 选择题预算（快速 / 精确）
  const PRIOR = { m0: 2 };
  const PROD_MIN = 6;                     // 产出维最少题数
  let budget, onFinish, obs, prodCount, plan, qNo, qTotal, blind, mode, pool, rngSeed = 1;

  const $body = () => document.getElementById('test-body');
  const show = h => { $body().innerHTML = h; };
  const esc = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const progressHtml = p => `<div class="t-progress"><i style="width:${Math.round(p * 100)}%"></i></div>`;
  const shuffle = a => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
  const SIZES = () => DATA.TB3.bandSizes;
  const SHARES = () => DATA.TB3.meta.map(m => m.cognateShare);
  const isCog = w => DATA.isCognate(w);

  /* ---------- 题池与选题 ---------- */
  function pickBandSweep(b) {
    const poolB = DATA.TB3.bands[b];
    const cog = shuffle(poolB.filter(w => isCog(w))).slice(0, SWEEP_N / 2);
    const non = shuffle(poolB.filter(w => !isCog(w))).slice(0, SWEEP_N / 2);
    return { words: [...cog, ...non], knows: Array(SWEEP_N).fill(null) };
  }

  function glossOf(w) { return DATA.TB3.gloss[w]; }
  function usedAlready(w) { return usedWords.has(w); }
  const usedWords = new Set();

  function distractors(b, w, k, sameLangOnly) {
    const g = glossOf(w);
    const out = [];
    const cand = shuffle(DATA.TB3.bands[b].filter(x => x !== w && !usedWords.has(x)));
    for (const x of cand) {
      const gx = glossOf(x);
      if (!gx || gx === g) continue;
      if (sameLangOnly && DATA.TB3.glossLang[x] !== DATA.TB3.glossLang[w]) continue;
      if (out.some(o => o === gx)) continue;
      out.push(gx);
      if (out.length >= k) break;
    }
    // 同带词不够时用相邻带补（释义语言保持一致）
    for (let d = 1; d <= 2 && out.length < k; d++) {
      for (const bi of [b - d, b + d]) {
        if (bi < 0 || bi > 7) continue;
        for (const x of shuffle(DATA.TB3.bands[bi])) {
          if (x === w || usedWords.has(x)) continue;
          const gx = glossOf(x);
          if (!gx || gx === g || out.includes(gx)) continue;
          if (DATA.TB3.glossLang[x] !== DATA.TB3.glossLang[w]) continue;
          out.push(gx); if (out.length >= k) break;
        }
        if (out.length >= k) break;
      }
    }
    return out;
  }

  /* ---------- 阶段一：元认知自查 ---------- */
  let bandIdx = 0;
  function sweepStage() {
    const sw = pickBandSweep(bandIdx);
    sw.words.forEach(w => usedWords.add(w));
    obs[bandIdx].sweep = sw;
    show(`
      ${progressHtml(bandIdx / 8 * 0.45)}
      <h2>第 ${bandIdx + 1} / 8 组 · ${DATA.BAND_NAMES[bandIdx]} 词</h2>
      <p class="t-sub">凭第一印象判断，不查词典；拿不准就点「不认识」。这一组只给模型定档，<b>最终分数以选择题为准</b>。</p>
      <div class="word-chips">
        ${sw.words.map((w, i) => `
          <div class="word-chip ${sw.knows[i] === true ? 'know' : sw.knows[i] === false ? 'noknow' : ''}" data-i="${i}">
            <span class="wc-word">${esc(w)}</span>
            <span class="wc-btns">
              <button class="wc-btn k" title="认识">✓</button>
              <button class="wc-btn n" title="不认识">✗</button>
            </span>
          </div>`).join('')}
      </div>
      <div class="t-foot">
        <div><button class="btn ghost small" id="t-all-k">都认识</button>
             <button class="btn ghost small" id="t-all-n">都不认识</button></div>
        <button class="btn primary" id="t-next" ${sw.knows.every(k => k !== null) ? '' : 'disabled'}>下一组 →</button>
      </div>`);
    $body().querySelectorAll('.word-chip').forEach(chip => chip.querySelectorAll('.wc-btn').forEach(btn => {
      btn.onclick = () => {
        const i = +chip.dataset.i;
        sw.knows[i] = btn.classList.contains('k');
        chip.classList.toggle('know', sw.knows[i]);
        chip.classList.toggle('noknow', !sw.knows[i]);
        document.getElementById('t-next').disabled = sw.knows.some(k => k === null);
      };
    }));
    document.getElementById('t-all-k').onclick = () => { sw.knows.fill(true); sweepStage(); };
    document.getElementById('t-all-n').onclick = () => { sw.knows.fill(false); sweepStage(); };
    document.getElementById('t-next').onclick = () => {
      if (obs[bandIdx].committed) return;                      // 防重复提交
      obs[bandIdx].committed = true;
      sw.words.forEach((w, i) => obs[bandIdx].items.push({ kind: 'self', know: sw.knows[i], cog: isCog(w), r: 0.75 }));
      if (bandIdx < 7) { bandIdx++; sweepStage(); } else startQuizAsync();
    };
  }

  /* ---------- 阶段二：自适应选择题 ---------- */
  function bandSd(b) { return TestStat.posteriorOf(obs[b].items, TestStat.priorSet(b, PRIOR), TestStat.likelihoodOf).sd * SIZES()[b]; }

  function nextBand() {                       // 不确定度（词数单位）最大的带优先补题
    let best = 0, bv = -1;
    for (let b = 0; b < 8; b++) { const s = bandSd(b); if (s > bv) { bv = s; best = b; } }
    return best;
  }

  function buildQueue() {
    const q = [];
    for (let b = 0; b < 8; b++) q.push({ b, type: 'recog' });          // 每带先保底 1 题硬证据
    let n = q.length;
    let rot = 0;
    while (n < budget) {
      const b = nextBandFree(q, b2 => b2);
      if (b < 0) break;
      const types = ['recog', 'cloze', 'form', 'recog'];
      let type = types[rot++ % types.length];
      if (type === 'recog' && (n - 8) % 4 === 3) type = 'prod';          // 每 4 题掺 1 道汉译西
      q.push({ b, type }); n++;
    }
    return q;

    function nextBandFree(queue) {                                      // 避开已经题很多的带
      let best = -1, bv = -1;
      for (let b = 0; b < 8; b++) {
        const cnt = queue.filter(x => x.b === b).length;
        const s = bandSd(b) * (1 - 0.16 * cnt);
        if (s > bv) { bv = s; best = b; }
      }
      return best;
    }
  }

  function makeItem(b, type) {
    const cand = DATA.TB3.bands[b].filter(w => !usedWords.has(w) && glossOf(w));
    if (!cand.length) return null;
    if (type === 'prod') {
      const zh = cand.filter(w => DATA.TB3.glossLang[w] === 'zh');
      if (zh.length < 4) return null;
      const w = zh[Math.floor(Math.random() * zh.length)];
      const opts = [w, ...distractorsWords(b, w, 3)];
      if (opts.length < 4) return null;
      usedWords.add(w);
      return { b, kind: 'prod', word: w, prompt: glossOf(w), opts, correct: w, hint: '选出对应的西语词' };
    }
    const verbPool = cand.filter(w => { try { const a = CONJ.analyze(w); return a && a.verb && a.verb.inf === w; } catch (e) { return false; } });
    if (type === 'form' && verbPool.length < 4) return null;
    const w = type === 'form' ? verbPool[Math.floor(Math.random() * verbPool.length)]
                              : cand[Math.floor(Math.random() * cand.length)];
    if (type === 'form') {
      const f = formOf(w);
      if (!f) return null;
      usedWords.add(w);
      return { b, kind: 'form', word: w, prompt: f.form, opts: shuffle([w, ...distractorsWords(b, w, 3)]),
               correct: w, hint: '它来自哪个动词原形？' + (f.label ? '（' + f.label + '）' : '') };
    }
    if (type === 'cloze') {
      const withEx = cand.filter(x => exPool.has(x));
      if (!withEx.length) return null;
      const w2 = withEx[Math.floor(Math.random() * withEx.length)];
      const ex = exPool.get(w2);
      if (!ex || !ex.length) return null;
      const s = ex[Math.floor(Math.random() * ex.length)][0];
      usedWords.add(w2);
      const ds = distractorsWords(b, w2, 3).filter(x => x !== w2);
      if (ds.length < 3) return null;
      return { b, kind: 'cloze', word: w2, prompt: blank(s, w2), opts: shuffle([w2, ...ds]),
               correct: w2, hint: '选出填空的词' };
    }
    const ds = distractors(b, w, 3, true);
    if (ds.length < 3) return null;
    usedWords.add(w);
    return { b, kind: 'recog', word: w, prompt: w, opts: shuffle([glossOf(w), ...ds]), correct: glossOf(w),
             hint: (DATA.TB3.glossLang[w] === 'zh' ? '选出最接近的中文意思' : '选出最接近的释义（此带用英文释义）') };
  }

  function distractorsWords(b, w, k) {
    const out = [];
    for (const bi of [b, b - 1, b + 1, b - 2, b + 2]) {
      if (bi < 0 || bi > 7) continue;
      for (const x of shuffle(DATA.TB3.bands[bi])) {
        if (x === w || out.includes(x) || usedWords.has(x)) continue;
        out.push(x); if (out.length >= k) return out;
      }
    }
    return out;
  }

  function blank(sent, w) {                                    // 词形可能带屈尾，先整词再退化为子串
    const esc2 = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let out = sent.replace(new RegExp('\\b' + esc2 + '\\b', 'i'), '______');
    if (out === sent) out = sent.replace(new RegExp(esc2.slice(0, -1) + '\\w*', 'i'), '______');
    return out === sent ? sent : out;
  }

  function formOf(w) {                                         // 返回一个该动词的变位形式；不是"干净原形"就放弃
    try {
      if (typeof CONJ === 'undefined' || !CONJ.analyze) return null;
      const a = CONJ.analyze(w);
      const v = a && a.verb;
      if (!v || v.inf !== w || !v.tenses) return null;          // tenses 挂在 verb 下面（原来读错层级，形态题一直 0 道）
      const ts = Object.keys(v.tenses);
      for (const tn of shuffle(ts)) {
        const forms = v.tenses[tn];
        const arr = Array.isArray(forms) ? forms : (forms && forms.forms) || [];
        const f = arr.filter(x => typeof x === 'string' && x && x !== w);
        if (f.length) return { form: f[Math.floor(Math.random() * f.length)],
                               label: (CONJ.TENSE_NAMES && CONJ.TENSE_NAMES[tn]) || tn };
      }
      return null;
    } catch (e) { return null; }
  }

  const exPool = new Map();
  async function primeExamples() {                             // 24 个分片取一次，语境题才有真候选
    try {
      const shards = await Promise.all(Array.from({ length: DATA.NEX }, (_, i) => DATA.exShard(i)));
      for (const s of shards) for (const w of Object.keys(s)) {
        const v = s[w];
        if (!exPool.has(w) && Array.isArray(v) && v.length) exPool.set(w, v);
      }
    } catch (e) { /* 取不到就退化成识别题，不影响出题 */ }
  }

  function startQuiz() {
    plan = buildQueue();
    // 造不出题的位置（缺释义/缺例句/非动词）顺延替换成识别题，保证题数与预算一致
    const fixed = [];
    for (const slot of plan) {
      let it = makeItem(slot.b, slot.type);
      if (!it && slot.type !== 'recog') it = makeItem(slot.b, 'recog');
      if (it) fixed.push(it);
    }
    qList = fixed; qNo = 0; prodCount = 0;
    qTotal = qList.length;
    if (!qTotal) return finish();
    askOne();
  }
  async function startQuizAsync() {                            // 先取例句再进题
    await primeExamples();
    startQuiz();
  }
  let qList = [];

  function askOne() {
    const it = qList[qNo];
    show(`
      ${progressHtml(0.45 + 0.55 * qNo / qTotal)}
      <h2>${{ recog: '词义识别', cloze: '语境填空', form: '动词形态', prod: '汉译西' }[it.kind]} · ${DATA.BAND_NAMES[it.b]}${isCog(it.word) ? ' · 同源词' : ''}</h2>
      <p class="t-sub">${esc(it.hint)}：</p>
      <div class="quiz-word">${esc(it.prompt)}</div>
      <div class="quiz-opts">${it.opts.map(o => `<button class="quiz-opt">${esc(o)}</button>`).join('')}</div>
      <div class="t-foot"><span class="faint">${qNo + 1} / ${qTotal}</span></div>`);
    $body().querySelectorAll('.quiz-opt').forEach(btn => {
      btn.onclick = () => {
        const right = btn.textContent === it.correct;
        $body().querySelectorAll('.quiz-opt').forEach(b => {
          b.disabled = true;
          if (b.textContent === it.correct) b.classList.add('right');
        });
        const o = { kind: it.kind, right, cog: isCog(it.word), k: 4 };
        if (it.kind === 'prod') { obs[it.b].prod.push(o); prodCount++; } else obs[it.b].items.push(o);
        if (!right) blind.push(it.word);
        setTimeout(() => { qNo++; if (qNo >= qTotal) finish(); else askOne(); }, right ? 450 : 1000);
      };
    });
  }

  /* ---------- 计分与呈现 ---------- */
  function finish() {
    for (const o of obs) o.prodItems = o.prod;
    const res = TestStat.estimate(obs.map(o => ({ items: o.items, prod: { items: o.prod } })),
                                  SIZES(), SHARES(), PRIOR);
    const dims = dimScores();
    const prodEnough = dims.prod.t >= PROD_MIN;   // 少于这个题数，产出维只是先验，报出来就是骗人
    const level = PROFILE.levelLabel(res.vocab);
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const gap = avg(res.bands.cog) - avg(res.bands.non);
    show(`
      <div class="t-center">
        <div class="faint">识别词汇量（95% 置信区间）</div>
        <div class="result-num">≈ ${res.vocab.toLocaleString()} 词</div>
        <div class="faint">${res.lo.toLocaleString()} – ${res.hi.toLocaleString()} 词</div>
        <div class="faint" style="font-size:12px">实测覆盖 94.6%（N=3000 独立模拟）</div>
        <div class="level-badge" style="display:inline-block">${level}</div>
        <div class="faint" style="margin-top:8px">${prodEnough
          ? `产出词汇量（汉译西）≈ ${Math.min(res.vocabProd, res.vocab).toLocaleString()} 词 · ${PROFILE.levelLabel(Math.min(res.vocabProd, res.vocab))}`
          : `产出词汇量：本次只有 ${dims.prod.t} 道汉译西题（需 ≥${PROD_MIN}），不足以下结论——跑精确模式可以补上`}</div>
      </div>
      <div class="band-bars">
        ${res.bands.cog.map((r, b) => `
          <div class="band-bar"><span class="bb-label">${DATA.BAND_NAMES[b]}</span>
          <div class="bb-track"><div class="bb-fill" style="width:${Math.round(r * 100)}%;background:#7a9b6d"></div></div>
          <span class="bb-val">同 ${Math.round(r * 100)}%</span></div>
          <div class="band-bar"><span class="bb-label"></span>
          <div class="bb-track"><div class="bb-fill" style="width:${Math.round(res.bands.non[b] * 100)}%"></div></div>
          <span class="bb-val">纯 ${Math.round(res.bands.non[b] * 100)}%</span></div>`).join('')}
      </div>
      <div class="entry-label">四个维度（已按猜对率校正）</div>
      <div class="band-bars">
        ${Object.entries(dims).map(([k, v]) => `
          <div class="band-bar"><span class="bb-label">${v.name}</span>
          <div class="bb-track"><div class="bb-fill" style="width:${Math.round(v.rate * 100)}%;background:${v.n ? '#6d8f9b' : '#c9c4bb'}"></div></div>
          <span class="bb-val">${v.t >= 3 ? Math.round(v.rate * 100) + '% · ' + v.t + '题' : (v.t ? '仅 ' + v.t + '题' : '未出题')}</span></div>`).join('')}
      </div>
      ${gap > 0.2 ? `<p class="t-sub">📊 同源词掌握率比纯西语词高 <b>${Math.round(gap * 100)}</b> 个百分点——典型英语背景画像。生词标注按<b>纯西语轨</b>校准：todavía、apenas 这类照样标出，universidad 这类不占你注意力。</p>` : ''}
      <p class="t-sub">这次用了 ${SWEEP_N * 8} 道自查 + ${qTotal} 道选择题${mode === 'quick' ? '（快速模式）。区间偏宽的话可以跑精确模式。' : '。'}</p>
      ${blind.length ? `
        <div class="entry-label">你的盲点词（阅读时会特别标注）</div>
        <div class="blind-list">${blind.slice(0, 48).map(w => `<span class="blind-item">${esc(w)}</span>`).join('')}</div>
        ${blind.length > 48 ? `<div class="faint" style="margin-top:6px">…共 ${blind.length} 个</div>` : ''}` : ''}
      <div class="t-foot">
        <button class="btn ghost" id="t-again">重新测试</button>
        ${mode === 'quick' ? '<button class="btn ghost" id="t-full">精确模式重测</button>' : ''}
        <button class="btn primary" id="t-done">开始阅读 →</button>
      </div>`);

    PROFILE.setTestResult({ vocab: res.vocab, lo: res.lo, hi: res.hi, vocabProd: prodEnough ? Math.min(res.vocabProd, res.vocab) : null,
                            blind: dedupe(blind).slice(0, 200), bands: res.bands, dims,
                            mode, items: SWEEP_N * 8 + qTotal, ts: Date.now(), skipped: false });
    document.getElementById('t-again').onclick = () => start(onFinish, mode);
    if (mode === 'quick') document.getElementById('t-full').onclick = () => start(onFinish, 'full');
    document.getElementById('t-done').onclick = () => {
      document.getElementById('test-modal').classList.add('hidden');
      if (onFinish) onFinish();
    };
  }

  function dimScores() {
    const out = { recog: { name: '词义识别', c: 0, t: 0 }, cloze: { name: '语境填空', c: 0, t: 0 },
                  form: { name: '动词形态', c: 0, t: 0 }, prod: { name: '汉译西', c: 0, t: 0 } };
    for (const o of obs) {
      for (const x of o.items) if (out[x.kind]) { out[x.kind].t++; if (x.right) out[x.kind].c++; }
      for (const x of o.prod) { out.prod.t++; if (x.right) out.prod.c++; }
    }
    for (const k of Object.keys(out)) {
      const v = out[k];
      v.rate = v.t ? Math.max(0, (v.c / v.t - 0.25) / 0.75) : 0;
      if (k === 'prod' && v.t) v.rate = v.c / v.t;
    }
    return out;
  }
  function dedupe(a) { return [...new Set(a.map(x => x.toLowerCase()))]; }

  function resetState(m) {
    mode = m || 'quick';
    budget = BUDGET[mode] || BUDGET.quick;
    obs = Array.from({ length: 8 }, () => ({ items: [], prod: [], sweep: null, committed: false }));
    blind = []; qList = []; prodCount = 0; bandIdx = 0;
    usedWords.clear();
  }

  function intro() {
    show(`
      <h2>西语词汇水平测试 v3</h2>
      <p class="t-sub">按 <b>8 个词频带</b> 分层：① ${SWEEP_N} 词/组快速自查（只定档，不计分）；
      ② 自适应选择题——<b>哪一带最不确定就往哪一带补题</b>。<br>
      题型含<b>词义识别</b>、<b>语境填空</b>、<b>动词形态</b>、<b>汉译西</b>，全部先做 1/4 猜对率校正再合并，
      同源词与纯西语词分两条轨，尾部低频带用英文释义判定。<br>
      结果给区间不给单点，末尾附你的盲点词。</p>
      <div class="t-foot">
        <button class="btn ghost" id="t-skip">跳过测试</button>
        <div><button class="btn ghost" id="t-go-full">精确（约 ${BUDGET.full} 题）</button>
        <button class="btn primary" id="t-go">快速（约 ${BUDGET.quick} 题）→</button></div>
      </div>`);
    document.getElementById('t-go').onclick = () => { resetState('quick'); sweepStage(); };
    document.getElementById('t-go-full').onclick = () => { resetState('full'); sweepStage(); };
    document.getElementById('t-skip').onclick = closeSkip;
  }

  function closeSkip() {
    // 不写假分数：标记 unknown，阅读端回退到先验曲线（profile.js 里判 skipped）
    PROFILE.setTestResult({ vocab: null, skipped: true, unknown: true, bands: null, blind: [], ts: Date.now() });
    document.getElementById('test-modal').classList.add('hidden');
    if (onFinish) onFinish();
  }

  function start(cb, m) {
    onFinish = cb;
    resetState(m);
    document.getElementById('test-modal').classList.remove('hidden');
    if (m) { sweepStage(); return; }
    intro();
  }

  return { start, SWEEP_N, BUDGET };
})();
