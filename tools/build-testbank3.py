"""生成 testbank3.json —— 词汇量测试 v3 的题库。

为什么要换：旧库每带只有 32 词（自查用 16 词），而 8k–12k / 12k–20k 两带合计 12000 词，
只能用 32 个样本外推，误差被带大小放大到 ±500 词/次点击。新库把每带题池扩到
"该带所有可用释义的词"，并记录每题的释义语言（中文优先，尾部带用英文）。
确定性输出：随机只用固定 seed 做排序打散，重复运行结果一致。
"""
import json
import os
import random
import re
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'app-src', 'resources')
DATA = os.path.join(RES, 'data')
BANDS = [(1, 500), (501, 1000), (1001, 2000), (2001, 3000),
         (3001, 5000), (5001, 8000), (8001, 12000), (12001, 20000)]
# 每带题池上限：控制 testbank3.json 体积（题池越大越抗重复，但加载也越慢）
CAP = [400, 400, 500, 500, 600, 600, 500, 700]
MIN_PER_BAND = 120
WORD_RE = re.compile(r'^[a-záéíóúüñ¿¡·\-]{2,}$', re.I)          # 少于这个数量就没法做自适应抽样，直接报出来
POOL = os.path.join(DATA, 'testbank3.json')


def load(name):
    with open(os.path.join(DATA, name), encoding='utf-8') as f:
        return json.load(f)


def main():
    freq = load('freq.json')
    zh_top = load('zh-top.json')
    old = load('testbank.json')
    en_top = load('en-top.json')
    dict_en = load('dict-en.json')
    cognates = set(load('cognate.json'))

    big = {}
    for i in range(64):
        big.update(load(os.path.join('dict', 'dict_%02d.json' % i)))

    examples = set()
    for i in range(24):
        examples.update(load(os.path.join('ex', 'ex_%02d.json' % i)).keys())

    def gloss_of(w):
        """返回 (语言, 释义) —— 中文优先，尾部带落英文。"""
        z = zh_top.get(w) or old['zh'].get(w)
        if z and len(z.strip()) >= 1:
            return 'zh', z.strip()
        for src in (en_top, dict_en):
            e = src.get(w)
            if isinstance(e, str) and len(e.strip()) >= 3:
                return 'en', e.strip()
        b = big.get(w)
        if isinstance(b, dict):
            g = b.get('g') or []
            if g and len(str(g[0]).strip()) >= 3:
                pos = (b.get('p') or '').strip()
                txt = str(g[0]).strip()
                return 'en', (pos + '. ' + txt if pos else txt)
        return None, None

    ranked = sorted(((w, r) for w, r in freq.items() if 1 <= r <= 20000), key=lambda x: x[1])
    pool, zh_map, gl_map, band_meta = [], {}, {}, []
    rng = random.Random(20260925)

    for bi, (lo, hi) in enumerate(BANDS):
        inb = [w for w, r in ranked if lo <= r <= hi]
        rows = []
        for w in inb:
            if not WORD_RE.match(w):        # 过滤专名/外来词/带撇号串（freq.json 里混了 boyd 这类）
                continue
            lang, txt = gloss_of(w)
            if not txt:
                continue
            rows.append({'w': w, 'lang': lang, 'g': txt,
                         'cog': 1 if w in cognates else 0,
                         'ex': 1 if w in examples else 0})
        # 带内随机打散（固定 seed），保证抽题顺序均匀但可复现
        rng.shuffle(rows)
        if len(rows) < MIN_PER_BAND:
            print('!! 带 %d (%d–%d) 可用词只有 %d，少于 %d' % (bi, lo, hi, len(rows), MIN_PER_BAND))
        rows = rows[:CAP[bi]]
        n_zh = sum(1 for x in rows if x['lang'] == 'zh')
        n_ex = sum(1 for x in rows if x['ex'] == 1)
        band_meta.append({'size': hi - lo + 1, 'pool': len(rows),
                          'zh': n_zh, 'en': len(rows) - n_zh, 'ex': n_ex,
                          'cognateShare': round(sum(x['cog'] for x in rows) / max(1, len(rows)), 3)})
        pool.append([x['w'] for x in rows])
        for x in rows:
            zh_map[x['w']] = x['g']      # 字段名沿用 zh：内容是"该题的显示释义"
            gl_map[x['w']] = x['lang']

    out = {
        'version': 3,
        'builtAt': time.strftime('%Y-%m-%d'),
        'bandRanges': [list(b) for b in BANDS],
        'bandSizes': [hi - lo + 1 for lo, hi in BANDS],
        'bands': pool,
        'gloss': zh_map,
        'glossLang': gl_map,
        'meta': band_meta,
        # 保留旧字段名以兼容其它调用点（reader 只用 testbank.zh 兜底，不含英文）
        'zh': {w: t for w, t in zh_map.items() if gl_map[w] == 'zh'},
    }
    with open(POOL, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    total = sum(len(b) for b in out['bands'])
    print('带   带内词    题池   中文   英文   有例句  同源占比')
    for bi, m in enumerate(band_meta):
        print('%d  %6d %6d %6d %6d %7d   %.0f%%' % (
            bi, m['size'], m['pool'], m['zh'], m['en'], m['ex'], m['cognateShare'] * 100))
    print('题池合计 %d 词（旧库 256）| 文件 %.2f MB -> %s'
          % (total, os.path.getsize(POOL) / 1048576, os.path.basename(POOL)))


if __name__ == '__main__':
    main()
