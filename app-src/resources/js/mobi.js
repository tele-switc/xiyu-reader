/* 精简 MOBI 解析器：支持无 DRM 的 PalmDOC/未压缩 MOBI，提取 HTML 正文 */
const MOBI = (() => {
  function latin1(u8, start, len) {
    let s = '';
    for (let i = start; i < start + len && i < u8.length; i++) {
      if (u8[i] === 0) break;
      s += String.fromCharCode(u8[i]);
    }
    return s;
  }

  function palmdoc(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i++];
      if (c === 0) { out.push(0); }
      else if (c <= 8) { for (let k = 0; k < c && i < n; k++) out.push(src[i++]); }
      else if (c <= 0x7f) { out.push(c); }
      else if (c <= 0xbf) {
        if (i >= n) break;
        const c2 = src[i++];
        const x = (c << 8) | c2;
        const dist = (x >>> 3) & 0x7ff, len = (x & 7) + 3;
        const L = out.length;
        for (let k = 0; k < len; k++) out.push(out[L - dist + k]);
      } else { out.push(32); out.push(c ^ 0x80); }
    }
    return new Uint8Array(out);
  }

  function parse(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    if (buf.byteLength < 100) throw new Error('文件过小，不是有效的 MOBI 文件');
    const pdbName = latin1(u8, 0, 32);
    const numRec = dv.getUint16(76);
    if (numRec < 2) throw new Error('不是有效的 MOBI 文件');
    const recs = [];
    for (let i = 0; i < numRec; i++) recs.push(dv.getUint32(78 + i * 8));
    const recEnd = i => (i + 1 < numRec ? recs[i + 1] : buf.byteLength);

    const r0 = recs[0];
    const compression = dv.getUint16(r0);
    const textLength = dv.getUint32(r0 + 4);
    const recCount = dv.getUint16(r0 + 8);
    const encryption = dv.getUint16(r0 + 12);
    if (encryption !== 0) throw new Error('该 MOBI 文件带有 DRM 加密，无法打开。请导入无 DRM 保护的 EPUB 或 PDF。');

    let encoding = 1252;
    if (latin1(u8, r0 + 16, 4) === 'MOBI') encoding = dv.getUint32(r0 + 28);

    if (compression === 17480) throw new Error('该 MOBI 使用 HUFF/CDIC 压缩，暂不支持。建议用 Calibre 转换为 EPUB 后导入。');
    if (compression !== 1 && compression !== 2) throw new Error('暂不支持的压缩格式（code ' + compression + '）');

    const parts = [];
    for (let i = 1; i <= recCount && i < numRec; i++) {
      const data = u8.subarray(recs[i], recEnd(i));
      parts.push(compression === 2 ? palmdoc(data) : data);
    }
    let total = 0;
    for (const p of parts) total += p.length;
    const all = new Uint8Array(Math.min(total, textLength));
    let off = 0;
    for (const p of parts) {
      const take = Math.min(p.length, all.length - off);
      if (take <= 0) break;
      all.set(p.subarray(0, take), off);
      off += take;
    }
    const text = new TextDecoder(encoding === 65001 ? 'utf-8' : 'windows-1252').decode(all);
    // 去掉末尾的非 HTML 标记块（FCIS/FLIS 等）
    let html = text;
    const fcis = html.indexOf('<fcis>'); if (fcis > 0) html = html.slice(0, fcis);
    const flis = html.indexOf('<flis>'); if (flis > 0) html = html.slice(0, flis);
    if (!/<[a-z]/i.test(html)) throw new Error('未能从该文件中提取出文本（可能是 KF8/AZW3 复合格式），请转换为 EPUB 后导入。');
    return { title: pdbName || null, html };
  }

  /* 清洗 HTML：只保留安全的结构标签 */
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const REMOVE = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'input', 'button', 'video', 'audio', 'img', 'svg'];
    for (const tag of REMOVE) for (const el of doc.querySelectorAll(tag)) el.remove();
    const KEEP = new Set(['P','BR','H1','H2','H3','H4','H5','H6','DIV','SPAN','B','I','U','EM','STRONG','BLOCKQUOTE','UL','OL','LI','HR','SMALL','SUP','SUB','TABLE','TR','TD','TH','THEAD','TBODY']);
    (function walk(node) {
      const kids = Array.from(node.childNodes);
      for (const k of kids) {
        if (k.nodeType === 1) {
          // 移除所有属性
          for (const a of Array.from(k.attributes)) k.removeAttribute(a.name);
          if (!KEEP.has(k.tagName)) {
            // 未知标签：保留子内容
            while (k.firstChild) node.insertBefore(k.firstChild, k);
            node.removeChild(k);
          } else {
            walk(k);
          }
        } else if (k.nodeType === 8) {
          node.removeChild(k);
        }
      }
    })(doc.body);
    return doc.body.innerHTML;
  }

  return { parse, sanitize };
})();
