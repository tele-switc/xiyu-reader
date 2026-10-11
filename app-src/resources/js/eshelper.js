/* 西语助手生词本同步 v2
 * 后端：欧路开放平台 OpenAPI（api.frdic.com，与西语助手同账号同云端生词本）。
 *
 * 本版修正（1.0.1 的词一直传不上去，原因在这里）：
 *  1. 加词请求体改发 category_id。官方文档里 id 已标注「已废弃，建议使用 category_id」，
 *     只发 id 会被服务端判参数错误（400），于是每个词都传失败、全部退回队列越积越多。
 *  2. 生词本 ID 一律按字符串处理，不再 Number()。官方 ID 是 18 位（如
 *     190000000000000001），超过 2^53 会被双精度改掉尾数，词就进错本子。
 *  3. 限流与退避。官方限制：1 分钟 30 次 → 封停 1 小时；30 分钟 500 次 → 封 24 小时。
 *     旧实现是「每查一个词立刻发一次请求」，连续查词必踩 403。现在：合并批量、
 *     两次请求至少间隔 2.6 秒、60 秒滑动窗口最多 22 次，403 直接冷却 70 分钟。
 *  4. 入队前校验 + 去重 + 队列上限，被丢弃的词单独留档，不静默丢。
 *  5. 失败原因如实显示：HTTP 码 + 服务端 message（官方把错误信息固定在 message 字段）。
 *  6. 补传串行化（旧版并发 flush 会把同一个词重复塞回队列，造成大量重复条目）。
 *
 * 官方文档：https://my.eudic.net/doc/index.md（响应码 / 流量限制）
 *           https://my.eudic.net/doc/api_study.md（生词本 API）
 */
const Eshelper = (() => {
  const SKEY = 'sr-eshelper';          // {enabled, token, catId(字符串), catName}
  const DKEY = 'sr-eshelper-done';     // 已确认同步 {word: ts}
  const QKEY = 'sr-eshelper-queue';    // 待补传 [{w, ts}]
  const XKEY = 'sr-eshelper-dropped';  // 校验没过被剔出的词 [{w, why, ts}]
  const CKEY = 'sr-eshelper-cooldown'; // 冷却到期时间戳（403/退避用）
  const EKEY = 'sr-eshelper-error';    // 最近一次真实错误 {at, status, text}

  const API_DEFAULT = 'https://api.frdic.com/api/open/v1';
  const LANG = 'es';
  let API = API_DEFAULT;            // 离线回归测试可用 configure({base}) 指向本地替身

  const MIN_GAP = 2600;          // 两次请求最小间隔 ms（≈23 次/分，压在 30 次线下）
  const WINDOW = 60000;          // 滑动窗口
  const MAX_PER_WINDOW = 22;     // 窗口内最多请求数
  const BATCH_MAX = 80;          // 单次 POST 最多带多少个词
  const QUEUE_MAX = 2000;        // 队列上限
  const DONE_MAX = 20000;        // 去重记录上限
  const COOLDOWN_403 = 70 * 60000;  // 撞 403 官方封 1 小时，这里冷却 70 分钟
  const BACKOFF_BASE = 5000;     // 失败退避基数
  const BACKOFF_MAX = 10 * 60000;
  const DROP_MAX = 5000;         // 被剔出词的留档上限
  const TIMEOUT = 15000;         // 单请求超时

  /* ---------- 可在 Node 侧注入，方便离线回归 ---------- */
  let store = (typeof localStorage !== 'undefined')
    ? localStorage
    : (() => { const m = new Map(); return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
      }; })();
  let doFetch = (typeof fetch !== 'undefined') ? ((...a) => fetch(...a)) : null;
  let nowFn = () => Date.now();
  let timerFn = (fn, ms) => setTimeout(fn, ms);

  function configure(o) {
    if (o.storage) store = o.storage;
    if (o.fetch) doFetch = o.fetch;
    if (o.now) nowFn = o.now;
    if (o.timer) timerFn = o.timer;
    if (o.base) API = o.base;
  }

  let settings = {}, done = {}, queue = [], dropped = [];
  let cooldownUntil = 0, failStreak = 0, lastReqAt = 0, recent = [];
  let flushing = null, retryTimer = null, lastError = null;

  function jread(key, fb) {
    try { const v = JSON.parse(store.getItem(key)); return (v === null || v === undefined) ? fb : v; }
    catch (e) { return fb; }
  }
  function jwrite(key, val) {
    try { store.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { console.warn('[Eshelper] 本地存储写入失败', key, e && e.message); return false; }
  }
  function load() {
    settings = jread(SKEY, {});
    done = jread(DKEY, {});
    queue = Array.isArray(jread(QKEY, [])) ? jread(QKEY, []) : [];
    dropped = Array.isArray(jread(XKEY, [])) ? jread(XKEY, []) : [];
    cooldownUntil = Number(jread(CKEY, 0)) || 0;
    lastError = jread(EKEY, null);
    pruneLegacy();
  }
  function saveSettings() { jwrite(SKEY, settings); }
  function saveDone() {
    const keys = Object.keys(done);
    if (keys.length > DONE_MAX) for (const k of keys.slice(0, keys.length - DONE_MAX)) delete done[k];
    jwrite(DKEY, done);
  }
  function saveQueue() {
    if (queue.length > QUEUE_MAX) {                 // 超限只留最新的，剔出的留档
      const cut = queue.splice(QUEUE_MAX);
      for (const x of cut) dropped.unshift({ w: x.w, why: '队列超限', ts: x.ts });
      if (dropped.length > DROP_MAX) dropped.length = DROP_MAX;
      jwrite(XKEY, dropped);
    }
    jwrite(QKEY, queue);
  }
  function saveCooldown() { jwrite(CKEY, cooldownUntil || 0); }
  function setError(status, text) {
    lastError = { at: nowFn(), status: status || 0, text: String(text || '').slice(0, 300) };
    jwrite(EKEY, lastError);
  }

  /* ---------- 词形校验：只收单个西语词 ---------- */
  function badWord(raw) {
    const w = String(raw == null ? '' : raw).trim();
    if (!w) return '空';
    if (/\s/.test(w)) return '含空格（多词短语）';
    if (/[0-9]/.test(w)) return '含数字';
    if (!/^[\p{L}\p{M}]+$/u.test(w)) return '含标点或残字符';
    if (w.length < 2) return '太短';
    if (w.length > 40) return '太长';
    return null;
  }
  function valid(raw) { return badWord(raw) === null; }

  /* 载入时清洗历史队列（1.0.1 积压的词里有空格串、残字符、重复项）
   * 守恒：留下的 + 留档的 = 原始条数。重复项也进留档，绝不静默丢。 */
  function pruneLegacy() {
    const synced = new Set(Object.keys(done));
    const seen = new Set();
    const keep = [], lost = [];
    for (const x of queue) {
      const w = String((x && x.w) || '').trim().toLowerCase();
      const why = badWord(w);
      if (why) { lost.push({ w: (x && x.w) || '', why: '清洗：' + why, ts: (x && x.ts) || nowFn() }); continue; }
      if (synced.has(w)) { lost.push({ w, why: '清洗：已在已同步记录中', ts: (x && x.ts) || nowFn() }); continue; }
      if (seen.has(w)) { lost.push({ w, why: '清洗：队列内重复', ts: (x && x.ts) || nowFn() }); continue; }
      seen.add(w);
      keep.push({ w, ts: (x && x.ts) || nowFn() });
    }
    if (lost.length || keep.length !== queue.length) {
      dropped = lost.concat(dropped);
      if (dropped.length > DROP_MAX) dropped.length = DROP_MAX;
      queue = keep;
      jwrite(XKEY, dropped);
      jwrite(QKEY, queue);
    }
  }

  /* ---------- 授权头与请求 ---------- */
  function authHeader() {
    const t = String(settings.token || '').trim();
    return /^NIS\s/.test(t) ? t : 'NIS ' + t;    // 允许直接粘贴整段授权串
  }
  async function api(method, path, body) {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT) : null;   // 超时用真实时钟
    let r, text = '';
    try {
      r = await doFetch(API + path, {
        method,
        headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        signal: ctrl ? ctrl.signal : undefined,
      });
    } finally {
      if (timer && typeof clearTimeout !== 'undefined') clearTimeout(timer);
    }
    text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    const msg = json && (json.message || json.title) || text.slice(0, 160);
    if (!r.ok) {
      const err = new Error(msg || ('HTTP ' + r.status));
      err.status = r.status;
      throw err;
    }
    return { json: json || {}, status: r.status, message: (json && json.message) || '' };
  }

  /* ---------- 节流 ---------- */
  function canRequest() {
    const t = nowFn();
    recent = recent.filter(x => t - x < WINDOW);
    if (cooldownUntil > t) return { ok: false, why: '冷却中，' + Math.ceil((cooldownUntil - t) / 1000) + ' 秒后可再试' };
    if (recent.length >= MAX_PER_WINDOW) return { ok: false, why: '本分钟请求已近上限，稍后自动补传' };
    if (t - lastReqAt < MIN_GAP) return { ok: false, why: '请求太密，稍后自动补传' };
    return { ok: true };
  }
  /* gap=true：写请求，占最小间隔；gap=false：只读请求（如取生词本列表），
     计入每分钟窗口但不给后续写请求设间隔，否则自愈的那次 GET 会把紧随其后的加词挤成「待同步」。 */
  function noteRequest(gap) {
    const t = nowFn();
    recent.push(t);
    if (gap !== false) lastReqAt = t;
    if (recent.length > 200) recent = recent.slice(-200);
  }
  function scheduleRetry(delay) {
    if (retryTimer || queue.length === 0) return;
    retryTimer = timerFn(() => { retryTimer = null; flush().catch(() => {}); }, Math.max(1200, delay));
  }

  /* ---------- 生词本分类（ID 全程用字符串） ---------- */
  async function listCategories() {
    const res = await api('GET', `/studylist/category?language=${LANG}`);
    return ((res.json && res.json.data) || []).map(c => ({ id: String(c.id), language: c.language, name: c.name }));
  }
  async function createCategory(name) {
    const res = await api('POST', '/studylist/category', { language: LANG, name });
    const c = res.json && res.json.data;
    return c ? { id: String(c.id), name: c.name } : null;
  }

  /* ---------- 加词：只发 category_id ---------- */
  async function pushWords(words) {
    const cat = String(settings.catId === undefined || settings.catId === null || settings.catId === '' ? '0' : settings.catId);
    // 只发 category_id。实测真服务端对已废弃的 id 字段直接判 400「参数不正确：id」，带上反而坏事。
    return api('POST', '/studylist/words', {
      language: LANG, category_id: cat, words,
    });
  }

  /* ---------- 生词本 ID 自愈 ----------
   * 1.0.1 用 Number() 存过 ID，18 位 ID 尾数会被双精度改掉（实测本机存的
   * 190000000000000002，服务端真实值是 190000000000000003）。这里按 catName 找回正确 ID 并写回。 */
  let catChecked = false, catRepair = null;
  async function ensureCategoryValid() {
    if (catChecked) return;
    const cur = String(settings.catId || '0');
    if (cur === '0') { catChecked = true; return; }
    try {
      noteRequest(false);          // 只读，不占写请求间隔
      const cats = await listCategories();
      catChecked = true;
      if (cats.some(c => c.id === cur)) return;
      const byName = cats.find(c => c.name === settings.catName);
      settings.catId = byName ? byName.id : '0';
      settings.catName = byName ? byName.name : '默认生词本';
      catRepair = { from: cur, to: settings.catId, name: settings.catName, at: nowFn() };
      saveSettings();
      jwrite('sr-eshelper-repair', catRepair);
      console.warn('[Eshelper] 生词本 ID 已修正', JSON.stringify(catRepair));
    } catch (e) { /* 列表取不到就先不修，让后续请求把真实错误报出来 */ }
  }

  /* ---------- 补传（串行，一次最多 BATCH_MAX 个词） ---------- */
  /* 补传入口。锁必须在任何 await 之前占上，否则两次 flush 会交错，
   把同一批词重复排进队列（1.0.1 的 240 条积压里 107 条就是这么来的）。 */
  async function flush() {
    if (flushing) return flushing;
    flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }

  async function doFlush() {
    if (!settings.enabled || !(settings.token || '').trim()) return { sent: 0, left: queue.length, why: '未开启或未填 Token' };
    if (!queue.length) return { sent: 0, left: 0 };

    await ensureCategoryValid();
    const gate = canRequest();
    if (!gate.ok) { scheduleRetry(MIN_GAP + 400); return { sent: 0, left: queue.length, why: gate.why }; }

    const batch = queue.slice(0, BATCH_MAX);
    noteRequest(true);
    try {
      const res = await pushWords(batch.map(x => x.w));
      const t = nowFn();
      for (const x of batch) { done[x.w] = t; deleteQueue(x.w); }
      saveDone(); saveQueue();
      failStreak = 0; cooldownUntil = 0; saveCooldown();
      setError(0, '');
      if (queue.length) scheduleRetry(MIN_GAP + 200);   // 积压分批继续排空
      return { sent: batch.length, left: queue.length, message: res.message, status: res.status };
    } catch (e) {
      failStreak++;
      const st = e.status || 0;
      setError(st, e.message || String(e));
      if (st === 401) {
        cooldownUntil = nowFn() + 60 * 60000;            // 授权失效：1 小时内不再重试
      } else if (st === 403) {
        cooldownUntil = nowFn() + COOLDOWN_403;          // 官方：1 分钟超 30 次封 1 小时
      } else if (st === 400) {
        cooldownUntil = 0;                               // 参数问题：重试无意义，等人工修正后再补传
        failStreak = 0;
      } else {
        cooldownUntil = 0;                               // 网络类：指数退避
        scheduleRetry(Math.min(BACKOFF_MAX, BACKOFF_BASE * Math.pow(2, Math.min(failStreak, 8))));
      }
      saveCooldown();
      return { sent: 0, left: queue.length, error: e, status: st, why: e.message };
    }
  }

  function deleteQueue(w) {
    const i = queue.findIndex(x => x.w === w);
    if (i >= 0) queue.splice(i, 1);
  }

  /* 查词入口：只同步单个西语单词；返回 'synced' | 'queued' | 'dropped' | null */
  async function onLookup(word) {
    if (!settings.enabled || !(settings.token || '').trim()) return null;
    const w = String(word || '').trim().toLowerCase();
    const why = badWord(w);
    if (why) {
      if (why !== '空') {
        dropped.unshift({ w: String(word || '').trim(), why, ts: nowFn() });
        if (dropped.length > DROP_MAX) dropped.length = DROP_MAX;
        jwrite(XKEY, dropped);
        return 'dropped';
      }
      return null;
    }
    if (done[w]) return 'synced';
    if (!queue.some(x => x.w === w)) {
      queue.unshift({ w, ts: nowFn() });
      saveQueue();
    }
    const r = await flush();
    if (r.sent) return 'synced';
    return 'queued';
  }

  /* 启动时补传一次；失败静默留队，不打扰阅读 */
  async function flushOnStart() {
    if (!settings.enabled || !queue.length) return;
    try { await flush(); } catch (e) { console.warn('[Eshelper] 队列补传失败', e); }
  }

  /* ---------- 面板文案 ---------- */
  function statusText() {
    const n = Object.keys(done).length;
    let s = `已同步 ${n} 个词` + (queue.length ? `，${queue.length} 个待补传` : '');
    if (dropped.length) s += `，${dropped.length} 个未通过词形校验（留档未上传）`;
    const left = Math.max(0, cooldownUntil - nowFn());
    if (left) s += `，冷却中 ${Math.ceil(left / 1000)} 秒`;
    return s;
  }
  function errorText() {
    if (!lastError || !lastError.status) return '';
    const code = { 400: '400 参数错误', 401: '401 授权未通过（Token 无效或过期）', 403: '403 访问过于频繁', 500: '500 服务端' }[lastError.status] || ('HTTP ' + lastError.status);
    return code + '：' + lastError.text;
  }

  return {
    configure, load, onLookup, flush, flushOnStart, listCategories, createCategory,
    statusText, errorText, valid, badWord,
    stats: () => ({ done: Object.keys(done).length, queue: queue.length, dropped: dropped.length,
                    cooldownLeft: Math.max(0, cooldownUntil - nowFn()), failStreak, catRepair,
                    settings: { enabled: !!settings.enabled, catId: String(settings.catId || '0'), hasToken: !!(settings.token || '').trim() } }),
    _debug: () => ({ settings, queue, done, dropped, cooldownUntil, recent: recent.length, lastError }),
  };
})();

/* ---------- 设置面板（需要 DOM；Node 侧自动跳过） ---------- */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  (function bindPanel(E) {
    const $ = id => document.getElementById(id);
    let settings = { catId: '0', catName: '' };

    function readState() { try { settings = JSON.parse(localStorage.getItem('sr-eshelper')) || {}; } catch (e) {} }
    function writeState() { localStorage.setItem('sr-eshelper', JSON.stringify(settings)); }

    function renderDetail() {
      const st = E.stats();
      const el = $('esh-status'), dt = $('esh-detail');
      if (el) {
        const err = E.errorText();
        el.textContent = err || (st.settings.enabled && st.settings.hasToken ? '同步已开启' : '尚未开启或未填 Token');
        el.className = 'esh-status ' + (err ? 'warn' : 'faint');
      }
      if (dt) dt.textContent = st.done + ' 词已同步 · ' + st.queue + ' 词待补传 · ' +
        st.dropped + ' 词被剔出留档 · 本分钟已发 ' + Math.min(st.failStreak, 999) + ' 次失败' +
        (st.cooldownLeft ? ' · 冷却 ' + Math.ceil(st.cooldownLeft / 1000) + ' 秒' : '');
    }

    function fillCats(cats, selected) {
      const sel = $('esh-cat');
      if (!sel) return;
      sel.innerHTML = '';
      const mk = (id, name) => {
        const o = document.createElement('option');
        o.value = String(id); o.textContent = name;
        if (String(id) === String(selected)) o.selected = true;
        sel.appendChild(o);
      };
      mk('0', '默认生词本');
      (cats || []).forEach(c => { if (String(c.id) !== '0') mk(c.id, c.name); });
    }

    function openModal() {
      E.load(); readState();
      const en = $('esh-enabled'), tk = $('esh-token');
      if (en) en.checked = !!settings.enabled;
      if (tk) tk.value = settings.token || '';
      const st = E.stats();
      fillCats(null, st.settings.catId);
      if (settings.catId && String(settings.catId) !== '0') {
        const o = document.createElement('option');
        o.value = String(settings.catId); o.textContent = settings.catName || String(settings.catId); o.selected = true;
        $('esh-cat').appendChild(o);
      }
      renderDetail();
      $('esh-modal').classList.remove('hidden');
    }
    function closeModal() { $('esh-modal').classList.add('hidden'); }

    async function testAndLoadCats() {
      settings.token = $('esh-token').value.trim();
      settings.enabled = $('esh-enabled').checked;
      if (!settings.token) { renderDetail(); localStorage.setItem('sr-eshelper', JSON.stringify(settings)); return; }
      const st = $('esh-status');
      st.textContent = '连接中…'; st.className = 'esh-status faint';
      try {
        const cats = await E.listCategories();
        fillCats(cats, settings.catId || '0');
        st.textContent = `连接成功，共 ${cats.length} 个生词本分类`;
        st.className = 'esh-status faint';
      } catch (e) {
        st.textContent = e.status === 401 ? 'Token 无效或已过期：到 my.eudic.net/OpenAPI/Authorization 重新获取'
                                          : '连接失败（' + (e.status || '网络') + '）：' + (e.message || e);
        st.className = 'esh-status warn';
      }
      renderDetail();
    }

    async function newCategory() {
      const name = prompt('新西语生词本名称：', '西语阅读器');
      if (!name) return;
      const st = $('esh-status');
      st.textContent = '创建中…';
      try {
        settings.token = $('esh-token').value.trim();
        const cat = await E.createCategory(name.trim());
        if (!cat) { st.textContent = '创建失败：服务端没返回新分类'; return; }
        settings.catId = cat.id; settings.catName = cat.name;
        fillCats([{ id: cat.id, name: cat.name }], cat.id);
        st.textContent = `已创建「${cat.name}」（ID ${cat.id}）`;
        st.className = 'esh-status faint';
      } catch (e) {
        st.textContent = '创建失败（' + (e.status || '网络') + '）：' + (e.message || e);
        st.className = 'esh-status warn';
      }
      renderDetail();
    }

    async function flushNow() {
      const st = $('esh-status');
      st.textContent = '补传中…'; st.className = 'esh-status faint';
      const r = await E.flush();
      if (r.sent) st.textContent = `本批已传 ${r.sent} 个词${r.message ? '（' + r.message + '）' : ''}` + (r.left ? `，还剩 ${r.left} 个` : '');
      else st.textContent = (r.why || '没传出去') + (E.errorText() ? '｜' + E.errorText() : '');
      st.className = 'esh-status ' + (r.sent ? 'faint' : 'warn');
      renderDetail();
    }

    function save() {
      const prev = settings.enabled;
      settings.enabled = $('esh-enabled').checked;
      settings.token = $('esh-token').value.trim();
      const sel = $('esh-cat');
      const opt = sel && sel.selectedOptions[0];
      settings.catId = sel ? String(sel.value) : '0';       // 字符串 ID，不做数字转换
      settings.catName = opt ? opt.textContent : '';
      if (settings.enabled && !settings.token) settings.enabled = false;
      writeState();
      closeModal();
      if (window.Reader && Reader.toast) {
        Reader.toast(prev !== settings.enabled
          ? (settings.enabled ? '已开启：查词自动加入西语助手生词本' : '已关闭西语助手同步')
          : '西语助手同步设置已保存');
      }
      if (settings.enabled) E.flushOnStart();
    }

    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.js-esh-open').forEach(b => { b.onclick = openModal; });
      const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
      bind('esh-close', closeModal);
      bind('esh-test', testAndLoadCats);
      bind('esh-newcat', newCategory);
      bind('esh-flush', flushNow);
      bind('esh-save', save);
      const m = $('esh-modal');
      if (m) m.onclick = e => { if (e.target === m) closeModal(); };
      E.load();
      E.flushOnStart();
    });
  })(Eshelper);
}

if (typeof module !== 'undefined' && module.exports) module.exports = Eshelper;   // 供 Node 离线回归
