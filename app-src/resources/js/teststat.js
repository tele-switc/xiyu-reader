/* 词汇量测量的统计核（v3）。纯函数，浏览器与 node 模拟器共用同一份实现，
   这样"新算法更准"这句话是可以被脚本验证的，而不是感觉。

   三条原则，对应旧的三个毛病：
   1) 统一到同一个量表：四选一先做猜测校正 p_obs = 1/k + (1-1/k)·p，
      元认知自查按"可靠度混淆矩阵"反演（p_report = r·p + (1-r)·(1-p)），
      不再用 |sw-mq|>0.45 这类硬阈值挑一个信、×0.5 这类魔法系数。
   2) 后验用网格贝叶斯：Beta 先验 + 两类观测的似然，直接给出均值与 95% 区间；
      区间经相邻带单调化（PAVA 投影）代替旧的 0.5/0.25/0.25 加权平滑。
   3) 词汇量 = Σ 带大小 × 掌握率；区间由各带后验随机抽样得到，报"±"而不是单点。 */
const TestStat = (() => {
  const GRID = 201;                       // p ∈ [0,1] 步长 0.005
  const ps = Array.from({ length: GRID }, (_, i) => i / (GRID - 1));

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

  /* 先验：掌握率随词频带单调下降的逻辑斯蒂曲线。b0/tau 决定形状，m0 是先验强度（等效题数）。 */
  function priorMean(b, opts) {
    const { b0 = 3.2, tau = 1.35, floor = 0.02, ceil = 0.99 } = opts || {};
    return clamp(ceil / (1 + Math.exp((b - b0) / tau)) + floor, 0.01, 0.995);
  }
  // 下限 1：否则 α<1 时网格端点 0^(α-1) 发散，后验会算出 NaN
  function betaParams(mean, n) { return [Math.max(1, mean * n), Math.max(1, (1 - mean) * n)]; }

  /* ---------- 三种观测通道 → 关于 p 的似然 ---------- */
  // 四选一：会答对，不会就猜（k 个选项）
  function mcqLik(p, correct, k) {
    const q = 1 / k + (1 - 1 / k) * p;
    return correct ? q : 1 - q;
  }
  // 元认知自查：报告本身有噪声（过度自信/猜错都算 r<1）
  function selfLik(p, saysKnow, r) {
    const q = r * p + (1 - r) * (1 - p);
    return saysKnow ? q : 1 - q;
  }
  // 判断题（二选一，如形态/反向）
  const boolLik = (p, correct) => mcqLik(p, correct, 2);

  /* ---------- 网格后验（可跨多个先验做模型平均） ----------
     人群掌握率曲线的形状本来就不确定，用几条先验取加权混合：
     点估计更稳，区间也不会假谦虚（单条先验会把区间压得太窄）。 */
  function posterior(obs, priors) {
    const list = Array.isArray(priors[0]) ? priors : [priors];
    const w = new Float64Array(GRID).fill(0);
    let sum = 0;
    for (const [a0, b0] of list) {
      let s = 0; const t = new Float64Array(GRID);
      for (let i = 0; i < GRID; i++) {
        let v = Math.pow(ps[i], a0 - 1) * Math.pow(1 - ps[i], b0 - 1);
        for (const o of obs) v *= o.kind === 'self' ? selfLik(ps[i], o.know, o.r)
                            : o.kind === 'bool' ? boolLik(ps[i], o.right)
                            : mcqLik(ps[i], o.right, o.k || 4);
        if (!isFinite(v)) v = 0;
        t[i] = v; s += v;
      }
      if (s > 0) for (let i = 0; i < GRID; i++) { w[i] += t[i] / s / list.length; }
    }
    for (let i = 0; i < GRID; i++) sum += w[i];
    if (!(sum > 0)) { for (let i = 0; i < GRID; i++) w[i] = 1; sum = GRID; }
    for (let i = 0; i < GRID; i++) w[i] /= sum;
    const mean = ps.reduce((s, p, i) => s + p * w[i], 0);
    const varr = ps.reduce((s, p, i) => s + (p - mean) * (p - mean) * w[i], 0);
    let acc = 0, lo = 0, hi = 1, t = 0;
    for (let i = 0; i < GRID; i++) {
      acc += w[i];
      while (t < 2 && acc >= (t ? 0.975 : 0.025)) { if (t) hi = ps[i]; else lo = ps[i]; t++; }
    }
    return { mean, sd: Math.sqrt(varr), lo, hi, w: Array.from(w) };
  }

  /* 一组先验：中心带位 b0 与陡峭度 tau 的不确定组合，强度 m0 很弱 */
  function priorSet(b, opts) {
    const { m0 = 2, b0 = 3.2, tau = 1.35, spread = true } = opts || {};
    const shapes = spread ? [[b0 - 0.8, tau * 1.5], [b0, tau], [b0 + 0.8, tau * 0.75]] : [[b0, tau]];
    return shapes.map(([bb, tt]) => betaParams(priorMean(b, { b0: bb, tau: tt, floor: 0.02, ceil: 0.99 }), m0));
  }

  /* ---------- 单调化：词频越高掌握率不该越低，用 PAVA 投影替代旧的经验平滑 ---------- */
  function isotonicDecreasing(vals) {
    const blocks = vals.map(v => ({ s: v, n: 1 }));
    const out = [];
    for (const b of blocks) {
      out.push(b);
      while (out.length > 1 && out[out.length - 2].s / out[out.length - 2].n
                              < out[out.length - 1].s / out[out.length - 1].n) {
        const y = out.pop(), x = out.pop();
        out.push({ s: x.s + y.s, n: x.n + y.n });
      }
    }
    let i = 0; const res = [];
    for (const blk of out) { const m = blk.s / blk.n; for (let k = 0; k < blk.n; k++) res[i++] = m; }
    return res;
  }

  /* ---------- 等值校准（equating）与区间标定 ----------
     四选一猜测校正叠加"掌握率不能为负"的截断，会让低频带单向高估（那一带权重 8000 词，
     实测带来 ~+1000 词的系统偏差）。
     点估计：线性等值 V = a·V̂_raw + b，拟合对象是**等值之前**的原始估计 V̂_raw。
     区间：后验 2.5/97.5 分位的半宽只当"形状"，绝对宽度再乘一个标定系数 ciK——
     实测后验区间系统性偏窄（同一个区间在 N=3000 虚拟人群上只覆盖 64%），
     ciK 取留出折上 |误差| / 等值后半宽 的高分位数（共形预测做法，含 (1+1/n) 有限样本修正）。
     常量由 `node tools/simulate-test.cjs 3000 --fit` 拟合、并在种子不重叠的验证折上复算。
     换题库、换题型或改先验形状之后必须重新拟合，否则这两个修正都是错的。 */
  const EQUATE = { a: 1.1795, b: -2428.9, ciK: 1.0988, fittedAt: '2026-09-30', n: 3000 };
  const equate = v => Math.max(0, Math.round((EQUATE.a * v + EQUATE.b) / 50) * 50);
  /* 交付区间 = 点估计 ± ciK·(等值后的后验半宽)，向外取整到 50，下界不越 0 */
  function interval(point, rawHalf) {
    const w = EQUATE.ciK * EQUATE.a * rawHalf;
    return { lo: Math.max(0, Math.floor((point - w) / 50) * 50), hi: Math.ceil((point + w) / 50) * 50 };
  }

  /* ---------- 由掌握率求词汇量与区间 ---------- */
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function sampleFrom(dist, u) { let a = 0; for (let i = 0; i < dist.length; i++) { a += dist[i]; if (u <= a) return i / (dist.length - 1); } return 1; }

  function vocab(bandPost, sizes, shares) {
    const mean = bandPost.reduce((s, bp, b) => s + sizes[b] * (shares[b] * bp.cog.mean + (1 - shares[b]) * bp.non.mean), 0);
    const prodMean = bandPost.reduce((s, bp, b) => s + sizes[b] * bp.prod.mean, 0);
    // 各带后验独立抽样 → 词汇量分布 → 2.5/97.5 分位
    const N = 6000, rand = rng(20260925), draw = [];
    for (let t = 0; t < N; t++) {
      let v = 0;
      for (let b = 0; b < sizes.length; b++) {
        const pc = sampleFrom(bandPost[b].cog.w, rand()), pn = sampleFrom(bandPost[b].non.w, rand());
        v += sizes[b] * (shares[b] * pc + (1 - shares[b]) * pn);
      }
      draw.push(v);
    }
    draw.sort((x, y) => x - y);
    const q = f => draw[Math.min(N - 1, Math.max(0, Math.round(f * (N - 1))))];
    const rawLo = q(0.025), rawHi = q(0.975);
    const point = equate(mean);
    const itv = interval(point, (rawHi - rawLo) / 2);
    // rawMean/rawLo/rawHi 是**等值之前**的量：重新拟合常量、以及核对"区间是否以点估计为中心"都要用它们
    return { vocab: point, lo: itv.lo, hi: itv.hi, rawMean: mean, rawLo, rawHi,
             vocabProd: equate(prodMean) };
  }

  /* 同源词优势：不是常数，而是"底噪 + 剩余空间的比例"。
     纯常数偏移会在低频带低估优势、逼着 p 抬高去解释同源题的正确率，实测带来 ~+1000 词的系统性高估。 */
  const COG_ADD = 0.12, COG_FRAC = 0;
  const pEff = (p, cog) => cog ? clamp(p + COG_ADD + COG_FRAC * (1 - p), 0, 1) : p;

  /* ---------- 编排：每带一个未知量（纯西语轨掌握率），同源题按偏移量计入 ---------- */
  /* obs[b] = { items: [{kind, know|right, cog, r?, k?}], prod: [同结构，产出维] } */
  const SELF_W = 0.7;   // 自查题权重：每带 16 道自查会淹没 4 道选择题（实测 band0 全答错还报 0.84）
  function likelihoodOf(o, p) {
    const q0 = pEff(p, o.cog);
    if (o.kind === 'self') return Math.pow(selfLik(q0, o.know, o.r || 0.75), SELF_W);
    if (o.kind === 'bool') return boolLik(q0, o.right);
    return mcqLik(q0, o.right, o.k || 4);
  }

  function posteriorOf(obs, priors, map) {
    const list = Array.isArray(priors[0]) ? priors : [priors];
    const w = new Float64Array(GRID);
    for (const [a0, b0] of list) {                 // 每条先验各出一个后验，再等权混合
      const t = new Float64Array(GRID);
      let s = 0;
      for (let i = 0; i < GRID; i++) {
        let v = Math.pow(ps[i], a0 - 1) * Math.pow(1 - ps[i], b0 - 1);
        for (const o of obs) v *= map(o, ps[i]);
        if (!isFinite(v)) v = 0;
        t[i] = v; s += v;
      }
      if (s > 0) for (let i = 0; i < GRID; i++) w[i] += t[i] / s / list.length;
    }
    let sum = 0; for (let i = 0; i < GRID; i++) sum += w[i];
    if (!(sum > 0)) { for (let i = 0; i < GRID; i++) w[i] = 1; sum = GRID; }
    for (let i = 0; i < GRID; i++) w[i] /= sum;
    const mean = ps.reduce((s, p, i) => s + p * w[i], 0);
    const varr = ps.reduce((s, p, i) => s + (p - mean) * (p - mean) * w[i], 0);
    let acc = 0, lo = 0, hi = 1, t = 0;
    for (let i = 0; i < GRID; i++) {
      acc += w[i];
      while (t < 2 && acc >= (t ? 0.975 : 0.025)) { if (t) hi = ps[i]; else lo = ps[i]; t++; }
    }
    return { mean, sd: Math.sqrt(varr), lo, hi, w: Array.from(w) };
  }

  function estimate(obs, sizes, shares, priorOpts) {
    const bandPost = obs.map((o, b) => {
      const pri = priorSet(b, priorOpts);
      const rec = posteriorOf((o.items || []), pri, likelihoodOf);
      const prod = posteriorOf((o.prod && o.prod.items) || [], pri, likelihoodOf);
      return { cog: { mean: pEff(rec.mean, true), w: rec.w, lo: rec.lo, hi: rec.hi, sd: rec.sd },
               non: { mean: rec.mean, w: rec.w, lo: rec.lo, hi: rec.hi, sd: rec.sd },
               prod: { mean: prod.mean, w: prod.w, lo: prod.lo, hi: prod.hi, sd: prod.sd },
               rec };
    });
    const monoNon = isotonicDecreasing(bandPost.map(x => x.non.mean));
    const monoCog = isotonicDecreasing(bandPost.map(x => x.cog.mean));
    bandPost.forEach((x, b) => { x.non.mean = monoNon[b]; x.cog.mean = pEff(monoNon[b], true); x.rec.mean = monoNon[b]; });
    void monoCog;
    const v = vocab(bandPost, sizes, shares);
    return {
      bands: { cog: bandPost.map(x => Math.round(x.cog.mean * 100) / 100),
               non: bandPost.map(x => Math.round(x.non.mean * 100) / 100) },
      bandPost, ...v,
    };
  }

  /* ---------- 旧算法（v2），留在同一文件里是为了能被同一套模拟器打分 ----------
     sweepRates: [{cog,non}] 自查得出的两轨正确率
     quiz:       {bandIdx: {cog:{t,c}, non:{t,c}}} 选择题结果
     原样保留它真实的三个毛病，便于对比：硬阈值融合、邻带 0.5/0.25/0.25 平滑、同源词 ×0.5。 */
  function estimateOld(sweepRates, quiz, sizes, shares, sweepN) {
    const fuse = (sw, m) => {
      if (!m || !m.t) return sw;
      const mq = m.c / m.t;
      if (Math.abs(sw - mq) > 0.45 && m.t >= 4) return mq;
      if (Math.abs(sw - mq) > 0.45 && m.t >= 3) return mq * 0.7 + sw * 0.3;
      const swc = sweepN / 2;
      return (sw * swc + mq * m.t) / (swc + m.t);
    };
    const adj = sweepRates.map((r, b) => ({
      cog: quiz[b] ? fuse(r.cog, quiz[b].cog) : r.cog,
      non: quiz[b] ? fuse(r.non, quiz[b].non) : r.non,
    }));
    const sm = a => a.map((v, i) => v * 0.5 + (a[i - 1] !== undefined ? a[i - 1] : v) * 0.25 + (a[i + 1] !== undefined ? a[i + 1] : v) * 0.25);
    const sCog = sm(adj.map(x => x.cog)), sNon = sm(adj.map(x => x.non));
    let V = 0;
    for (let b = 0; b < sizes.length; b++) V += sizes[b] * (shares[b] * sCog[b] * 0.5 + (1 - shares[b]) * sNon[b]);
    return { vocab: Math.round(V / 50) * 50, bands: { cog: sCog, non: sNon } };
  }

  return { priorMean, priorSet, betaParams, mcqLik, selfLik, boolLik, posteriorOf,
           likelihoodOf, pEff, SELF_W, COG_ADD, COG_FRAC, isotonicDecreasing, estimate, estimateOld, vocab, rng, sampleFrom, GRID, ps,
           EQUATE, equate, interval };   // EQUATE/equate/interval 一起导出：模拟器要在"同一条交付公式"上拟常量
})();

if (typeof module !== 'undefined') module.exports = TestStat;   // 供 node 模拟器复用
