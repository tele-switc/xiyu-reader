/* 阅读器会话控制器：查词侧栏、书签、生词本、历史进度、搜索、进度保存 */
const Reader = (() => {
  let book = null;          // 书籍元数据
  let renderer = null;      // 当前渲染器
  let meta = null;          // {progress, bookmarks, exitPoints, vocab}
  let saveTimer = null, lastLoc = '';

  const $ = id => document.getElementById(id);
  const esc = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function toast(msg, ms = 2200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add('hidden'), ms);
  }

  /* ---------------- 打开书籍 ---------------- */
  async function open(bookMeta) {
    const mark = t => {
      try { const el = $('progress-label'); if (el) el.textContent = '⟨' + t + '⟩'; } catch (e) {}
      try { if (window.DB) DB.traceKV(t); } catch (e) {}
      try { if (window.Neutralino && Neutralino.debug) Neutralino.debug.log('[PDFP] ' + t); } catch (e) {}
    };
    mark('R0 open ' + (bookMeta && bookMeta.id));
    book = bookMeta;
    lastLoc = '';
    const got = await DB.getBook(book.id);
    mark('R1 getBook ok');
    meta = (await DB.getKV('meta:' + book.id)) || { progress: null, bookmarks: [], exitPoints: [], vocab: [] };
    mark('R2 getKV ok ' + JSON.stringify(meta).length + 'B');
    meta.bookmarks = meta.bookmarks || []; meta.exitPoints = meta.exitPoints || []; meta.vocab = meta.vocab || [];
    $('library-view').classList.add('hidden');
    $('reader-view').classList.remove('hidden');
    $('reader-title').textContent = book.title;
    const subTip = book.type === 'pdf' ? '单击词标黄（真实写入 PDF）· 双击查词' : '按同源/纯西语双轨掌握率标注';
    $('reader-sub').textContent = `${book.type.toUpperCase()} · ${PROFILE.vocabText()} · ${subTip}`;
    $('reader-pane').innerHTML = '';
    $('reader-pane').className = 'reader-pane';
    document.querySelector('[data-tab="toc"]').classList.add('hidden');
    $('tab-toc').innerHTML = '';
    $('dict-content').innerHTML = '';
    $('dict-empty').classList.remove('hidden');

    if (book.type === 'epub') renderer = EpubReader.create(book);
    else if (book.type === 'pdf') renderer = PdfReader.create(book);
    else renderer = ReflowReader.create(book);

    renderer.onProgress = (p, label) => {
      $('progress-fill').style.width = (p * 100).toFixed(1) + '%';
      $('progress-label').textContent = label || Math.round(p * 100) + '%';
    };
    try {
      const mark = t => { const el = $('progress-label'); if (el) el.textContent = '⟨' + t + '⟩'; };
      mark('P1 读元数据');
      await renderer.open($('reader-pane'), meta.progress ? meta.progress.loc : null);
      mark('P9 打开完成');
    } catch (e) {
      const el = $('progress-label'); if (el) el.textContent = '⟨PERR ' + (e.message || e).slice(0, 50) + '⟩';
      console.error(e);
      toast('打开失败：' + (e.message || e));
      closeToLibrary(true);
      return;
    }
    renderBookmarks(); renderVocab(); renderHistory();
    startAutoSave();
    bindGlobalEvents();
  }

  /* ---------------- 进度保存 / 退出点 ---------------- */
  function startAutoSave() {
    clearInterval(saveTimer);
    saveTimer = setInterval(() => persist(false), 20000);
  }
  function getLocationSafe() {
    try { return renderer.getLocation(); } catch (e) { return null; }
  }
  function persist(isExit) {
    if (!renderer || !book) return;
    const loc = getLocationSafe();
    if (!loc || !loc.loc) return;
    meta.progress = { ...loc, ts: Date.now() };
    if (loc.loc !== lastLoc || isExit) {
      if (isExit) {
        const pts = meta.exitPoints || (meta.exitPoints = []);
        if (!pts.length || pts[0].loc !== loc.loc) {
          pts.unshift({ loc: loc.loc, excerpt: loc.excerpt || '', label: loc.label || '', percent: loc.percent || 0, ts: Date.now() });
          if (pts.length > 30) pts.length = 30;
        }
      }
      lastLoc = loc.loc;
    }
    DB.setKV('meta:' + book.id, meta);
    DB.putBook({ ...book, lastRead: Date.now(), percent: loc.percent || 0 });
  }
  window.addEventListener('pagehide', () => persist(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) persist(true); });

  async function closeToLibrary(silent) {
    persist(true);
    clearInterval(saveTimer);
    if (renderer) { try { renderer.destroy(); } catch (e) {} renderer = null; }
    book = null; meta = null;
    $('reader-view').classList.add('hidden');
    $('library-view').classList.remove('hidden');
    hideSearch();
    if (!silent) App.refreshLibrary();
  }

  /* ---------------- 生词包裹 / 取词工具 ---------------- */
  const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
  function wrapHardWords(root) {
    const D = root.ownerDocument || document;
    const walker = D.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || p.classList && p.classList.contains('hw')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let count = 0;
    for (const node of nodes) {
      const text = node.nodeValue;
      WORD_RE.lastIndex = 0;
      if (!WORD_RE.test(text)) continue;
      WORD_RE.lastIndex = 0;
      const frag = D.createDocumentFragment();
      let last = 0, m;
      while ((m = WORD_RE.exec(text))) {
        const w = m[0];
        if (m.index > last) frag.appendChild(D.createTextNode(text.slice(last, m.index)));
        if (PROFILE.isHard(w)) {
          const s = D.createElement('span');
          s.className = 'hw';
          s.textContent = w;
          frag.appendChild(s);
          count++;
        } else {
          frag.appendChild(D.createTextNode(w));
        }
        last = m.index + w.length;
      }
      if (last < text.length) frag.appendChild(D.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
    return count;
  }

  function wordAtPoint(doc, x, y) {
    let node = null, offset = 0;
    if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer; offset = r.startOffset;
    } else if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode; offset = p.offset;
    }
    if (!node || node.nodeType !== 3) return null;
    const text = node.nodeValue;
    let s = offset, e = offset;
    const isW = ch => /[\p{L}\p{M}'’-]/u.test(ch);
    while (s > 0 && isW(text[s - 1])) s--;
    while (e < text.length && isW(text[e])) e++;
    if (e <= s) return null;
    return text.slice(s, e).replace(/^['’-]+|['’-]+$/g, '');
  }

  /* ---------------- 查词与侧栏 ---------------- */
  function setTab(name) {
    document.querySelectorAll('.side-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.side-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  async function showEntry(rawWord) {
    const w = (rawWord || '').trim();
    if (!w) return;
    setTab('dict');
    $('dict-empty').classList.add('hidden');
    const box = $('dict-content');
    const lw = w.toLowerCase();
    const single = !/\s/.test(lw) && /^[\p{L}\p{M}]+$/u.test(lw);
    const rank = single ? DATA.rankOf(lw) : 0;
    const pk = single ? PROFILE.predictKnown(lw) : null;
    const chipTxt = !single ? '短语' : pk === null ? '低频词'
      : pk >= PROFILE.cutoff() ? `预测认识 ${Math.round(pk * 100)}%` : `预测不认识 ${Math.round((1 - pk) * 100)}%`;
    box.innerHTML = `
      <div class="entry-head">
        <div><div class="entry-word">${esc(w)}</div>
        <div class="entry-meta">${single ? (rank ? `词频排名 ≈ ${rank.toLocaleString()}${DATA.isCognate(lw) ? ' · 英西同源词' : ' · 纯西语词'}` : '低频词 / 未收录词频表') : '词组 / 短语'}</div></div>
        <span class="rank-chip">${chipTxt}</span>
      </div>
      <div class="entry-section"><div class="entry-label">中文释义</div>
        <div class="entry-zh" id="e-zh"><span class="loading-dot">查询中…</span></div></div>
      <div class="entry-section"><div class="entry-label">ENGLISH</div>
        <div class="entry-en" id="e-en"><span class="loading-dot">querying…</span></div></div>
      <div class="entry-section" id="e-pos-sec"><div class="entry-label">词性 · 变位</div><div id="e-pos"></div></div>
      <div class="entry-section"><div class="entry-label">例句 EJEMPLOS</div><div id="e-ex"></div></div>
      <div class="entry-actions">
        <button class="btn small" id="e-addvocab">☆ 加入生词本</button>
        ${PROFILE.p.blind.includes(lw) ? '<button class="btn small" id="e-known">✓ 我其实会（移出盲点）</button>' : ''}
        <span class="sync-chip" id="e-sync"></span>
      </div>
      <div class="entry-links">
        <a target="_blank" rel="noopener" href="https://www.wordreference.com/es/translation.asp?tranword=${encodeURIComponent(w)}">WordReference</a>
        <a target="_blank" rel="noopener" href="https://www.spanishdict.com/translate/${encodeURIComponent(w)}">SpanishDict</a>
        <a target="_blank" rel="noopener" href="https://dle.rae.es/${encodeURIComponent(w)}">RAE</a>
      </div>`;
    const zhEl = $('e-zh'), enEl = $('e-en'), exEl = $('e-ex');
    const addBtn = $('e-addvocab'), knownBtn = $('e-known');
    let resolved = null;
    if (addBtn) addBtn.onclick = () => addVocab(lw, resolved);
    if (knownBtn) knownBtn.onclick = () => {
      PROFILE.removeBlind(lw);
      toast(`已将「${w}」移出盲点`);
      showEntry(w);
    };

    const entry = await DATA.lookup(w);
    resolved = entry;
    /* 西语助手云端生词本：开启同步后，查过的单词自动加进去 */
    const syncChip = $('e-sync');
    if (syncChip && single) {
      Eshelper.onLookup(lw).then(st => {
        if (!st) return;
        syncChip.classList.remove('warn');
        syncChip.textContent = st === 'synced' ? '✓ 西语助手' : '⏳ 待同步';
        syncChip.title = st === 'synced' ? '已自动同步到西语助手生词本' : '当前离线，联网后自动补传';
      }).catch(e => {
        syncChip.classList.add('warn');
        syncChip.textContent = e.queued ? '⚠ 排队待传' : '⚠ 同步失败';
        syncChip.title = (e.message || String(e)) + (e.status === 401 || e.status === 403 ? '（Token 无效，点顶栏 📗 修改）' : '');
      });
    }
    /* 词性 + 变位（离线引擎，仅单词） */
    if (single) {
      const a = CONJ.analyze(w);
      const posEl = $('e-pos');
      if (a.verb) {
        posEl.innerHTML = `<div class="pos-tag">${a.pos} · 原形 <b>${a.verb.inf}</b></div>` + CONJ.renderHTML(a.verb);
      } else {
        posEl.innerHTML = `<div class="pos-tag">${a.pos || '—'}</div>`;
      }
    } else {
      $('e-pos-sec').classList.add('hidden');
    }
    zhEl.innerHTML = entry.zh ? esc(entry.zh) + (entry.zhLive ? ' <span class="faint">⚡在线</span>' : '')
                              : '<span class="faint">未能获取中文释义（可能离线）</span>';
    enEl.innerHTML = entry.en ? esc(entry.en) + (entry.enLive ? ' <span class="faint">⚡online</span>' : '')
                              : '<span class="faint">unavailable</span>';
    /* 大词库：词性 + 英文释义（24.6 万条） */
    if (entry.big) {
      const b = entry.big;
      const g = b.g.map(x => esc(x)).join('；');
      enEl.innerHTML += `<div class="bigdict"><span class="pos-chip">${esc(b.p)}</span> ${g}</div>`;
    }
    let exHtml = '';
    if (entry.examples && entry.examples.length) {
      exHtml = entry.examples.map(([es, zh]) =>
        `<div class="entry-ex"><div class="ex-es">${esc(es)}</div><div class="ex-zh">${esc(zh)}</div></div>`).join('');
    } else if (single) {
      exHtml = '<div class="faint">暂无本地例句</div>';
    } else {
      exHtml = '<div class="faint">短语暂无例句</div>';
    }
    exEl.innerHTML = exHtml;
  }

  /* ---------------- 生词本 ---------------- */
  function addVocab(w, entry) {
    if (!meta.vocab.some(v => v.w === w)) {
      meta.vocab.unshift({ w, zh: entry && entry.zh || '', ts: Date.now() });
      PROFILE.addBlind([w]);
      DB.setKV('meta:' + book.id, meta);
      renderVocab();
      toast(`「${w}」已加入生词本`);
      Eshelper.onLookup(w).then(st => {
        if (st) toast(st === 'synced' ? `「${w}」也已同步到西语助手` : `「${w}」已排队，联网后同步到西语助手`);
      }).catch(() => {});
    } else toast('已在生词本中');
  }
  function renderVocab() {
    const el = $('tab-vocab');
    if (!meta || !meta.vocab.length) {
      el.innerHTML = '<div class="empty-note">查词后点「加入生词本」，<br>这里会帮你记住每一个生词。</div>';
      return;
    }
    el.innerHTML = meta.vocab.map((v, i) => `
      <div class="list-item" data-w="${esc(v.w)}">
        <div class="li-top"><span>${new Date(v.ts).toLocaleDateString('zh-CN')}</span>
        <button class="li-del" data-del="${i}">✕</button></div>
        <div class="li-text"><b>${esc(v.w)}</b>${v.zh ? ' · ' + esc(v.zh) : ''}</div>
      </div>`).join('');
    el.querySelectorAll('.list-item').forEach(it => {
      it.onclick = e => {
        if (e.target.dataset.del !== undefined) {
          meta.vocab.splice(+e.target.dataset.del, 1);
          DB.setKV('meta:' + book.id, meta);
          renderVocab();
          return;
        }
        showEntry(it.dataset.w);
      };
    });
  }

  /* ---------------- 书签 ---------------- */
  function addBookmark() {
    const loc = getLocationSafe();
    if (!loc) return;
    meta.bookmarks.unshift({ loc: loc.loc, excerpt: loc.excerpt || '', label: loc.label || '', percent: loc.percent || 0, ts: Date.now() });
    DB.setKV('meta:' + book.id, meta);
    renderBookmarks();
    toast('🔖 书签已添加');
  }
  function renderBookmarks() {
    const el = $('tab-marks');
    if (!meta || !meta.bookmarks.length) {
      el.innerHTML = '<div class="empty-note">还没有书签。<br>点击顶栏 🔖 在此处添加。</div>';
      return;
    }
    el.innerHTML = meta.bookmarks.map((b, i) => `
      <div class="list-item" data-i="${i}">
        <div class="li-top"><span>${esc(b.label || '')} · ${new Date(b.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        <button class="li-del" data-del="${i}">✕</button></div>
        <div class="li-text">${esc(b.excerpt || '（点击跳转）')}</div>
      </div>`).join('');
    el.querySelectorAll('.list-item').forEach(it => {
      it.onclick = e => {
        if (e.target.dataset.del !== undefined) {
          meta.bookmarks.splice(+e.target.dataset.del, 1);
          DB.setKV('meta:' + book.id, meta);
          renderBookmarks();
          return;
        }
        const b = meta.bookmarks[+it.dataset.i];
        renderer.goTo(b.loc);
      };
    });
  }

  /* ---------------- 历史进度（退出点） ---------------- */
  function renderHistory() {
    const el = $('tab-history');
    const pts = (meta && meta.exitPoints) || [];
    if (!pts.length) {
      el.innerHTML = '<div class="empty-note">退出阅读时会自动记录进度点，<br>之后可以随时回到任意一次退出位置。</div>';
      return;
    }
    el.innerHTML = '<div class="faint" style="margin-bottom:10px">点击任意记录回到当时的位置：</div>' +
      pts.map((p, i) => `
      <div class="list-item" data-i="${i}">
        <div class="li-top"><span>${i === 0 ? '最近一次' : ''} ${new Date(p.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${Math.round((p.percent || 0) * 100)}%</span>
        <button class="li-del" data-del="${i}">✕</button></div>
        <div class="li-text">${esc(p.excerpt || p.label || '（进度点）')}</div>
      </div>`).join('');
    el.querySelectorAll('.list-item').forEach(it => {
      it.onclick = e => {
        if (e.target.dataset.del !== undefined) {
          meta.exitPoints.splice(+e.target.dataset.del, 1);
          DB.setKV('meta:' + book.id, meta);
          renderHistory();
          return;
        }
        const p = meta.exitPoints[+it.dataset.i];
        renderer.goTo(p.loc);
        toast('已回到该进度点');
      };
    });
  }

  /* ---------------- 搜索 ---------------- */
  function hideSearch() { $('search-results').classList.add('hidden'); }
  async function doSearch() {
    const q = $('search-input').value.trim();
    if (!q || !renderer) return;
    const box = $('search-results');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="sr-head">搜索中…</div>';
    let results = [];
    try { results = await renderer.search(q); } catch (e) { console.error(e); }
    if (!results.length) { box.innerHTML = '<div class="sr-head">未找到「' + esc(q) + '」</div>'; return; }
    box.innerHTML = `<div class="sr-head">共 ${results.length} 处匹配${results.length >= 100 ? '（仅显示前 100）' : ''}</div>` +
      results.map((r, i) => `<div class="sr-item" data-i="${i}">
        <div class="sr-where">${esc(r.where)}</div><div>${esc(r.snippet)}</div></div>`).join('');
    box.querySelectorAll('.sr-item').forEach(it => {
      it.onclick = () => {
        const r = results[+it.dataset.i];
        hideSearch();
        renderer.goTo(r.loc, q);
      };
    });
  }

  /* ---------------- 全局事件绑定 ---------------- */
  let globalBound = false;
  function bindGlobalEvents() {
    if (globalBound) return;
    globalBound = true;
    $('btn-back').onclick = () => closeToLibrary();
    document.querySelectorAll('.side-tab').forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
    $('btn-bookmark').onclick = addBookmark;
    $('btn-theme').onclick = () => { const n = PROFILE.cycleTheme(); toast('主题：' + n); if (renderer && renderer.applyFont) renderer.applyFont(); };
    const zoomIn = () => { if (renderer && renderer.zoomIn) { renderer.zoomIn(); toast('PDF 缩放 ' + renderer.zoomLabel() + '（Ctrl+滚轮亦可）'); } };
    const zoomOut = () => { if (renderer && renderer.zoomOut) { renderer.zoomOut(); toast('PDF 缩放 ' + renderer.zoomLabel()); } };
    const fontUp = () => { const s = PROFILE.bumpFont(1); toast('正文字号 ' + s + 'px'); if (renderer && renderer.applyFont) renderer.applyFont(); };
    const fontDown = () => { const s = PROFILE.bumpFont(-1); toast('正文字号 ' + s + 'px'); if (renderer && renderer.applyFont) renderer.applyFont(); };
    const bf = $('btn-font');           // 旧版单按钮 A±：左键放大/右键缩小
    if (bf) {
      bf.onclick = () => { if (renderer && renderer.zoomIn) { zoomIn(); return; } fontUp(); };
      bf.oncontextmenu = e => { e.preventDefault(); if (renderer && renderer.zoomOut) zoomOut(); };
    }
    const bfu = $('btn-font-up');       // 新版双按钮
    if (bfu) bfu.onclick = () => { if (renderer && renderer.zoomIn) zoomIn(); else fontUp(); };
    const bfd = $('btn-font-down');
    if (bfd) bfd.onclick = () => { if (renderer && renderer.zoomOut) zoomOut(); else fontDown(); };
    $('btn-prev').onclick = () => renderer && renderer.prev();
    $('btn-next').onclick = () => renderer && renderer.next();
    $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    $('search-input').addEventListener('input', () => { if (!$('search-input').value.trim()) hideSearch(); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.search-box')) hideSearch();
    });
    $('progress-track').onclick = e => {
      const rect = e.currentTarget.getBoundingClientRect();
      const p = (e.clientX - rect.left) / rect.width;
      if (renderer && renderer.goToPercent) renderer.goToPercent(Math.min(1, Math.max(0, p)));
    };
    // 选中文本自动查词
    let selTimer = null;
    document.addEventListener('selectionchange', () => {
      clearTimeout(selTimer);
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const txt = sel.toString().trim();
      if (!txt || txt.length > 60 || !/[\p{L}]/u.test(txt)) return;
      const pane = $('reader-pane');
      if (!sel.anchorNode || !pane.contains(sel.anchorNode.parentNode instanceof Element ? sel.anchorNode.parentNode : sel.anchorNode)) return;
      selTimer = setTimeout(() => showEntry(txt.replace(/\s+/g, ' ')), 260);
    });
    document.addEventListener('keydown', e => {
      if ($('reader-view').classList.contains('hidden')) return;
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') renderer && renderer.next();
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') renderer && renderer.prev();
    });
  }

  window.SR_DEBUG = { get renderer() { return renderer; }, get meta() { return meta; }, get book() { return book; } };
  return { open, closeToLibrary, showEntry, wordAtPoint, wrapHardWords, toast, setTab, bindGlobalEvents };
})();
