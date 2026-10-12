/* 词汇量测试 v2 vs v3 的对照模拟 + teststat.js 等值/区间常量的拟合器。
   目的：让"更准"和"95% 置信区间"都变成可复现的数字，而不是感觉。

   跑法：
     node tools/simulate-test.cjs [学习人数]                 # 打分：按应用当前常量原样评
     node tools/simulate-test.cjs [学习人数] --fit           # 拟合：等值线 a/b + 区间放大系数 ciK
     node tools/simulate-test.cjs [学习人数] --seedbase=900000  # 换一批种子，做完全独立的复算

   两条纪律（旧版本就栽在这两条上）：
   1) 评分路径 == 交付路径。打分直接用 TS.estimate() 返回的 vocab/lo/hi，
      也就是界面 res.vocab / res.lo / res.hi 那三个数，不再在脚本里叠第二层校准。
   2) 拟合与验证的样本不重叠。等值常量在 fit 折（种子 1000+i）上拟，
      覆盖率在验证折（种子 500000+i）上算，报告的是验证折的数。

   真值模型：每个虚拟学习者有一条随词频带单调下降的掌握率曲线；同源词略易；
   自查通道带"元认知过度自信"偏差，选择题通道带 1/4 猜对率——两者都是真实世界的已知偏差。 */
const fs = require('fs');
const path = require('path');

const RES = path.join(__dirname, '..', 'app-src', 'resources');
const TS = require(path.join(RES, 'js', 'teststat.js'));
/* 题库是数据构建产物（不入库）。缺失时干净跳过并给出构建指引，
   否则 `node --test tools/` 会把它当测试跑出一坨 ENOENT 栈，掩盖真实回归结果。 */
const BANK_PATH = path.join(RES, 'data', 'testbank3.json');
if (!fs.existsSync(BANK_PATH)) {
  console.log('跳过 simulate-test：缺少 app-src/resources/data/testbank3.json（数据不入库）。\n' +
    '先跑 `python tools/build_data.py --freq-only`（占位题库）或 `--all`（完整题库）再复跑。');
  process.exit(0);
}
const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf-8'));

const SIZES = bank.bandSizes;                      // [500,500,1000,1000,2000,3000,4000,8000]
const SHARES = bank.meta.map(m => m.cognateShare); // 实测同源占比，不是猜的
const argv = process.argv.slice(2);
const N = parseInt(argv[0] || '1500', 10);
const FIT_MODE = argv.includes('--fit');
const SEED_BASE = +(argv.find(a => a.startsWith('--seedbase=')) || '').split('=')[1] || 1000;
const FIT_BASE = 1000, VAL_BASE = 500000;          // --fit 时两折的种子基址，互不重叠
const NOMINAL = 0.95;                              // 名义置信水平：这是判据，不反过来迁就数字
const SWEEP_N = 16, MCQ_BUDGET = 36;
const PRIOR = { m0: 2, b0: +process.env.B0 || 3.2 };   // 与 test.js 的 PRIOR 保持一致

function mulberry(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* 一个虚拟学习者：theta 决定水平，bias 决定自我评估偏差 */
function makeLearner(rnd) {
  const theta = rnd() * 8;                                   // 临界带位置
  const sharp = 0.75 + rnd() * 0.9;
  const bias = 0.02 + rnd() * 0.16;                          // 元认知过度自信
  const pNon = [], pCog = [];
  for (let b = 0; b < 8; b++) {
    const p = Math.max(0.01, Math.min(0.99, 1 / (1 + Math.exp((b - theta) / sharp))));
    pNon.push(p);
    pCog.push(Math.min(0.995, p + 0.06 + 0.16 * (1 - p)));   // 同源词更容易认得
  }
  return { theta, bias, pNon, pCog, trueV: SIZES.reduce((s, sz, b) => s + sz * (SHARES[b] * pCog[b] + (1 - SHARES[b]) * pNon[b]), 0) };
}

const askSelf = (L, isCog, rnd) => rnd() < Math.min(0.99, (isCog ? L.pCog : L.pNon)[L._b] + L.bias + (isCog ? 0.05 : 0));
// 四选一：会做就基本对（3% 手滑），不会就 1/4 蒙对——估计端正是按这个模型做猜测校正的
const askMcq = (L, isCog, rnd) => { const p = (isCog ? L.pCog : L.pNon)[L._b]; return rnd() < 0.97 * p + 0.25 * (1 - p); };

/* v2 的答题数据装配：固定 16 自查 + 全带审计式选择题 */
function runV2(L, rnd) {
  const sweepRates = [], quiz = {};
  for (let b = 0; b < 8; b++) {
    L._b = b;
    let cT = 0, cK = 0, nT = 0, nK = 0;
    for (let i = 0; i < SWEEP_N; i++) {
      const isCog = i < SWEEP_N / 2;
      const k = askSelf(L, isCog, rnd);
      if (isCog) { cT++; if (k) cK++; } else { nT++; if (k) nK++; }
    }
    sweepRates.push({ cog: cT ? cK / cT : 0, non: nT ? nK / nT : 0 });
  }
  const rates = sweepRates.map(r => (r.cog + r.non) / 2);
  const ones = [], zeros = [], mids = [];
  rates.forEach((r, b) => (r === 1 ? ones : r === 0 ? zeros : mids).push(b));
  mids.sort((a, b) => Math.abs(rates[a] - 0.5) - Math.abs(rates[b] - 0.5));
  const audit = new Set([...ones, ...zeros]);
  const picked = [...new Set([...ones, ...zeros, ...mids])].slice(0, 8);
  for (const b of picked) {
    L._b = b;
    const per = audit.has(b) ? 4 : 2;
    const q = { cog: { t: 0, c: 0 }, non: { t: 0, c: 0 } };
    for (const isCog of [true, false]) {
      for (let i = 0; i < per; i++) { const r = askMcq(L, isCog, rnd); const k = isCog ? q.cog : q.non; k.t++; if (r) k.c++; }
    }
    quiz[b] = q;
  }
  return { est: TS.estimateOld(sweepRates, quiz, SIZES, SHARES, SWEEP_N), items: 8 * SWEEP_N + Object.values(quiz).reduce((s, q) => s + q.cog.t + q.non.t, 0) };
}

/* v3：同样 16 题自查，但选择题按后验不确定度自适应投放，预算用满或够准就停 */
function runV3(L, rnd) {
  const obs = [];
  for (let b = 0; b < 8; b++) {
    L._b = b;
    const items = [];
    for (let i = 0; i < SWEEP_N; i++) {
      const isCog = i < SWEEP_N / 2;
      items.push({ kind: 'self', know: askSelf(L, isCog, rnd), cog: isCog, r: 0.75 });
    }
    obs.push({ items, prod: { items: [] } });
  }
  const sdOf = b => TS.posteriorOf(obs[b].items, TS.priorSet(b, PRIOR), TS.likelihoodOf).sd * SIZES[b];
  let used = 0;
  for (let b = 0; b < 8 && used < 8; b++) {          // 先保证每个带都有 1 题硬证据
    L._b = b;
    obs[b].items.push({ kind: 'mcq', right: askMcq(L, b % 2 === 0, rnd), cog: b % 2 === 0, k: 4 });
    used++;
  }
  while (used < MCQ_BUDGET) {                          // 剩余预算投向最不确定的带
    let worst = 0, wv = -1;
    for (let b = 0; b < 8; b++) { const s = sdOf(b); if (s > wv) { wv = s; worst = b; } }
    L._b = worst;
    const isCog = rnd() < SHARES[worst];
    obs[worst].items.push({ kind: 'mcq', right: askMcq(L, isCog, rnd), cog: isCog, k: 4 });
    used++;
  }
  const est = TS.estimate(obs, SIZES, SHARES, PRIOR);
  est._items = 8 * SWEEP_N + used;
  return est;
}

/* 跑一批学习者；withV2=false 时只跑 v3（拟合折不需要 v2） */
function simulate(n, seedBase, withV2) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const rnd = mulberry(seedBase + i);
    const L = makeLearner(rnd);
    const a = withV2 ? runV2(L, rnd) : null;
    const b3 = runV3(L, rnd);
    out.push({ trueV: L.trueV, v2: a ? a.est.vocab : null, v2items: a ? a.items : 0,
               b3, rawMean: b3.rawMean, rawLo: b3.rawLo, rawHi: b3.rawHi });
  }
  return out;
}

function linfit(xs, ys) {
  const n = xs.length, mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const a = num / den; return { a, b: my - a * mx };
}
const quantileHigh = (xs, q) => { const s = xs.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
/* 修复前的交付常量（2026-09-25 版 teststat.js，当时无 ciK，等效 1）。
   诊断必须钉死这份历史常量：读 TS.EQUATE 会在重拟后把"旧构造对照"变成新构造自检（曾因此报出 70% 假数）。 */
const LEGACY = { a: 1.0928, b: -1806.8 };

/* 旧交付区间的构造（lo/hi 各自等值 → 中心是后验中位数、不是点估计）在同一批人上复算，
   用来说明 state-2026-09-30 里"标称 95%、实测覆盖 64%"这个数是怎么来的。仅诊断用。 */
function diagOld(rows) {
  const eq = v => Math.max(0, Math.round((LEGACY.a * v + LEGACY.b) / 50) * 50);
  let cov = 0, w = 0, off = 0;
  for (const r of rows) {
    const lo = eq(r.rawLo), hi = eq(r.rawHi);
    cov += (r.trueV >= lo && r.trueV <= hi) ? 1 : 0;
    w += hi - lo;
    off += (LEGACY.a * (r.rawLo + r.rawHi) / 2 + LEGACY.b) - eq(r.rawMean);
  }
  console.log(`\n[旧构造对照] 端点各自等值（中心≠点估计）: 覆盖 ${(100 * cov / rows.length).toFixed(1)}% | 平均宽度 ${(w / rows.length).toFixed(0)} 词 | 区间中心比点估计平均偏 ${(off / rows.length).toFixed(0)} 词`);
}

/* 交付路径打分：直接用界面上那三个数 vocab / lo / hi（get 默认取 estimate() 的原返回值） */
function score(rows, label, get = r => r.b3) {
  const bias = [], abs = [], sq = [], cover = [], wid = [], dec = Array.from({ length: 10 }, () => ({ n: 0, c: 0, w: 0 }));
  const err = [];
  let items = 0;
  for (const r of rows) {
    const d = get(r);
    const e = d.vocab - r.trueV;
    bias.push(e); abs.push(Math.abs(e)); sq.push(e * e); err.push(Math.abs(e));
    cover.push(r.trueV >= d.lo && r.trueV <= d.hi ? 1 : 0);
    wid.push(d.hi - d.lo);
    items += d._items;
    // 按真值十分位看覆盖是否均匀：全局 95% 可能被某一段的低覆盖掩盖
    const g = Math.min(9, Math.floor(10 * (r.trueV / 20000)));
    dec[g].n++; dec[g].c += cover[cover.length - 1]; dec[g].w += d.hi - d.lo;
  }
  const rmse = Math.sqrt(mean(sq));
  const p90 = quantileHigh(err, 0.90);
  console.log(`\n【${label}】交付路径实测（vocab/lo/hi 直接取 TestStat.estimate 的返回，与界面同源）`);
  console.log(`  偏差 ${mean(bias).toFixed(0)} 词 | MAE ${mean(abs).toFixed(0)} | RMSE ${rmse.toFixed(0)} | P90 误差 ${p90.toFixed(0)} | 平均题数 ${(items / rows.length).toFixed(0)}`);
  console.log(`  ${(NOMINAL * 100).toFixed(0)}% 区间实际覆盖 ${(100 * mean(cover)).toFixed(1)}%（目标 ${(NOMINAL * 100).toFixed(0)}%）| 平均宽度 ${mean(wid).toFixed(0)} 词`);
  console.log('  按真值十分位的覆盖率（真值按 0–20000 词切成 10 段）:');
  console.log('   ' + dec.map(d => d.n ? (100 * d.c / d.n).toFixed(0) + '%' : '—').join(' '));
  console.log('   ' + dec.map(d => d.n ? '宽' + Math.round(d.w / d.n / 100) / 10 + 'k' : '—').join(' '));
  return { bias: mean(bias), mae: mean(abs), rmse, p90, cover: mean(cover), width: mean(wid), dec };
}

function scoreV2(rows) {
  const bias = [], abs = [], sq = [], err = [];
  for (const r of rows) { if (r.v2 === null) return null; const e = r.v2 - r.trueV; bias.push(e); abs.push(Math.abs(e)); sq.push(e * e); err.push(Math.abs(e)); }
  return { bias: mean(bias), mae: mean(abs), rmse: Math.sqrt(mean(sq)), p90: quantileHigh(err, 0.9),
           items: mean(rows.map(r => r.v2items)) };
}

/* ---------- 模式一：--fit，在 fit 折上拟 a/b/ciK，在验证折上复算 ---------- */
if (FIT_MODE) {
  console.log(`拟合折 ${N} 人（种子基址 ${FIT_BASE}）→ 验证折 ${N} 人（种子基址 ${VAL_BASE}），名义置信水平 ${(NOMINAL * 100).toFixed(0)}%（判据，不动）`);
  const fit = simulate(N, FIT_BASE, false);
  // ① 等值线拟在**等值之前**的原始估计上（旧脚本拟的是已等值过的输出，等于叠了两层）
  const { a, b } = linfit(fit.map(r => r.rawMean), fit.map(r => r.trueV));
  TS.EQUATE.a = a; TS.EQUATE.b = b; TS.EQUATE.ciK = 1;
  // ② 区间放大系数 = 留出折上 |误差| / 等值后半宽 的高分位数（共形预测，含 (1+1/n) 有限样本修正）
  const ratios = fit.map(r => {
    const w = Math.max(a * (r.rawHi - r.rawLo) / 2, 50);   // 下限取取整量子，避免退化区间把分位数拉爆
    return Math.abs(TS.equate(r.rawMean) - r.trueV) / w;
  });
  const ciK = quantileHigh(ratios, Math.min(1, NOMINAL * (1 + 1 / ratios.length)));   // 有限样本修正：宁可略宽
  console.log(`拟合出的等值线: V = ${a.toFixed(4)}·V̂_raw + (${b.toFixed(1)})   区间放大系数 ciK = ${ciK.toFixed(4)}`);
  TS.EQUATE.ciK = ciK;
  // fit 折是在改写 EQUATE 之前跑的，要用同一套交付公式（TS.equate/TS.interval）按新常量重算
  const rebuild = r => { const p = TS.equate(r.rawMean); const itv = TS.interval(p, (r.rawHi - r.rawLo) / 2); return { vocab: p, lo: itv.lo, hi: itv.hi, _items: r.b3._items }; };
  const inSample = score(fit, `拟合折（样本内自检，N=${N}）`, rebuild);
  const val = simulate(N, VAL_BASE, true);
  const out = score(val, `验证折（样本外，N=${N}）`);
  diagOld(val);
  const v2 = scoreV2(val);
  console.log(`\n同一验证折上的 v2 旧算法: 偏差 ${v2.bias.toFixed(0)} | MAE ${v2.mae.toFixed(0)} | RMSE ${v2.rmse.toFixed(0)} | P90 ${v2.p90.toFixed(0)} | 平均题数 ${v2.items.toFixed(0)}`);
  console.log(`v2 MAE 相对 v3: ${(v2.mae / out.mae).toFixed(2)} 倍`);
  console.log('\n把这一行粘进 app-src/resources/js/teststat.js 的 EQUATE:');
  console.log(`  const EQUATE = { a: ${a.toFixed(4)}, b: ${b.toFixed(1)}, ciK: ${ciK.toFixed(4)}, fittedAt: '${new Date().toISOString().slice(0, 10)}', n: ${N} };`);
  console.log(`（样本内覆盖 ${inSample.cover ? (100 * inSample.cover).toFixed(1) : '?'}% / 样本外覆盖 ${out.cover ? (100 * out.cover).toFixed(1) : '?'}%）`);
} else {
  /* ---------- 模式二：打分，完全按 teststat.js 里当前的常量评 ---------- */
  console.log(`虚拟学习者 ${N} 人（种子基址 ${SEED_BASE}；真值：带掌握率曲线 + 自查过度自信 + 选择题 1/4 猜对）`);
  console.log(`当前 EQUATE: a=${TS.EQUATE.a} b=${TS.EQUATE.b} ciK=${TS.EQUATE.ciK}（fittedAt ${TS.EQUATE.fittedAt}, n=${TS.EQUATE.n}）`);
  const rows = simulate(N, SEED_BASE, true);
  const v3 = score(rows, `v3 新（N=${N}）`);
  const v2 = scoreV2(rows);
  console.log(`\nv2 旧算法（同一批人）: 偏差 ${v2.bias.toFixed(0)} | MAE ${v2.mae.toFixed(0)} | RMSE ${v2.rmse.toFixed(0)} | P90 ${v2.p90.toFixed(0)} | 平均题数 ${v2.items.toFixed(0)}`);
  console.log(`v2 MAE 相对 v3: ${(v2.mae / v3.mae).toFixed(2)} 倍`);
}
