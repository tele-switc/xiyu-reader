/* PDF 真实高亮注释模块
 *
 * 这里读写的是 PDF 文件里的 /Highlight 注释对象（不是应用内的覆盖层），
 * 所以标记完成后用 Adobe、Chrome/Edge、Sumatra 等任何 PDF 软件打开都能看到。
 *
 * 坐标一律用 PDF 用户空间（原点在页面左下角，y 向上），与 pdf.js 文本项的
 * item.transform 同一坐标系，落盘和显示都不需要再换算。
 */
const PdfAnnot = (() => {
  const lib = () => {
    if (typeof PDFLib !== 'undefined') return PDFLib;
    if (typeof globalThis !== 'undefined' && globalThis.PDFLib) return globalThis.PDFLib;
    throw new Error('未加载 pdf-lib');
  };

  const AUTHOR = '西语阅读器';        // 注释标题（/T）：其它软件里显示为作者
  const COLOR = [1, 0.91, 0.22];      // 黄色，和界面 --hl 接近
  const OPACITY = 0.45;               // /CA：Adobe/Chrome 都按它画半透明黄

  /* ---------- 纯几何小工具（可单独测） ---------- */

  // 一组矩形 → QuadPoints 数组；每个矩形 8 个数：左上、右上、左下、右下
  function rectsToQuadPoints(rects) {
    const qp = [];
    for (const r of rects) qp.push(r.x0, r.y1, r.x1, r.y1, r.x0, r.y0, r.x1, r.y0);
    return qp;
  }

  // QuadPoints → 矩形组（每 4 点一组），并按坐标取包围盒
  function quadPointsToRects(qp) {
    const out = [];
    for (let i = 0; i + 7 < qp.length; i += 8) {
      const xs = [qp[i], qp[i + 2], qp[i + 4], qp[i + 6]];
      const ys = [qp[i + 1], qp[i + 3], qp[i + 5], qp[i + 7]];
      out.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
    return out;
  }

  function unionRect(rects) {
    return {
      x0: Math.min(...rects.map(r => r.x0)),
      x1: Math.max(...rects.map(r => r.x1)),
      y0: Math.min(...rects.map(r => r.y0)),
      y1: Math.max(...rects.map(r => r.y1)),
    };
  }

  /* 命中判定：点词得到的词框与已有注释的某个 quad 矩形重叠到一定程度就算同一个标记。
   * 横向重叠按较窄框计算，纵向必须真正压住文字高度，避免把上下行的词误判。 */
  function overlapScore(a, b) {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ox <= 0 || oy <= 0) return 0;
    const w = Math.min(a.x1 - a.x0, b.x1 - b.x0);
    const h = Math.min(a.y1 - a.y0, b.y1 - b.y0);
    if (w <= 0 || h <= 0) return 0;
    return Math.min(1, ox / w) * 0.7 + Math.min(1, oy / h) * 0.3;
  }

  function cssColor(c) {
    if (!c || c.length < 3) return 'rgb(255,232,56)';
    const f = v => Math.round(Math.max(0, Math.min(1, v)) * 255);
    return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
  }

  // PDF 日期串：D:YYYYMMDDHHmmSS+HH'00'
  function pdfDate(d = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const ah = p(Math.floor(Math.abs(off) / 60)), am = p(Math.abs(off) % 60);
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${ah}'00'`;
  }

  /* ---------- 文档级句柄 ---------- */

  async function open(bytes) {
    const L = lib();
    const doc = await L.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    const ctx = doc.context;
    const pages = doc.getPages();
    const leaves = pages.map(p => p.node);

    // 一次遍历间接对象，建 页对象 → 引用 的映射（/P 需要页的间接引用）
    const pageRefs = new Map();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (obj instanceof L.PDFPageLeaf) pageRefs.set(obj, ref);
    }

    const hls = [];
    const PDFName = L.PDFName, PDFDict = L.PDFDict, PDFNumber = L.PDFNumber;
    const numAt = (arr, i) => { const n = arr.lookupMaybe(i, PDFNumber); return n ? n.asNumber() : NaN; };

    for (let pi = 0; pi < leaves.length; pi++) {
      const annots = leaves[pi].Annots && leaves[pi].Annots();
      if (!annots) continue;
      for (let j = 0; j < annots.size(); j++) {
        const entry = annots.get(j);
        const dict = ctx.lookupMaybe(entry, PDFDict);
        if (!dict) continue;
        const sub = dict.get(PDFName.of('Subtype'));
        if (!sub || typeof sub.encodedName !== 'string' || sub.encodedName !== '/Highlight') continue;
        let rects = [];
        const qp = dict.get(PDFName.of('QuadPoints'));
        if (qp && qp.constructor && qp.size) {
          const arr = [];
          for (let k = 0; k < qp.size(); k++) arr.push(numAt(qp, k));
          rects = quadPointsToRects(arr);
        }
        if (!rects.length) {
          const rc = dict.get(PDFName.of('Rect'));
          if (!rc || !rc.asRectangle) continue;
          const r = rc.asRectangle();
          rects = [{ x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height }];
        }
        let color = null, ca = OPACITY, word = '';
        const cObj = dict.get(PDFName.of('C'));
        if (cObj && cObj.asArray) color = cObj.asArray().map(x => x.asNumber && x.asNumber());
        const caObj = dict.get(PDFName.of('CA'));
        if (caObj && caObj.asNumber) ca = caObj.asNumber();
        const cont = dict.get(PDFName.of('Contents'));
        if (cont && cont.decodeText) { try { word = cont.decodeText(); } catch (e) { word = ''; } }
        hls.push({
          page: pi, ref: entry, rects,
          color: cssColor(color && color.length === 3 ? color : COLOR),
          opacity: (typeof ca === 'number' && ca > 0 && ca <= 1) ? ca : OPACITY,
          word,
          external: !(dict.get(PDFName.of('T')) && /西语阅读器/.test(safeDecode(dict.get(PDFName.of('T'))))),
        });
      }
    }

    function safeDecode(o) { try { return o.decodeText(); } catch (e) { return ''; } }

    const self = {
      get pageCount() { return leaves.length; },
      highlights: () => hls.slice(),
      forPage: pi => hls.filter(h => h.page === pi),

      /* 找出与词框重叠最多的已有高亮（用于「再点一下取消」） */
      hit: (pi, rect) => {
        let best = null, bestScore = 0.5;   // 低于 0.5 视为没命中
        for (const h of self.forPage(pi)) {
          for (const r of h.rects) {
            const s = overlapScore(r, rect);
            if (s > bestScore) { bestScore = s; best = h; }
          }
        }
        return best;
      },

      /* 新增一条 /Highlight 注释（只在内存里改 doc，落盘由 commit() 负责） */
      add: (pi, rects, word) => {
        const L2 = lib();
        const pageRef = pageRefs.get(leaves[pi]);
        const qp = rectsToQuadPoints(rects);
        const u = unionRect(rects);
        const dict = ctx.obj({
          Type: 'Annot',
          Subtype: 'Highlight',
          Rect: [u.x0, u.y0, u.x1, u.y1],
          QuadPoints: qp,
          C: COLOR,
          CA: OPACITY,
          BM: L2.PDFName.of('Multiply'),
          F: 4,                                   // Print 标志：打印/导出也带高亮
          T: L2.PDFHexString.fromText(AUTHOR),
          Contents: L2.PDFHexString.fromText(word || ''),
          M: L2.PDFString.of(pdfDate()),
        });
        if (pageRef) dict.set(L2.PDFName.of('P'), pageRef);
        const ref = ctx.register(dict);
        leaves[pi].addAnnot(ref);
        const hl = { page: pi, ref, rects: rects.slice(), color: cssColor(COLOR), opacity: OPACITY, word: word || '', external: false };
        hls.push(hl);
        return hl;
      },

      remove: hl => {
        const annots = leaves[hl.page].Annots && leaves[hl.page].Annots();
        if (!annots) return;
        for (let j = annots.size() - 1; j >= 0; j--) {
          if (annots.get(j) === hl.ref) { annots.remove(j); break; }
        }
        ctx.delete(hl.ref);
        const i = hls.indexOf(hl);
        if (i >= 0) hls.splice(i, 1);
      },

      serialize: () => doc.save({
        useObjectStreams: false,        // 经典交叉引用表，老软件也认
        updateFieldAppearances: false,  // 不碰表单外观
        addDefaultPage: false,
      }),

      close: () => { try { ctx.clear && ctx.clear(); } catch (e) {} },
    };
    return self;
  }

  const api = { open, rectsToQuadPoints, quadPointsToRects, unionRect, overlapScore, cssColor, pdfDate, AUTHOR, COLOR, OPACITY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // 方便 Node 侧直接跑同一份代码做测试
  return api;
})();
