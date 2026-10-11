/* 应用入口：书库、导入、测试引导 */
const App = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 拖拽导入：脚本加载即注册（不依赖 init 的 await 链），window 捕获阶段兜底
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('drag-hover'); });
  window.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', e => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('drag-hover'); });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drag-hover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length && typeof App !== 'undefined') {
      App.importDropped(e.dataTransfer.files);
    }
  });

  async function init() {
    try { await DATA.init(); } catch (e) { console.error('数据加载失败', e); }
    PROFILE.applyTheme();
    updateBadge();
    if (PROFILE.hasProfile()) {
      $('test-banner').classList.add('hidden');
    } else {
      // 首次使用：自动开始词汇测试（可跳过）
      setTimeout(() => {
        if (!PROFILE.hasProfile() && document.getElementById('test-modal').classList.contains('hidden')) {
          Test.start(() => { updateBadge(); $('test-banner').classList.add('hidden'); });
        }
      }, 500);
    }
    await ensureDemo();
    await refreshLibrary();

    $('btn-import').onclick = async () => {
      // 桌面版走系统文件选择框：这样能拿到真实磁盘路径，PDF 高亮才写得回原文件
      if (Native.isDesktop()) {
        try { await importViaNativeDialog(); }
        catch (e) { Reader.toast('导入失败：' + (e.message || e), 4000); }
        return;
      }
      $('file-input').click();
    };
    $('file-input').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
    $('btn-start-test').onclick = () => Test.start(() => { updateBadge(); $('test-banner').classList.add('hidden'); });
    $('btn-skip-test').onclick = () => {
      PROFILE.setTestResult({ vocab: 3500, blind: [], bands: null, ts: Date.now(), skipped: true });
      updateBadge(); $('test-banner').classList.add('hidden');
      Reader.toast('已使用默认水平（约 3500 词），可随时在「重测词汇」中修改');
    };
    $('btn-retest').onclick = () => Test.start(() => updateBadge());
  }

  function updateBadge() {
    const badge = $('level-badge');
    if (PROFILE.p.ts) {
      badge.textContent = PROFILE.p.vocab == null ? '词汇量 未测试（点「测词汇量」）' : `${PROFILE.vocabText()} · ${PROFILE.levelLabel(PROFILE.p.vocab)}`;
      badge.classList.remove('hidden');
      $('btn-retest').classList.remove('hidden');
    }
  }

  async function ensureDemo() {
    if (localStorage.getItem('sr-demo')) return;
    const demos = [
      ['demo/don-quijote.epub', 'epub', 'Don Quijote de la Mancha（前三章）', 'Miguel de Cervantes'],
      ['demo/ejemplo.pdf', 'pdf', '西班牙语示例短文', 'Lector Demo'],
      ['demo/ejemplo.mobi', 'mobi', 'Lectura de prueba（MOBI 示例）', 'Lector Demo'],
    ];
    for (const [file, type, title, author] of demos) {
      try {
        const buf = await (await fetch(file)).arrayBuffer();
        const id = 'demo-' + type;
        await DB.putBook({ id, title, author, type, size: buf.byteLength, addedAt: Date.now() });
        await DB.putFile(id, new Blob([buf]));
      } catch (e) { console.warn('demo load failed', e); }
    }
    localStorage.setItem('sr-demo', '1');
  }

  async function refreshLibrary() {
    const books = (await DB.listBooks()).sort((a, b) => (b.lastRead || b.addedAt) - (a.lastRead || a.addedAt));
    const grid = $('book-grid');
    if (!books.length) {
      grid.innerHTML = '<div class="empty-note" style="grid-column:1/-1">书库空空如也。<br>导入一本 PDF / EPUB / MOBI 开始阅读吧。</div>';
      return;
    }
    grid.innerHTML = books.map(b => `
      <div class="book-card" data-id="${esc(b.id)}">
        <button class="b-del" title="删除">✕</button>
        <div class="b-type">${esc(b.type)}</div>
        <h3>${esc(b.title)}</h3>
        <div class="b-author">${esc(b.author || '')}</div>
        <div class="b-progress"><i style="width:${Math.round((b.percent || 0) * 100)}%"></i></div>
        <div class="b-meta">
          <span>${b.percent ? '已读 ' + Math.round(b.percent * 100) + '%' : '未读'}</span>
          <span>${new Date(b.lastRead || b.addedAt).toLocaleDateString('zh-CN')}</span>
        </div>
      </div>`).join('');
    grid.querySelectorAll('.book-card').forEach(card => {
      card.onclick = e => {
        if (e.target.classList.contains('b-del')) return;
        openBook(card.dataset.id);
      };
      card.querySelector('.b-del').onclick = async e => {
        e.stopPropagation();
        if (confirm('从书库中删除这本书？（阅读记录一并删除）')) {
          await DB.delBook(card.dataset.id);
          refreshLibrary();
        }
      };
    });
  }

  /* 导入：桌面版走系统选择框（记住 PDF 磁盘路径），浏览器/拖拽用 File 对象（无路径，
     第一次点高亮时再由 PdfStore 让用户指认原文件）。 */
  async function importOne({ name, u8, path }) {
    const title = name.replace(/\.[^.]+$/, '');
    const ext = (name.match(/\.([^.]+)$/) || [])[1];
    if (!ext) throw new Error('文件没有扩展名：' + name);
    const low = ext.toLowerCase();
    const id = 'b' + Date.now() + Math.floor(Math.random() * 1e4);
    const buf = u8.buffer;
    if (low === 'epub') {
      const meta = await epubMeta(buf);
      await DB.putBook({ id, title: meta.title || title, author: meta.author || '', type: 'epub', size: u8.length, addedAt: Date.now() });
      await DB.putFile(id, new Blob([u8]));
      Reader.toast('已导入《' + (meta.title || title) + '》');
    } else if (low === 'pdf') {
      const book = { id, title, author: '', type: 'pdf', size: u8.length, addedAt: Date.now() };
      if (path) book.pdfPath = path;
      await DB.putBook(book);
      await DB.putFile(id, new Blob([u8]));            // 缓存副本：磁盘文件丢了还能读
      Reader.toast(path ? '已导入「' + title + '」（高亮将写回原文件）' : '已导入「' + title + '」');
    } else if (low === 'mobi') {
      let mobTitle = title;
      try {
        const p = MOBI.parse(buf);
        if (p.title) mobTitle = p.title;
      } catch (err) {
        Reader.toast('无法导入 ' + name + '：' + err.message, 5000);
        return;
      }
      await DB.putBook({ id, title: mobTitle, author: '', type: 'mobi', size: u8.length, addedAt: Date.now() });
      await DB.putFile(id, new Blob([u8]));
      Reader.toast('已导入《' + mobTitle + '》');
    } else if (low === 'txt') {
      await DB.putBook({ id, title, author: '', type: 'txt', size: u8.length, addedAt: Date.now() });
      await DB.putFile(id, new Blob([u8]));
      Reader.toast('已导入「' + title + '」');
    } else {
      throw new Error('不支持的格式：' + name + '（支持 PDF / EPUB / MOBI / TXT）');
    }
  }

  async function importFiles(files) {
    for (const f of files) {
      try {
        const u8 = new Uint8Array(await f.arrayBuffer());
        // 少数 webview 会给拖拽文件挂上 path，拿不到就走「第一次高亮时指认原文件」流程
        await importOne({ name: f.name, u8, path: f.path || null });
      } catch (e) {
        console.error(e);
        Reader.toast('导入失败：' + (e.message || e), 4000);
      }
    }
    await refreshLibrary();
  }

  async function importViaNativeDialog() {
    const paths = await Native.pickOpen({
      title: '导入书籍', name: '书籍', extensions: ['*.pdf', '*.epub', '*.mobi', '*.txt'], multi: true,
    });
    if (!paths.length) return;
    for (const p of paths) {
      try {
        const u8 = await Native.readBytes(p);
        await importOne({ name: Native.baseName(p), u8, path: p });
      } catch (e) {
        console.error(e);
        Reader.toast('导入失败：' + Native.baseName(p) + ' - ' + (e.message || e), 4500);
      }
    }
    await refreshLibrary();
  }

  async function epubMeta(buf) {
    try {
      const zip = await JSZip.loadAsync(buf);
      const cfile = zip.file('META-INF/container.xml');
      if (!cfile) return {};
      const c = await cfile.async('string');
      const m = /full-path="([^"]+)"/.exec(c);
      if (!m) return {};
      const opf = await zip.file(m[1]).async('string');
      const d = new DOMParser().parseFromString(opf, 'application/xml');
      const title = d.getElementsByTagName('dc:title')[0];
      const author = d.getElementsByTagName('dc:creator')[0];
      return { title: title && title.textContent.trim(), author: author && author.textContent.trim() };
    } catch (e) { return {}; }
  }

  async function openBook(id) {
    const meta = await DB.getBook(id);
    if (!meta) return;
    await Reader.open(meta);
  }

  function fillToc(toc, onGo) {
    const tab = document.querySelector('[data-tab="toc"]');
    tab.classList.remove('hidden');
    const el = $('tab-toc');
    const rows = [];
    const walk = (items, depth) => {
      for (const it of items) {
        rows.push({ label: (it.label || '').trim() || '(untitled)', href: it.href, depth });
        if (it.subitems && it.subitems.length) walk(it.subitems, depth + 1);
      }
    };
    walk(toc, 0);
    el.innerHTML = rows.map(r => `<div class="list-item" data-href="${esc(r.href)}" style="margin-left:${r.depth * 14}px">${esc(r.label)}</div>`).join('')
      || '<div class="empty-note">无目录</div>';
    el.querySelectorAll('.list-item').forEach(it => { it.onclick = () => onGo(it.dataset.href); });
  }

  document.addEventListener('DOMContentLoaded', init);
  return { refreshLibrary, fillToc, importDropped: files => importFiles(files) };
})();
