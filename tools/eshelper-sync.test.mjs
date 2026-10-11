/* 西语助手生词本同步 —— 离线回归测试（不联网）
 * 用法：node tools/eshelper-sync.test.mjs
 * 自己拉起本地替身 tools/eudic_stub.py（按欧路官方文档实现契约），用假时钟验证限流与冷却。
 *
 * 覆盖项：
 *   A 旧版只发 id（不带 category_id）→ 官方契约判 400  ← 这就是词传不上去的根因复现
 *   B 新版发 category_id → 201，词真的进生词本
 *   C 18 位生词本 ID 原样传字符串（旧版 Number() 会截断精度）
 *   D 载入即清洗历史积压队列：非法词剔出留档、去重、总数守恒
 *   E 连续查词：一分钟请求数压在官方 30 次线下，且每词只发一次
 *   F 撞 403 → 冷却约 70 分钟，冷却期不再发请求，词一个不丢，冷却后自动补传
 *   G 撞 401 → 如实提示授权问题，词留队列
 *   H 未开启同步 → 不入队、不发请求
 *   I 短语被剔出但留档可见（不静默丢）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PY = process.platform === 'win32' ? 'C:\\Python314\\python.exe' : 'python3';
const PORT = 8744;
const BASE = `http://127.0.0.1:${PORT}/api/open/v1`;
const stub = spawn(PY, [path.join(ROOT, 'tools', 'eudic_stub.py'), String(PORT)], { stdio: 'ignore' });

const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  → ' + detail : ''}`);
}

async function waitForStub() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/__mode`); if (r.ok) return; } catch (e) {}
    await sleep(150);
  }
  throw new Error('替身服务没起来（检查 python 路径）');
}
const setMode = async m => { await (await fetch(`http://127.0.0.1:${PORT}/__mode?set=${m}`)).json(); };
const allReqs = async () => (await (await fetch(`http://127.0.0.1:${PORT}/__requests`)).json());
const wordReqs = async () => (await allReqs()).filter(x => x.path.endsWith('/studylist/words'));
const book = async (cat = '0') => (await (await fetch(`http://127.0.0.1:${PORT}/__book?cat=${cat}`)).json());

/* ---------- 把浏览器脚本装进 vm：真 fetch + 假时钟 + 假 localStorage ---------- */
function loadEshelper(source, env) {
  const ctx = createContext({
    console, fetch, AbortController,
    setTimeout: (fn, ms) => env.clock.setTimer(fn, ms),
    clearTimeout: () => {},
    module: undefined, document: undefined, window: undefined,
    localStorage: env.storage,
  });
  runInContext(source + '\n;globalThis.__E = Eshelper;', ctx, { filename: 'eshelper.js' });
  const E = ctx.__E;
  E.configure({ base: BASE, now: env.clock.now, timer: env.clock.setTimer });
  E.load();
  return E;
}
function makeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
function makeClock(start = 1_790_000_000_000) {
  let t = start;
  let due = [];
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      const todo = due.sort((a, b) => a.at - b.at);
      due = [];
      for (const d of todo) { if (d.at <= t) d.fn(); else due.push(d); }
    },
    setTimer: (fn, ms) => { due.push({ fn, at: t + (ms || 0) }); return due.length - 1; },
    clear: () => {},
  };
}
const seedSettings = (over = {}) => JSON.stringify(Object.assign(
  { enabled: true, token: 'NIS stub-token-abcdef', catId: '0', catName: '默认生词本' }, over));

function freshInstance(src, { seed = {}, clockOver } = {}) {
  const clock = clockOver || makeClock();
  const storage = makeStorage(seed);
  const E = loadEshelper(src, { storage, clock });
  return { E, clock, storage };
}

try {
  await waitForStub();
  const src = readFileSync(path.join(ROOT, 'app-src', 'resources', 'js', 'eshelper.js'), 'utf8');

  
/* ===== A. 复现根因：只发 id、没有 category_id ===== */
  const rA = await fetch(`${BASE}/studylist/words`, {
    method: 'POST',
    headers: { Authorization: 'NIS stub-token-abcdef', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '0', language: 'es', words: ['bodega'] }),   // 旧版形状
  });
  const jA = await rA.json();
  check('A 旧版只发 id → 服务端按官方契约判 400', rA.status === 400, `HTTP ${rA.status}｜${jA.message}`);

  /* ===== B. 新版：category_id → 201，词真的进去 ===== */
  const { E: EB, clock: clockB } = freshInstance(src, { seed: { 'sr-eshelper': seedSettings() } });
  const outB = await EB.onLookup('bodega');
  clockB.advance(3000);
  const reqB = (await wordReqs()).slice(-1)[0];
  const bookB = await book('0');
  check('B 查词触发同步并返回 synced', outB === 'synced', String(outB));
  check('B 请求体使用 category_id', reqB && String(reqB.body.category_id) === '0',
        reqB && JSON.stringify(reqB.body));
  check('B 不再带上被服务端拒绝的 id 字段', reqB && !('id' in reqB.body),
        reqB ? 'body 键：' + Object.keys(reqB.body).join(',') : 'no req');
  check('B 词确实进了云端生词本', bookB.words.includes('bodega'), bookB.words.join(','));

  /* ===== C. 18 位 ID 不被数字转换破坏 ===== */
  const BIG = '190000000000000001';
  const { E: EC, clock: clockC } = freshInstance(src, { seed: { 'sr-eshelper': seedSettings({ catId: BIG }) } });
  await EC.onLookup('feto');
  clockC.advance(3000);
  const reqC = (await wordReqs()).slice(-1)[0];
  const bookC = await book(BIG);
  check('C 大整数生词本 ID 原样传字符串', String(reqC.body.category_id) === BIG, String(reqC.body.category_id));
  const bookDef = await book('0');
  check('C 词进了指定本子（非默认本）', bookC.words.includes('feto') && !bookDef.words.includes('feto'),
        bookC.words.join(','));

  /* ===== D. 历史积压队列清洗（用真机抓下来的 240 条） ===== */
  const legacy = JSON.parse(readFileSync(path.join(ROOT, 'tools', 'fixtures', 'legacy-queue.json'), 'utf8'));
  const { E: ED } = freshInstance(src, { seed: {
    'sr-eshelper': seedSettings(), 'sr-eshelper-queue': JSON.stringify(legacy) } });
  const sD = ED.stats();
  const dbgD = ED._debug();
  const allValid = dbgD.queue.every(x => ED.valid(x.w));
  const uniq = new Set(dbgD.queue.map(x => x.w)).size === dbgD.queue.length;
  const conserved = sD.queue + sD.dropped === legacy.length;
  check('D 清洗后队列里全部是合格单词', allValid, `queue=${sD.queue}（原始 ${legacy.length}）`);
  check('D 清洗后无重复', uniq, `唯一数 ${new Set(dbgD.queue.map(x => x.w)).size}`);
  check('D 词数守恒（留下的 + 留档的 = 原始数）', conserved,
        `${sD.queue} + ${sD.dropped} = ${sD.queue + sD.dropped} vs ${legacy.length}`);
  const droppedSamples = dbgD.dropped.slice(0, 4).map(x => `${JSON.stringify(x.w)}(${x.why})`);
  check('D 被剔出的确实是空格串/残字符/超短词', dbgD.dropped.length > 0, droppedSamples.join(' '));

  /* ===== E. 连续查词的请求频率 ===== */
  await setMode('ok');
  const beforeE = (await allReqs()).length;
  const { E: EE, clock: clockE } = freshInstance(src, { seed: { 'sr-eshelper': seedSettings() } });
  const words = ['surcos', 'tuerto', 'plebeyo', 'oteaban', 'simientes', 'furtivas', 'matamoscas',
                 'intrusos', 'quemar', 'cuello', 'azada', 'nave', 'bonanza', 'vivero', 'calibrar'];
  const sentE = [];
  for (const w of words) { sentE.push(await EE.onLookup(w)); clockE.advance(2700); }
  const reqsE = (await allReqs()).slice(beforeE).filter(x => x.path.endsWith('/studylist/words'));
  const bookE = await book('0');
  check('E 15 个词全部同步成功', sentE.every(x => x === 'synced') && words.every(w => bookE.words.includes(w)),
        words.filter(w => !bookE.words.includes(w)).join(',') || '全部在库');
  check('E 每词只发一次请求（失败不重试放大）', reqsE.length === words.length, `POST ${reqsE.length} 次`);
  check('E 一分钟内请求数压在 30 次线下', reqsE.length <= 22, `${reqsE.length} 次 / 40.5 秒`);

  /* ===== F. 403 冷却 ===== */
  await setMode('403');
  const { E: EF, clock: clockF } = freshInstance(src, { seed: { 'sr-eshelper': seedSettings() } });
  const outF = await EF.onLookup('guadañas');
  const sF1 = EF.stats();
  const reqsF1 = (await wordReqs()).length;
  const outF2 = await EF.onLookup('quemar');
  const sF2 = EF.stats();
  const reqsF2 = (await wordReqs()).length;
  check('F 403 时词留在队列（不丢）', outF === 'queued' && sF1.queue === 1, `queue=${sF1.queue}`);
  check('F 进入约 70 分钟冷却', sF1.cooldownLeft > 60 * 60000 && sF1.cooldownLeft <= 71 * 60000,
        Math.round(sF1.cooldownLeft / 60000) + ' 分钟');
  check('F 冷却期内不再发请求、两个词都留着', sF2.queue === 2 && reqsF2 === reqsF1,
        `queue=${sF2.queue}，新增请求 ${reqsF2 - reqsF1}`);
  check('F 错误如实上报（含 HTTP 码）', /403/.test(EF.errorText()), EF.errorText());

  await setMode('ok');
  clockF.advance(71 * 60000);
  const rF3 = await EF.flush();
  const bookF = await book('0');
  check('F 冷却结束后自动补传两个词', rF3.sent === 2 && bookF.words.includes('guadañas'),
        `补传 ${rF3.sent}｜${bookF.words.slice(-3).join(',')}`);
  check('F 补传后队列清空', EF.stats().queue === 0, `queue=${EF.stats().queue}`);

  /* ===== G. 401 授权失效 ===== */
  await setMode('401');
  const { E: EG } = freshInstance(src, { seed: { 'sr-eshelper': seedSettings() } });
  const outG = await EG.onLookup('apenas');
  check('G 401 时词留队列且提示授权', outG === 'queued' && /401/.test(EG.errorText()), EG.errorText());
  await setMode('ok');

  /* ===== H. 未开启同步 ===== */
  const { E: EH } = freshInstance(src, { seed: { 'sr-eshelper': seedSettings({ enabled: false }) } });
  const outH = await EH.onLookup('todavía');
  check('H 未开启 → 不入队不发请求', outH === null && EH.stats().queue === 0, `queue=${EH.stats().queue}`);

  /* ===== I. 短语剔出但留档 ===== */
  const { E: EI } = freshInstance(src, { seed: { 'sr-eshelper': seedSettings() } });
  const outI = await EI.onLookup('en vez de');
  const sI = EI.stats();
  check('I 短语被剔出并留档可见', outI === 'dropped' && sI.dropped === 1 && sI.queue === 0,
        `dropped=${sI.dropped} queue=${sI.queue}`);

  /* ===== J. 超批量上限的积压会自动分批排空 ===== */
  await setMode('ok');
  const many = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < 100; i++) {
    const w = 'palabra' + letters[i % 26] + letters[Math.floor(i / 26) % 26];   // 纯字母，避开数字校验
    many.push({ w, ts: 1 });
  }
  const { E: EJ, clock: clockJ } = freshInstance(src, { seed: {
    'sr-eshelper': seedSettings(), 'sr-eshelper-queue': JSON.stringify(many) } });
  const rJ1 = await EJ.flush();
  clockJ.advance(3200);            // 触发分批续传的定时器
  const rJ2 = await EJ.flush();
  const bookJ = await book('0');
  const missing = many.filter(x => !bookJ.words.includes(x.w)).map(x => x.w);
  check('J 100 词积压分两批传完（80 + 20）', rJ1.sent === 80 && rJ2.sent === 20 && missing.length === 0,
        `第一批 ${rJ1.sent}，第二批 ${rJ2.sent}，缺 ${missing.length}`);
  check('J 全部落地云端生词本', missing.length === 0, missing.slice(0, 5).join(','));

  /* ===== K. 被 Number() 截断过的生词本 ID 自愈 ===== */
  const WRONG = '190000000000000000';   // 真机同类事故：尾数被双精度改掉，服务端不存在这个 ID
  const beforeK = (await allReqs()).length;
  const { E: EK, clock: clockK, storage: stK } = freshInstance(src, { seed: {
    'sr-eshelper': seedSettings({ catId: WRONG, catName: '西语精读' }),
    'sr-eshelper-queue': JSON.stringify([{ w: 'apenas', ts: 1 }, { w: 'todavia', ts: 2 }]) } });
  const rK = await EK.flush();
  clockK.advance(3200);
  const sK = EK.stats();
  const bookK = await book(BIG);
  check('K 不存在的 ID 按名字找回正确 ID', sK.settings.catId === BIG, `${WRONG} → ${sK.settings.catId}`);
  check('K 修正后两个积压词传成功', rK.sent === 2 && bookK.words.includes('apenas') && bookK.words.includes('todavia'),
        `sent=${rK.sent}｜${bookK.words.join(',')}`);
  const persistedK = JSON.parse(stK.getItem('sr-eshelper'));
  check('K 修正结果写回本机设置', String(persistedK.catId) === BIG, '存回 catId=' + persistedK.catId);

  /* ---- 汇总 ---- */
  const failed = results.filter(r => !r.pass);
  console.log(`\n===== 汇总：共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} =====`);
  if (failed.length) console.log('失败项：' + failed.map(f => f.name).join('  /  '));
  writeFileSync(path.join(ROOT, 'tools', 'fixtures', 'last-sync-test.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 1));
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('测试异常：', e && e.stack || e);
  process.exitCode = 1;
} finally {
  stub.kill();
}
