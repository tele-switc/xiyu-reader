/* PDF 渲染器（pdf.js）：画布渲染 + 自选文本层 + 真实高亮注释（写回 PDF 文件）
 *
 * 交互约定：
 *   单击一个词 = 在 PDF 里加/去一条 /Highlight 注释（别的 PDF 软件也看得到）
 *   双击一个词 = 查词
 *   选中一段话 = 查词（沿用 reader.js 的 selectionchange）
 * 打开时不再按词汇量自动铺黄色，页面上的黄色永远来自文件里真实存在的注释。 */
const PdfReader = (() => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  const HL_DY0 = -0.22;   // 词框下沿相对基线（PDF 用户空间，单位=字号）
  const HL_DY1 = 0.78;    // 词框上沿相对基线
  const CLICK_DELAY = 300;   // 单击判定窗口，必须小于系统双击间隔才不会和双击抢

  function create(bookMeta) {
    let pdf = null, wrap = null, pages = [], scale = 1, curPage = 1, io = null, scrollTimer = null;
    const rendered = new Set();
    const textCache = {};
    const self = { onProgress: null };
    const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;

    let annots = null;        // PdfAnnot 句柄：真实注释的内存视图
    let filePath = null;      // 这本书在磁盘上的 PDF 路径
    let origBytes = null;     // 打开时读到的原始字节（无磁盘路径时用于另存副本）
    let dirty = false;        // 有改动尚未成功落盘
    let saveChain = Promise.resolve();   // 落盘串行队列，避免并发写同一个文件
    let firstWriteNotice = false;
    let pendingClick = null;  // {timer, hit, toggled}
    let lastToggle = null;    // {hit, hl, kind, at}：最近一次单击做了什么，供慢双击撤回

    self.open = async (pane, savedLoc) => {
      const mark = t => {
        try {
          const el = document.getElementById('progress-label');
          if (el) el.textContent = '⟨' + t + '⟩';
        } catch (e) {}
        try { if (window.DB) DB.traceKV(t); } catch (e) {}
      try { if (window.Neutralino && Neutralino.debug) Neutralino.debug.log(t); } catch (e) {}
        try { console.log('[PDFP]', t); } catch (e) {}
      };
      mark('P2 取文件字节');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
      let loaded;
      try {
        loaded = await PdfStore.loadBook(bookMeta);   // 磁盘原文件优先，书库缓存兜底
      } catch (e) {
        const blob = await DB.getFile(bookMeta.id);
        loaded = { bytes: new Uint8Array(await blob.arrayBuffer()), path: null, source: 'cache' };
      }
      filePath = loaded.path;
      const buf = loaded.bytes;
      origBytes = buf;
      mark('P3 解析PDF文档 ' + Math.round(buf.byteLength / 1048576) + 'MB');
      // annotationMode=DISABLE：注释一律由我们按文件里的 QuadPoints 自己画，避免和 pdf.js 的注释层重复
      pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(buf),
        annotationMode: (window.pdfjsLib && pdfjsLib.AnnotationMode && pdfjsLib.AnnotationMode.DISABLE) || 0,
      }).promise;
      mark('P3.5 索引已有高亮注释');
      try {
        annots = await PdfAnnot.open(buf);
      } catch (e) {
        annots = null;                       // 加密或结构异常的 PDF：只读，不能加高亮
        console.warn('[PDF] 注释索引失败', e);
      }
      mark('P4 取第1页/共' + pdf.numPages + '页');
      wrap = document.createElement('div');
      wrap.className = 'pdf-wrap';
      pane.appendChild(wrap);
      bindWrapEvents();

      const avail = pane.clientWidth - 44;
      // 懒加载：只取第 1 页拿典型尺寸建占位，其余页在渲染时才 getPage（大 PDF 不再卡顿）
      pages = [];
      const first = await pdf.getPage(1);
      const fvp = first.getViewport({ scale: 1 });
      pages.push({ page: first, w: fvp.width, h: fvp.height });
      for (let i = 2; i <= pdf.numPages; i++) {
        pages.push({ page: null, w: fvp.width, h: fvp.height }); // 占位,渲染时补真尺寸
      }
      scale = Math.min(2.2, avail / fvp.width);

      // 占位页批量插入（几百页逐个 appendChild 会反复触发 reflow,卡死 UI）
      const frag = document.createDocumentFragment();
      for (let i = 0; i < pages.length; i++) {
        const el = document.createElement('div');
        el.className = 'pdf-page';
        el.dataset.page = i + 1;
        el.style.width = pages[i].w * scale + 'px';
        el.style.height = pages[i].h * scale + 'px';
        el.innerHTML = '<div class="pdf-page-loading">第 ' + (i + 1) + ' 页…</div>';
        frag.appendChild(el);
      }
      wrap.appendChild(frag);
      mark('P5 建观察器/定位');
      io = new IntersectionObserver(entries => {
        for (const en of entries) if (en.isIntersecting) renderPage(+en.target.dataset.page);
      }, { root: wrap, rootMargin: '900px 0px' });
      wrap.querySelectorAll('.pdf-page').forEach(el => io.observe(el));

      // 滚动定位:二分查找当前页(offsetTop 读取会强制 reflow,线性遍历几百页必卡)
      wrap.addEventListener('scroll', () => {
        if (scrollTimer) return;
        scrollTimer = setTimeout(() => {
          scrollTimer = null;
          const mid = wrap.scrollTop + wrap.clientHeight * 0.35;
          let lo = 0, hi = wrap.children.length - 1, best = 1;
          while (lo <= hi) {
            const midIdx = (lo + hi) >> 1;
            if (wrap.children[midIdx].offsetTop <= mid) { best = midIdx + 1; lo = midIdx + 1; }
            else hi = midIdx - 1;
          }
          if (best !== curPage) {
            curPage = best;
            reportProgress();
          }
        }, 120);
      }, { passive: true });

      // 单击 = 切换真实高亮；双击 = 查词（单击动作延后，避免和双击抢）
      wrap.addEventListener('click', onWrapClick);
      wrap.addEventListener('dblclick', onWrapDblClick);

      if (savedLoc && savedLoc.startsWith('page:')) curPage = Math.min(pdf.numPages, Math.max(1, parseInt(savedLoc.slice(5), 10) || 1));
      reportProgress();
      mark('P6 渲染第' + curPage + '页');
      renderPage(curPage);
      requestAnimationFrame(() => {
        const el = wrap.children[curPage - 1];
        if (el) wrap.scrollTop = Math.max(0, el.offsetTop - 12);
      });
    };

    function reportProgress() {
      if (self.onProgress && pdf) self.onProgress(curPage / pdf.numPages, `${curPage} / ${pdf.numPages} 页`);
    }

    async function getPageText(n) {
      if (textCache[n]) return textCache[n];
      const slot = pages[n - 1];
      if (!slot) return '';
      // 懒加载后未渲染的页 page 为 null；搜索全册时必须先补取页对象，否则整页被 catch 静默跳过
      if (!slot.page) slot.page = await pdf.getPage(n);
      const tc = await slot.page.getTextContent();
      const t = tc.items.map(it => it.str).join(' ').replace(/\s+/g, ' ');
      textCache[n] = t;
      return t;
    }

    async function renderPage(n) {
      if (rendered.has(n) || !pages[n - 1]) return;
      const slot = pages[n - 1];
      // 懒加载：页对象未取时才 getPage,并用真实尺寸校正占位
      if (!slot.page) {
        slot.page = await pdf.getPage(n);
        const vp = slot.page.getViewport({ scale: 1 });
        if (Math.abs(vp.width - slot.w) > 1 || Math.abs(vp.height - slot.h) > 1) {
          slot.w = vp.width; slot.h = vp.height;
          const el = wrap.children[n - 1];
          el.style.width = slot.w * scale + 'px';
          el.style.height = slot.h * scale + 'px';
        }
      }
      rendered.add(n);
      const { page } = slot;
      const el = wrap.children[n - 1];
      el.innerHTML = '';
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: scale * dpr });
      const vpCss = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = vpCss.width + 'px'; canvas.style.height = vpCss.height + 'px';
      el.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

      const hlLayer = document.createElement('div');
      hlLayer.className = 'pdf-hl-layer';
      el.appendChild(hlLayer);
      const tl = document.createElement('div');
      tl.className = 'pdf-textlayer';
      el.appendChild(tl);

      const tc = await page.getTextContent();
      const frag = document.createDocumentFragment();
      const hlFrag = document.createDocumentFragment();
      for (const item of tc.items) {
        if (!item.str || !item.str.trim()) continue;
        if (item.transform[1] !== 0 || item.transform[2] !== 0) continue;
        const x = item.transform[4], y = item.transform[5];
        const fontSize = item.height * scale;
        if (!fontSize || fontSize < 2) continue;
        const [vx, vy] = vpCss.convertToViewportPoint(x, y);
        const span = document.createElement('span');
        span.textContent = item.str;
        span.style.left = vx + 'px';
        span.style.top = (vy - fontSize * 0.86) + 'px';
        span.style.fontSize = fontSize + 'px';
        // 记下这一行文字在 PDF 用户空间里的位置，点词时按字符比例换算词框
        span._it = { page: n - 1, x, y, w: item.width, h: item.height, str: item.str };
        frag.appendChild(span);
      }
      // 黄色只来自文件里真实存在的 /Highlight 注释（含其它软件加的），打开时不再按词汇量自动铺
      if (annots) for (const hl of annots.forPage(n - 1)) drawHl(hlFrag, vpCss, hl);
      tl.appendChild(frag);
      hlLayer.appendChild(hlFrag);
      // scaleX 校正：两遍法——先一次性读完所有宽度（一次布局），再统一写 transform，
      // 避免「读-写-读-写」交错导致每个 item 都强制同步 reflow（大页面几百次 reflow 会卡死 UI）
      const spans = tl.children;
      const targets = [];
      {
        let si = 0;
        for (const item of tc.items) {
          if (!item.str || !item.str.trim()) continue;
          if (item.transform[1] !== 0 || item.transform[2] !== 0) continue;
          const fontSize = item.height * scale;
          if (!fontSize || fontSize < 2) continue;
          const span = spans[si++];
          if (!span) break;
          targets.push([span, item.width * scale, span.offsetWidth]);
        }
      }
      for (const [span, targetW, w] of targets) {
        if (w > 0 && targetW > 0) span.style.transform = `scaleX(${targetW / w})`;
      }
      textCache[n] = tc.items.map(it => it.str).join(' ').replace(/\s+/g, ' ');
    }

    /* ---------- 真实高亮：绘制 / 命中 / 切换 / 落盘 ---------- */

    // PDF 用户空间矩形 → 页面内 CSS 盒子（convertToViewportPoint 已处理缩放）
    function hlRectToBox(vpCss, r) {
      const [ax, ay] = vpCss.convertToViewportPoint(r.x0, r.y1);
      const [bx, by] = vpCss.convertToViewportPoint(r.x1, r.y0);
      return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
    }

    function drawHl(parent, vpCss, hl) {
      for (const r of hl.rects) {
        const b = hlRectToBox(vpCss, r);
        if (!isFinite(b.left) || !isFinite(b.top) || b.width < 1 || b.height < 1) continue;
        const d = document.createElement('div');
        d.className = 'pdf-hl pdf-hl-real';
        d.dataset.word = hl.word || '';
        d.style.background = hl.color || 'rgb(255,232,56)';
        d.style.opacity = String(hl.opacity || 0.45);
        d.style.left = b.left + 'px';
        d.style.top = b.top + 'px';
        d.style.width = b.width + 'px';
        d.style.height = b.height + 'px';
        parent.appendChild(d);
      }
    }

    // 只重画真实高亮那一层，搜索标记（.pdf-hl-search）保留
    function refreshHlLayer(n) {
      const el = wrap && wrap.children[n - 1];
      if (!el) return;
      const layer = el.querySelector('.pdf-hl-layer');
      if (!layer) return;                       // 该页还没渲染，渲染时会画
      layer.querySelectorAll('.pdf-hl-real').forEach(x => x.remove());
      if (!annots || !pages[n - 1] || !pages[n - 1].page) return;
      const vpCss = pages[n - 1].page.getViewport({ scale });
      for (const hl of annots.forPage(n - 1)) drawHl(layer, vpCss, hl);
    }

    // 命中： caret 落在文本层的哪个词上 → 词 + 该词的 PDF 用户空间矩形
    function hitAt(cx, cy) {
      let node = null, offset = 0;
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(cx, cy);
        if (!r) return null;
        node = r.startContainer; offset = r.startOffset;
      } else if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(cx, cy);
        if (!p) return null;
        node = p.offsetNode; offset = p.offset;
      }
      if (!node || node.nodeType !== 3) return null;
      const span = node.parentElement;
      if (!span || !span._it) return null;
      const it = span._it, text = node.nodeValue;
      const isW = ch => /[\p{L}\p{M}'’-]/u.test(ch);
      let s = Math.max(0, Math.min(offset, text.length)), e = s;
      while (s > 0 && isW(text[s - 1])) s--;
      while (e < text.length && isW(text[e])) e++;
      if (e <= s) return null;
      const raw = text.slice(s, e);
      const word = raw.replace(/^['’-]+|['’-]+$/g, '');
      if (!word) return null;
      const lead = raw.length - raw.replace(/^['’-]+/, '').length;
      const s2 = s + lead, e2 = s2 + word.length;
      const total = it.str.length || 1;
      const rect = {
        x0: it.x + (s2 / total) * it.w,
        x1: it.x + (e2 / total) * it.w,
        y0: it.y + HL_DY0 * it.h,
        y1: it.y + HL_DY1 * it.h,
      };
      return { page: it.page, word, rect };
    }

    /* 单击词 = 切换高亮：文件里已有压在这个词上的注释就删掉，否则新增一条 */
    async function toggleHighlight(hit) {
      if (!annots) { Reader.toast('这份 PDF 读不出注释结构（可能已加密），无法写高亮', 4000); return; }
      const existing = annots.hit(hit.page, hit.rect);
      let created = null;
      if (existing) annots.remove(existing);
      else created = annots.add(hit.page, [hit.rect], hit.word);
      lastToggle = { hit, hl: created, kind: existing ? 'remove' : 'add', at: Date.now() };
      dirty = true;
      refreshHlLayer(hit.page + 1);
      scheduleSave();
    }

    function failSave(msg) {
      dirty = true;                       // 下次点击会连带把这次的改动一起再写一遍
      Reader.toast(msg, 5200);
      console.warn('[PDF]', msg);
    }

    async function doSave() {
      if (!annots || !dirty) return;
      let path = filePath;
      if (!path) {
        try {
          path = await PdfStore.ensureTarget(bookMeta, origBytes);
        } catch (e) {
          failSave('没能定位到磁盘上的原文件：' + (e.message || e));
          return;
        }
        if (!path) { Reader.toast('没有指认原文件，这次高亮先留在窗口里，下次点击会再问你', 4000); return; }
      }
      let bytes;
      try { bytes = await annots.serialize(); } catch (e) { failSave('生成 PDF 失败：' + (e.message || e)); return; }
      const r = await PdfStore.commit(bookMeta, path, bytes);
      if (!r.ok) { failSave('高亮未写入 PDF：' + r.error + '（原文件没动，改动仍在本机内存里）'); return; }
      dirty = false;
      filePath = path;
      bookMeta.pdfPath = path;
      if (!firstWriteNotice) {
        firstWriteNotice = true;
        Reader.toast('高亮已写进 PDF 本体，其它 PDF 软件打开同一份文件就能看到' +
          (r.backup ? '（原文件已备份为 ' + Native.baseName(r.backup) + '）' : ''), 4600);
      }
    }

    // 落盘串行化：连点多个词时排队写，绝不并发覆盖同一个文件
    function scheduleSave() {
      saveChain = saveChain.then(doSave).catch(e => console.warn('[PDF] 落盘队列异常', e));
    }

    /* ---------- 点击 / 双击 ---------- */

    function clearPendingClick() {
      if (pendingClick && pendingClick.timer) clearTimeout(pendingClick.timer);
      pendingClick = null;
    }

    // 两次点击落在同一个词上才算「双击的前后两击」，否则是用户在连续标不同的词
    function sameWord(a, b) {
      if (!a || !b || a.page !== b.page || a.word !== b.word) return false;
      return Math.abs(a.rect.x0 - b.rect.x0) < 1.5 && Math.abs(a.rect.x1 - b.rect.x1) < 1.5;
    }

    function onWrapClick(e) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.detail > 1) return;                       // 双击的后续点击由 dblclick 处理
      const hit = hitAt(e.clientX, e.clientY);
      if (!hit) return;
      const prev = pendingClick;
      pendingClick = null;
      if (prev && prev.timer) {
        clearTimeout(prev.timer);
        // 上一击还压在判定窗口里，而这一击点的是别的词 → 把上一击补上，不吞掉
        if (!sameWord(prev.hit, hit)) toggleHighlight(prev.hit);
      }
      const st = { hit, timer: null, toggled: false };
      st.timer = setTimeout(() => { st.timer = null; st.toggled = true; toggleHighlight(hit); }, CLICK_DELAY);
      pendingClick = st;
    }

    function onWrapDblClick(e) {
      const st = pendingClick;
      pendingClick = null;
      const hit = hitAt(e.clientX, e.clientY);
      if (st && st.timer) clearTimeout(st.timer);           // 判定窗口内完成双击：本不该标黄
      if (hit) undoRecentToggle(hit, CLICK_DELAY + 600);    // 手慢误标了：按时间窗撤回
      const w = Reader.wordAtPoint(document, e.clientX, e.clientY) || (hit && hit.word);
      if (w) Reader.showEntry(w);
    }

    /* 只撤回「刚刚因为单击加上去」的高亮；如果上一次动作是删高亮，绝不能反向加回来。
     * 按时间窗 + 同一个词判断，不依赖浏览器派发 detail 事件的顺序。 */
    function undoRecentToggle(hit, windowMs) {
      if (!lastToggle || !annots) return false;
      if (Date.now() - lastToggle.at > windowMs) return false;
      if (lastToggle.kind !== 'add') return false;
      if (!sameWord(lastToggle.hit, hit)) return false;
      const stillThere = lastToggle.hl && annots.highlights().indexOf(lastToggle.hl) >= 0;
      const ex = stillThere ? lastToggle.hl : annots.hit(hit.page, hit.rect);
      if (!ex) return false;
      annots.remove(ex);
      dirty = true;
      refreshHlLayer(hit.page + 1);
      scheduleSave();
      lastToggle = null;
      return true;
    }

    async function markSearchOnPage(n, q) {
      await renderPage(n);
      const el = wrap.children[n - 1];
      const hl = el.querySelector('.pdf-hl-layer');
      if (!hl) return;
      const { page } = pages[n - 1];
      const vpCss = page.getViewport({ scale });
      const tc = await page.getTextContent();
      const lq = q.toLowerCase();
      for (const item of tc.items) {
        if (!item.str) continue;
        if (item.transform[1] !== 0 || item.transform[2] !== 0) continue;
        const li = item.str.toLowerCase();
        let idx = li.indexOf(lq);
        if (idx < 0) continue;
        const x = item.transform[4], y = item.transform[5];
        const fontSize = item.height * scale;
        if (!fontSize || fontSize < 2) continue;
        const total = item.str.length || 1;
        while (idx >= 0) {
          const x0 = x + (idx / total) * item.width;
          const x1 = x + ((idx + q.length) / total) * item.width;
          const [px0] = vpCss.convertToViewportPoint(x0, y);
          const [px1] = vpCss.convertToViewportPoint(x1, y);
          const [ , vy] = vpCss.convertToViewportPoint(x, y);
          const d = document.createElement('div');
          d.className = 'pdf-hl pdf-hl-search';
          d.style.background = '#f3c1c1';
          d.style.left = px0 + 'px';
          d.style.width = Math.max(2, px1 - px0) + 'px';
          d.style.top = (vy - fontSize * 0.82) + 'px';
          d.style.height = fontSize * 0.95 + 'px';
          hl.appendChild(d);
          idx = li.indexOf(lq, idx + q.length);
        }
      }
    }

    self.getLocation = () => {
      if (!pdf) return null;
      const excerpt = (textCache[curPage] || '').slice(0, 70);
      return { loc: 'page:' + curPage, percent: curPage / pdf.numPages, excerpt, label: `第 ${curPage} 页` };
    };

    /* ---------- 缩放 ---------- */
    const MIN_SCALE = 0.5, MAX_SCALE = 4, STEP = 1.2;
    async function applyScale(newScale, anchorRatio) {
      if (!pdf || !wrap) return;
      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(newScale * 100) / 100));
      if (clamped === scale) return;
      const keepTop = wrap.scrollTop;
      const keepLeft = wrap.scrollLeft;
      const anchorEl = wrap.children[curPage - 1];
      const anchorOffset = anchorEl ? anchorEl.offsetTop : 0;
      scale = clamped;
      // 重设占位尺寸并标记全部重渲染（textCache 存的是页面文本,与缩放无关,不清）
      rendered.clear();
      for (let i = 0; i < pages.length; i++) {
        const el = wrap.children[i];
        if (!el) continue;
        el.style.width = pages[i].w * scale + 'px';
        el.style.height = pages[i].h * scale + 'px';
        el.innerHTML = '<div class="pdf-page-loading">第 ' + (i + 1) + ' 页…</div>';
      }
      // 恢复滚动位置：锚定当前页顶部相对位置
      const ratio = anchorRatio != null ? anchorRatio : (anchorOffset ? keepTop / anchorOffset : 0);
      const el = wrap.children[curPage - 1];
      if (el) {
        wrap.scrollTop = el.offsetTop + el.offsetHeight * ratio - wrap.clientHeight * 0.35;
        wrap.scrollLeft = keepLeft;
      }
      await renderPage(curPage);
      // 预渲染可视区附近的页
      for (const n of [curPage - 1, curPage + 1]) {
        if (n >= 1 && n <= pages.length) renderPage(n);
      }
    }
    self.zoomIn = () => applyScale(scale * STEP);
    self.zoomOut = () => applyScale(scale / STEP);
    self.zoomReset = () => {
      if (!pdf || !wrap) return;
      const avail = wrap.parentElement.clientWidth - 44;
      applyScale(avail / Math.max(...pages.map(p => p.w)));
    };
    self.getScale = () => scale;
    self.zoomLabel = () => Math.round(scale * 100) + '%';
    // Ctrl + 滚轮缩放（以鼠标下方内容为锚点）
    // 注意：wrap 在 open() 里才创建，这些监听必须在 open() 之后绑定，不能在 create() 顶层（wrap=null 会抛异常）
    function bindWrapEvents() {
    wrap.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const anchor = (wrap.scrollTop + e.clientY - wrap.getBoundingClientRect().top) / Math.max(1, wrap.scrollHeight);
      const before = scale;
      const target = e.deltaY < 0 ? scale * STEP : scale / STEP;
      applyScale(target).then(() => {
        if (Math.abs(scale - before) > 0.01) {
          wrap.scrollTop = anchor * wrap.scrollHeight - (e.clientY - wrap.getBoundingClientRect().top);
        }
      });
    }, { passive: false });
    // 双指捏合（触屏/触摸板 gesture）
    let pinchStart = null;
    wrap.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        pinchStart = { dist: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), scale };
      }
    }, { passive: true });
    wrap.addEventListener('touchmove', e => {
      if (pinchStart && e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        applyScale(pinchStart.scale * (dist / pinchStart.dist));
      }
    }, { passive: false });
    wrap.addEventListener('touchend', () => { pinchStart = null; });
    }
    self.goTo = async (loc, q) => {
      if (typeof loc !== 'string' || !loc.startsWith('page:')) return;
      const n = Math.min(pdf.numPages, Math.max(1, parseInt(loc.slice(5), 10) || 1));
      curPage = n;
      await renderPage(n);
      const el = wrap.children[n - 1];
      if (el) wrap.scrollTop = Math.max(0, el.offsetTop - 12);
      if (q) markSearchOnPage(n, q);
      reportProgress();
    };
    self.goToPercent = p => self.goTo('page:' + Math.max(1, Math.round(p * pdf.numPages)));
    self.prev = () => self.goTo('page:' + (curPage - 1));
    self.next = () => self.goTo('page:' + (curPage + 1));

    self.search = async q => {
      const lq = q.toLowerCase();
      const results = [];
      for (let n = 1; n <= pdf.numPages && results.length < 100; n++) {
        let text;
        try { text = await getPageText(n); } catch (e) { continue; }
        const lt = text.toLowerCase();
        let idx = lt.indexOf(lq);
        while (idx >= 0 && results.length < 100) {
          const s = Math.max(0, idx - 28), e2 = Math.min(text.length, idx + q.length + 28);
          results.push({
            where: `第 ${n} 页`,
            snippet: (s > 0 ? '…' : '') + text.slice(s, e2) + (e2 < text.length ? '…' : ''),
            loc: 'page:' + n,
          });
          idx = lt.indexOf(lq, idx + q.length);
        }
      }
      return results;
    };

    self.destroy = () => {
      if (io) io.disconnect();
      clearPendingClick();
      // 退出前把队列里的落盘跑完，并把最新字节同步进书库缓存（无磁盘路径的书靠它保住高亮）
      saveChain = saveChain.then(async () => {
        if (annots && dirty) { try { await doSave(); } catch (e) { console.warn('[PDF] 退出落盘失败', e); } }
        if (annots && filePath) {
          try { await PdfStore.refreshCache(bookMeta, await annots.serialize()); } catch (e) {}
        }
      }).catch(() => {});
      try { pdf && pdf.destroy(); } catch (e) {}
    };
    return self;
  }
  return { create };
})();
