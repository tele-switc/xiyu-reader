/* 带高亮的 PDF 落盘：定位原文件 → 备份 → 校验 → 原子替换 → 失败回滚。
 * 原则：原文件在临时文件校验通过之前绝不碰；任何一步失败都能从 .bak 恢复。
 * 依赖 Native（磁盘）与 DB（书库缓存），可用 configure() 注入替身做离线测试。 */
const PdfStore = (() => {
  let _native = null, _db = null, _annot = null;
  function configure(d) { if (d.native) _native = d.native; if (d.db) _db = d.db; if (d.annot) _annot = d.annot; }
  const N = () => _native || (typeof Native !== 'undefined' ? Native : null);
  const DBX = () => _db || (typeof DB !== 'undefined' ? DB : null);
  const AN = () => _annot || (typeof PdfAnnot !== 'undefined' ? PdfAnnot : null);

  const BAK_SUFFIX = '.bak';       // 首次写入前的一次性备份
  const TMP_SUFFIX = '.xitutmp';   // 原子替换用的临时文件
  const PARSE_VERIFY_LIMIT = 25 * 1024 * 1024;   // 超过这个体积只做轻量校验，避免每次点击都全量解析

  function err(msg) { const e = new Error(msg); e.storeError = true; return e; }

  /* ---------- 读：磁盘优先，书库缓存兜底 ---------- */

  async function loadBook(book) {
    const n = N();
    if (book.pdfPath && n.isDesktop() && await n.exists(book.pdfPath)) {
      const bytes = await n.readBytes(book.pdfPath);
      return { bytes, path: book.pdfPath, source: 'disk' };
    }
    const db = DBX();
    const blob = await db.getFile(book.id);
    if (!blob) throw err('找不到这本书的文件数据');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, path: null, source: 'cache' };
  }

  /* ---------- 定位写入目标 ----------
   * 有路径就用；没有就先让用户指认原始 PDF（这样高亮写回原文件），
   * 指认不了（比如示例书）再退一步：另存一份副本作为该书的落盘目标。 */
  async function ensureTarget(book, fallbackBytes) {
    const n = N();
    if (!n.isDesktop()) throw err('需要桌面版才能把高亮写进 PDF 文件');

    if (book.pdfPath && await n.exists(book.pdfPath)) return book.pdfPath;

    const picked = await n.pickOpen({
      title: `「${book.title}」还没有关联到磁盘上的 PDF，请指认它的原文件（高亮会直接写回这个文件）`,
      name: 'PDF 文件', extensions: ['*.pdf'], multi: false,
    });
    if (picked && picked.length) {
      const p = picked[0];
      const bytes = await n.readBytes(p);
      if (book.size && Math.abs(bytes.length - book.size) > Math.max(4096, book.size * 0.05)) {
        const tip = await showConfirm(`这个文件的大小（${fmtKb(bytes.length)}）和书库记录的（${fmtKb(book.size)}）差得比较多，确定是同一本书吗？`);
        if (!tip) return '';
      }
      await setPath(book, p, bytes);
      return p;
    }

    // 没有原文件可指认：另存一份带高亮的副本
    const defName = (book.title || '西语阅读器').replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
    const savePath = await n.pickSave({
      title: '这本书没有磁盘原文件，选择把带高亮的版本保存到哪里',
      defaultPath: defName, name: 'PDF 文件', extensions: ['*.pdf'],
    });
    if (!savePath) return '';
    if (fallbackBytes) await n.writeBytes(savePath, fallbackBytes);
    await setPath(book, savePath, fallbackBytes);
    return savePath;
  }

  async function setPath(book, path, bytes) {
    book.pdfPath = path;
    const db = DBX();
    if (db) await db.putBook({ ...book, pdfPath: path, size: bytes ? bytes.length : book.size });
  }

  async function showConfirm(msg) {
    const n = N();
    try {
      if (window.Neutralino && Neutralino.os && Neutralino.os.showMessageBox) {
        const r = await Neutralino.os.showMessageBox('西语阅读器', msg, 'YES_NO');
        return r === 'Yes';
      }
    } catch (e) {}
    return confirm(msg);
  }

  /* ---------- 写：备份 + 校验 + 原子替换 ---------- */

  function checkStructure(bytes) {
    const head = String.fromCharCode(...bytes.subarray(0, 5));
    if (head !== '%PDF-') throw err('校验失败：文件头不是 %PDF-');
    return true;
  }

  async function verifyBytes(bytes) {
    checkStructure(bytes);
    if (bytes.length <= PARSE_VERIFY_LIMIT) {
      // 完整解析一遍：能读通才认为可替换（等价于「别的软件能打开」）
      const h = await AN().open(bytes.slice(0));   // slice：避免把同一个 buffer 交出去
      if (!h || !h.pageCount) throw err('校验失败：解析不到页面');
      h.close && h.close();
      return 'parsed';
    }
    // 大文件：查尾部 %%EOF，省掉一次全量解析
    const tail = bytes.subarray(Math.max(0, bytes.length - 2048));
    let s = ''; for (let i = 0; i < tail.length; i++) s += String.fromCharCode(tail[i]);
    if (s.lastIndexOf('%%EOF') < 0) throw err('校验失败：文件尾缺少 %%EOF');
    return 'light';
  }

  async function commit(book, path, bytes) {
    const n = N();
    const bak = path + BAK_SUFFIX, tmp = path + TMP_SUFFIX;
    let removedOriginal = false;

    // 1) 一次性备份（已存在就绝不覆盖，保住最早的原样）
    if (!(await n.exists(bak))) {
      if (!(await n.exists(path))) throw err('原文件已不存在：' + path);
      await n.copy(path, bak);
    }

    try {
      // 2) 先写临时文件并校验，此时原文件还没动
      await n.writeBytes(tmp, bytes);
      const back = await n.readBytes(tmp);
      if (back.length !== bytes.length) throw err(`校验失败：临时文件 ${back.length}B，应为 ${bytes.length}B`);
      const level = await verifyBytes(back);

      // 3) 替换（Windows 的 move 不覆盖已存在目标，先删后移）
      await n.remove(path);
      removedOriginal = true;
      await n.move(tmp, path);

      // 4) 收尾：确认落盘文件可读
      const fin = await n.readBytes(path);
      checkStructure(fin);
      if (fin.length !== bytes.length) throw err(`校验失败：落盘 ${fin.length}B，应为 ${bytes.length}B`);
      return { ok: true, backup: bak, verify: level };
    } catch (e) {
      try { if (await n.exists(tmp)) await n.remove(tmp); } catch (_) {}
      // 原文件若已被删除，立刻从备份恢复
      if (removedOriginal && !(await n.exists(path)) && await n.exists(bak)) {
        try { await n.copy(bak, path); } catch (_) {}
      }
      return { ok: false, error: e.message || String(e), backup: bak };
    }
  }

  /* ---------- 书库缓存（无磁盘路径的书靠它，有路径的退出时同步一次） ---------- */

  async function refreshCache(book, bytes) {
    const db = DBX();
    if (!db || !bytes) return;
    try { await db.putFile(book.id, new Blob([bytes])); } catch (e) { console.warn('[PdfStore] 缓存刷新失败', e); }
  }

  function fmtKb(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.round(b / 1024) + 'KB'; }

  const api = { configure, loadBook, ensureTarget, commit, verifyBytes, checkStructure, refreshCache, setPath, BAK_SUFFIX, TMP_SUFFIX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // 便于 Node 侧用同一份代码做离线测试
  return api;
})();
