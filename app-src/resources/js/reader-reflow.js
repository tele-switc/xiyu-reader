/* 重排版渲染器：用于 MOBI 提取的 HTML 正文（滚动阅读） */
const ReflowReader = (() => {
  function create(bookMeta) {
    let container = null, docEl = null, plainText = '';
    const self = { onProgress: null };

    function percent() {
      const max = docEl.scrollHeight - container.clientHeight;
      if (max <= 0) return 0;
      return Math.min(1, Math.max(0, container.scrollTop / max));
    }
    function report() {
      if (self.onProgress) self.onProgress(percent(), Math.round(percent() * 100) + '%');
    }

    self.open = async (pane, savedLoc) => {
      container = pane;
      pane.classList.add('scrolling');
      const blob = await DB.getFile(bookMeta.id);
      const buf = await blob.arrayBuffer();
      let html;
      if (bookMeta.type === 'txt') {
        // 纯文本：解码后按段落排版
        let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        // 备选：非 UTF-8 时尝试 latin-1（西语旧文件）
        if (/\uFFFD/.test(text.slice(0, 2000))) {
          text = new TextDecoder('iso-8859-1').decode(buf);
        }
        html = text.split(/\r?\n\s*\r?\n/).map(p => '<p>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\r?\n/g, '<br>') + '</p>').join('');
      } else {
        const parsed = MOBI.parse(buf);
        html = MOBI.sanitize(parsed.html);
      }
      docEl = document.createElement('div');
      docEl.className = 'reflow-doc';
      docEl.innerHTML = html || '<p>（未能提取到正文）</p>';
      pane.appendChild(docEl);
      plainText = docEl.textContent.replace(/\s+/g, ' ');
      Reader.wrapHardWords(docEl);
      docEl.addEventListener('click', e => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const w = Reader.wordAtPoint(document, e.clientX, e.clientY);
        if (w) Reader.showEntry(w);
      });
      container.addEventListener('scroll', report, { passive: true });
      if (savedLoc && savedLoc.startsWith('scroll:')) {
        const p = parseFloat(savedLoc.slice(7)) || 0;
        requestAnimationFrame(() => {
          container.scrollTop = p * (docEl.scrollHeight - container.clientHeight);
          report();
        });
      }
      report();
    };

    self.getLocation = () => {
      if (!docEl) return null;
      const p = percent();
      const at = Math.floor(p * plainText.length);
      const excerpt = plainText.slice(at, at + 70).trim();
      return { loc: 'scroll:' + p.toFixed(4), percent: p, excerpt, label: Math.round(p * 100) + '% 处' };
    };

    function markMatches(q) {
      const lq = q.toLowerCase();
      const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.nodeValue && n.nodeValue.toLowerCase().includes(lq)) nodes.push(n);
      }
      let first = null;
      for (const n of nodes) {
        const text = n.nodeValue, lt = text.toLowerCase();
        const frag = document.createDocumentFragment();
        let last = 0, idx, search = 0;
        while ((idx = lt.indexOf(lq, search)) >= 0) {
          frag.appendChild(document.createTextNode(text.slice(last, idx)));
          const mk = document.createElement('mark');
          mk.className = 'find';
          mk.textContent = text.slice(idx, idx + q.length);
          frag.appendChild(mk);
          if (!first) first = mk;
          last = idx + q.length; search = last;
        }
        frag.appendChild(document.createTextNode(text.slice(last)));
        n.parentNode.replaceChild(frag, n);
      }
      if (first) { first.scrollIntoView({ block: 'center' }); return true; }
      return false;
    }

    self.goTo = (loc, q) => {
      if (typeof loc !== 'string') return;
      if (loc.startsWith('scroll:')) {
        const p = parseFloat(loc.slice(7)) || 0;
        container.scrollTop = p * (docEl.scrollHeight - container.clientHeight);
      } else if (loc.startsWith('find:')) {
        const p = parseFloat(loc.slice(5)) || 0;
        container.scrollTop = p * (docEl.scrollHeight - container.clientHeight);
      }
      if (q) markMatches(q);
      report();
    };
    self.goToPercent = p => { container.scrollTop = p * (docEl.scrollHeight - container.clientHeight); report(); };
    self.prev = () => container.scrollBy({ top: -container.clientHeight * 0.85, behavior: 'smooth' });
    self.next = () => container.scrollBy({ top: container.clientHeight * 0.85, behavior: 'smooth' });

    self.search = async q => {
      const lq = q.toLowerCase(), lt = plainText.toLowerCase();
      const results = [];
      let idx = lt.indexOf(lq);
      while (idx >= 0 && results.length < 100) {
        const s = Math.max(0, idx - 30), e2 = Math.min(plainText.length, idx + q.length + 30);
        const frac = idx / Math.max(1, plainText.length);
        results.push({
          where: `约 ${Math.round(frac * 100)}% 处`,
          snippet: (s > 0 ? '…' : '') + plainText.slice(s, e2) + (e2 < plainText.length ? '…' : ''),
          loc: 'find:' + frac.toFixed(5),
        });
        idx = lt.indexOf(lq, idx + q.length);
      }
      return results;
    };

    self.destroy = () => { if (container) { container.innerHTML = ''; container.classList.remove('scrolling'); } };
    return self;
  }
  return { create };
})();
