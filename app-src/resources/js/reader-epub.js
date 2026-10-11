/* EPUB 渲染器（epub.js） */
const EpubReader = (() => {
  const THEMES = {
    light: { bg: '#fffdf8', ink: '#2d2a26', faint: '#8a8378' },
    sepia: { bg: '#f7ecd8', ink: '#433422', faint: '#8d7a5e' },
    dark: { bg: '#22252b', ink: '#e6e2d8', faint: '#9a968c' },
  };
  const HL = { light: ['#f7e8a4', '#d9b23c'], sepia: ['#efd489', '#c8a02f'], dark: ['#5a4d1e', '#8a742f'] };

  function create(bookMeta) {
    let ebook = null, rendition = null, container = null, toc = [];
    let pendingQ = null, ready = false, jumped = false;
    const self = { onProgress: null };

    function iframeCss() {
      const t = THEMES[PROFILE.s.theme] || THEMES.light;
      const [hl, hb] = HL[PROFILE.s.theme] || HL.light;
      return `
        html,body{background:${t.bg} !important;color:${t.ink} !important}
        body{font-family:Georgia,'Times New Roman',serif !important;
          font-size:${PROFILE.s.fontSize || 19}px !important;line-height:1.9 !important;
          padding:0 8px}
        a{color:inherit}
        .hw{background:${hl};border-bottom:1.5px solid ${hb};border-radius:2px;padding:0 1px;cursor:pointer}
        mark.find{background:#f3c1c1;border-radius:2px}
        img{max-width:100%}`;
    }

    function decorate(contents) {
      const doc = contents.document;
      if (!doc || !doc.body) return;
      const old = doc.querySelector('style[data-sr]');
      if (old) old.remove();
      const st = doc.createElement('style');
      st.setAttribute('data-sr', '1');
      st.textContent = iframeCss();
      doc.head.appendChild(st);
      Reader.wrapHardWords(doc.body);
      if (!doc.__srBound) {
        doc.__srBound = true;
        doc.addEventListener('click', e => {
          const win = contents.window;
          const sel = win.getSelection && win.getSelection();
          if (sel && !sel.isCollapsed) return; // 交给选中查词
          const w = Reader.wordAtPoint(doc, e.clientX, e.clientY);
          if (w) Reader.showEntry(w);
        });
      }
      if (pendingQ) {
        markMatches(doc, pendingQ, contents);
      }
    }

    function markMatches(doc, q, contents) {
      const lq = q.toLowerCase();
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.nodeValue && n.nodeValue.toLowerCase().includes(lq)) nodes.push(n);
      }
      let first = null;
      for (const n of nodes) {
        const text = n.nodeValue;
        const lt = text.toLowerCase();
        const frag = doc.createDocumentFragment();
        let last = 0, idx;
        let search = 0;
        while ((idx = lt.indexOf(lq, search)) >= 0) {
          frag.appendChild(doc.createTextNode(text.slice(last, idx)));
          const mk = doc.createElement('mark');
          mk.className = 'find';
          mk.textContent = text.slice(idx, idx + q.length);
          frag.appendChild(mk);
          if (!first) first = mk;
          last = idx + q.length;
          search = last;
        }
        frag.appendChild(doc.createTextNode(text.slice(last)));
        n.parentNode.replaceChild(frag, n);
      }
      if (!first) { pendingQ = null; jumped = false; return; }
      // 分页模式下先用 CFI 跳到首个匹配处，再滚动定位
      if (!jumped && contents && contents.cfiFromRange) {
        try {
          const r = doc.createRange();
          r.selectNode(first);
          const cfi = contents.cfiFromRange(r);
          if (cfi) {
            jumped = true;
            setTimeout(() => { jumped = false; pendingQ = null; }, 2000); // 兜底清理
            rendition.display(cfi);
            return; // 重渲染后会再次进入 markMatches 完成滚动
          }
        } catch (e) { /* 回退到 scrollIntoView */ }
      }
      first.scrollIntoView({ block: 'center' });
      pendingQ = null;
      jumped = false;
    }

    function labelForHref(href) {
      const find = items => {
        for (const it of items) {
          if (it.href && href && (href.startsWith(it.href.split('#')[0]) || it.href.split('#')[0] === href.split('#')[0])) return (it.label || '').trim();
          if (it.subitems && it.subitems.length) { const r = find(it.subitems); if (r) return r; }
        }
        return null;
      };
      return find(toc) || '';
    }

    self.open = async (pane, savedLoc) => {
      container = pane;
      const blob = await DB.getFile(bookMeta.id);
      const buf = await blob.arrayBuffer();
      ebook = ePub(buf);
      const nav = await ebook.ready;
      toc = (nav && nav.toc) || (ebook.navigation && ebook.navigation.toc) || [];
      if (toc.length) App.fillToc(toc, href => rendition.display(href));
      rendition = ebook.renderTo(pane, { width: '100%', height: '100%', spread: 'none', flow: 'paginated' });
      self.ebook = ebook; self.rendition = rendition;
      rendition.hooks.content.register(decorate);
      rendition.on('relocated', loc => {
        if (!loc || !loc.start) return;
        try {
          const p = ebook.locations.percentageFromCfi(loc.start.cfi);
          if (self.onProgress && isFinite(p)) self.onProgress(p, Math.round(p * 100) + '%');
        } catch (e) {}
      });
      rendition.on('selected', (cfiRange, contents) => {
        if (!contents || !contents.range) return;
        contents.range(cfiRange).then(range => {
          const txt = (range && range.toString() || '').trim();
          if (txt && txt.length <= 60) Reader.showEntry(txt.replace(/\s+/g, ' '));
        }).catch(() => {});
      });
      // 生成位置索引（用于百分比进度与恢复）
      ebook.locations.generate(1200);
      if (savedLoc) {
        await rendition.display(savedLoc).catch(() => rendition.display());
      } else {
        await rendition.display();
      }
      ready = true;
    };

    self.getLocation = () => {
      if (!rendition || !ready) return null;
      let cur = null;
      try { cur = rendition.currentLocation(); } catch (e) {}
      if (!cur || !cur.start || !cur.start.cfi) return null;
      let percent = 0;
      try { percent = ebook.locations.percentageFromCfi(cur.start.cfi) || 0; } catch (e) {}
      let excerpt = '';
      try {
        const c = rendition.getContents()[0];
        const body = c && c.document && (c.document.body || c.document.documentElement);
        if (body) {
          const t = body.textContent.replace(/\s+/g, ' ').trim();
          // 按章节内进度取一段摘录
          const at = Math.floor(percent * t.length * 0.9);
          excerpt = t.slice(at, at + 80);
        }
      } catch (e) {}
      return { loc: cur.start.cfi, percent, excerpt, label: labelForHref(cur.start.href) };
    };

    self.goTo = (loc, q) => {
      if (q) pendingQ = q;
      return rendition.display(loc).catch(() => {});
    };
    self.goToPercent = p => {
      try {
        const cfi = ebook.locations.cfiFromPercentage(Math.min(0.999, Math.max(0, p)));
        if (cfi) rendition.display(cfi);
      } catch (e) {}
    };
    self.prev = () => rendition && rendition.prev();
    self.next = () => rendition && rendition.next();
    self.applyFont = () => {
      if (!rendition) return;
      rendition.getContents().forEach(c => decorate(c));
    };

    self.search = async q => {
      const lq = q.toLowerCase();
      const results = [];
      for (const section of ebook.spine.spineItems) {
        let doc;
        try { doc = await section.load(ebook.load.bind(ebook)); } catch (e) { continue; }
        const root = (doc && doc.nodeType === 1) ? doc : (doc && (doc.body || doc.documentElement));
        if (!root) continue;
        const text = root.textContent;
        const lt = text.toLowerCase();
        let idx = lt.indexOf(lq);
        while (idx >= 0 && results.length < 100) {
          const s = Math.max(0, idx - 28), e2 = Math.min(text.length, idx + q.length + 28);
          results.push({
            where: labelForHref(section.href) || section.href,
            snippet: (s > 0 ? '…' : '') + text.slice(s, e2).replace(/\s+/g, ' ') + (e2 < text.length ? '…' : ''),
            loc: section.href,
          });
          idx = lt.indexOf(lq, idx + q.length);
        }
        if (results.length >= 100) break;
      }
      return results;
    };

    self.destroy = () => { try { rendition && rendition.destroy(); } catch (e) {} try { ebook && ebook.destroy(); } catch (e) {} };
    return self;
  }
  return { create };
})();
