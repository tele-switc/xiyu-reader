/* 原生能力桥：只在 Neutralino 桌面壳里才真正访问磁盘（window.NL_PORT 由原生进程注入）。
 * 浏览器里打开时全部抛 DESKTOP_ONLY，由调用方决定回退（例如只做应用内标记）。
 * 目的：高亮要写进真实 PDF 文件，就必须有磁盘读写与系统文件选择框。 */
const Native = (() => {
  function isDesktop() {
    return !!(window.NL_PORT && window.Neutralino &&
      window.Neutralino.filesystem && window.Neutralino.os);
  }

  let inited = false;
  function init() {
    if (!isDesktop() || inited) return;
    try { Neutralino.init(); inited = true; } catch (e) { console.warn('[Native] Neutralino.init 失败', e); }
  }
  init();

  const DESKTOP_ONLY = () => { const e = new Error('需要桌面版才能读写文件'); e.code = 'DESKTOP_ONLY'; return e; };

  /* ---------- 文件对话框 ---------- */

  // 选择若干已存在的文件，返回绝对路径数组
  async function pickOpen({ title = '选择文件', name = '文件', extensions = ['*.*'], multi = true } = {}) {
    init();
    if (!isDesktop()) throw DESKTOP_ONLY();
    const paths = await Neutralino.os.showOpenDialog(title, {
      multiSelections: !!multi,
      filters: [{ name, extensions }],
    });
    return paths || [];
  }

  // 选择要写入的位置，返回绝对路径（取消 → ''）
  async function pickSave({ title = '保存文件', defaultPath = '', name = '文件', extensions = ['*.*'] } = {}) {
    init();
    if (!isDesktop()) throw DESKTOP_ONLY();
    const p = await Neutralino.os.showSaveDialog(title, {
      filters: [{ name, extensions }],
      defaultPath,
    });
    return p || '';
  }

  /* ---------- 读写 ---------- */

  async function readBytes(path) {
    init();
    if (!isDesktop()) throw DESKTOP_ONLY();
    const buf = await Neutralino.filesystem.readBinaryFile(path);
    return new Uint8Array(buf);
  }

  async function writeBytes(path, bytes) {
    init();
    if (!isDesktop()) throw DESKTOP_ONLY();
    await Neutralino.filesystem.writeBinaryFile(path, bytes);
  }

  async function exists(path) {
    init();
    if (!isDesktop()) return false;
    try { await Neutralino.filesystem.getStats(path); return true; } catch (e) { return false; }
  }

  async function copy(src, dst) {
    init();
    if (!isDesktop()) throw DESKTOP_ONLY();
    await Neutralino.filesystem.copy(src, dst);
  }

  async function move(src, dst) {
    init();
    if (!isDesktop()) throw DESKTOP_ONLY();
    await Neutralino.filesystem.move(src, dst);
  }

  async function remove(path) {
    init();
    if (!isDesktop()) throw DESKTOP_ONLY();
    await Neutralino.filesystem.remove(path);
  }

  /* ---------- 路径字符串处理（不依赖原生） ---------- */

  const sep = p => (p.includes('\\') && !p.includes('/') ? '\\' : '/');
  function baseName(p) { const s = sep(p); const i = p.lastIndexOf(s); return i < 0 ? p : p.slice(i + 1); }
  function dirName(p) { const s = sep(p); const i = p.lastIndexOf(s); return i < 0 ? '' : p.slice(0, i); }
  function stem(p) { const b = baseName(p); const i = b.lastIndexOf('.'); return i < 0 ? b : b.slice(0, i); }
  function join(dir, name) { const s = dir && sep(dir); return s ? dir + s + name : name; }

  return { isDesktop, pickOpen, pickSave, readBytes, writeBytes, exists, copy, move, remove, baseName, dirName, stem, join };
})();
