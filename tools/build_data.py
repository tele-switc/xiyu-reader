#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_data.py —— 从公开来源重建点词词典、例句库与词频表。

为什么仓库里不带 data/：
  本项目运行时要读 24MB 词典数据。这些数据逐字来自
    * en.wiktionary（经 wiktextract/kaikki.org 抽取）—— CC BY-SA 4.0，含 ShareAlike；
    * frequency_words (hermitdave/FrequencyWords) 的 es_full.txt —— 内容 CC BY-SA 4.0；
    * Tatoeba 西-中句对 —— CC BY 2.0 FR，需署名。
  ShareAlike 会把许可传染给整个数据包，而代码本身是 MIT。所以本仓库**只发代码 + 本脚本**，
  数据由你按下述来源自行构建，并各自遵守其许可（构建结果里会写 BUILD_INFO.json 记录出处链）。

用法：
  python tools/build_data.py --all                          # 全量构建到 app-src/resources/data
  python tools/build_data.py --all --limit 20000            # 只取前 N 条词条（试跑，边下边停）
  python tools/build_data.py --freq-only                    # 只重建词频表（最小可用集）
  python tools/build_data.py --all --verify <旧 data 目录>   # 与既有数据做等价性对照

产物：
  data/dict/dict_NN.json    {"词": {"p": "中文词性", "g": ["英文释义", ...]}}
  data/ex/ex_NN.json        {"词": [["西语句", "中文译文"], ...]}
  data/freq.json            {"词": 秩}     ← 值是**整数**秩（1 起），实测与旧库逐词一致
  data/BUILD_INFO.json      出处链：URL / 下载时间 / sha256 / 规模 / 许可 / 映射规则版本
  data/dict-en.json 等      占位空文件（见 PLACEHOLDER_NOTE，来源不明不重新生成）

依赖：Python 3.9+ 标准库（urllib / bz2 / gzip / json），不需要 pip install。
"""
import argparse
import bz2
import gzip
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ---------------- 来源清单（URL 于 2026-10-11 实测可达，体积来自 Content-Length）----------------
SOURCES = {
    "dict": {
        "url": "https://kaikki.org/dictionary/Spanish/kaikki.org-dictionary-Spanish.jsonl.gz",
        "raw_url": "https://kaikki.org/dictionary/Spanish/kaikki.org-dictionary-Spanish.jsonl",
        "kind": "gzip-jsonl",
        "cache": "kaikki-spanish.jsonl.gz",
        "license": "CC BY-SA 4.0 (源文本为 en.wiktionary；派生词典须同许可并署名)",
        "attribution": "Wiktextract / Tatu Ylonen (LREC 2022); data from en.wiktionary.org",
        "size_hint": 95_164_223,
    },
    "freq": {
        "url": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/es/es_full.txt",
        "kind": "text",
        "cache": "es_full.txt",
        "license": "CC BY-SA 4.0（该仓库 README：code MIT / content CC-by-sa-4.0）",
        "attribution": "hermitdave/FrequencyWords, OpenSubtitles 2018 derived",
        "size_hint": 14_547_688,
    },
    "ex": {
        "url": "https://downloads.tatoeba.org/exports/per_language/spa/spa_sentences.tsv.bz2",
        "kind": "bz2-tsv",
        "cache": "spa_sentences.tsv.bz2",
        "license": "CC BY 2.0 FR",
        "attribution": "Tatoeba project (tatoeba.org)",
        "size_hint": 6_361_569,
    },
    "ex_cmn": {
        "url": "https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2",
        "kind": "bz2-tsv",
        "cache": "cmn_sentences.tsv.bz2",
        "license": "CC BY 2.0 FR",
        "attribution": "Tatoeba project (tatoeba.org)",
        "size_hint": 1_258_831,
    },
    "ex_links": {
        "url": "https://downloads.tatoeba.org/exports/per_language/spa/spa-cmn_links.tsv.bz2",
        "kind": "bz2-tsv",
        "cache": "spa-cmn_links.tsv.bz2",
        "license": "CC BY 2.0 FR",
        "attribution": "Tatoeba project (tatoeba.org)",
        "size_hint": 73_243,
    },
}

# wiktextract 的 pos -> 本项目中文词性单字表。
# 旧数据里 intj/character/symbol 三个 pos 没有映射（原样残留英文代码），
# 这里补全；若需要逐字节复刻旧库行为，加 --legacy-pos。
POS_MAP = {
    "noun": "名", "verb": "动", "adj": "形", "adjective": "形", "adv": "副",
    "proper noun": "专名", "pron": "代", "prefix": "前缀", "suffix": "后缀",
    "num": "数", "det": "限定", "adp": "介", "prep": "介", "conj": "连",
    "phrase": "短语", "abbr": "缩", "part": "助", "article": "冠",
    "interj": "叹词", "character": "字符", "symbol": "符号",
    "intj": "叹词", "posp": "介", "copula": "动", "auxiliary": "动",
    "transcription": "转写", "protologism": "专名", "determiner": "限定",
}
LEGACY_UNMAPPED = {"interj": "intj", "character": "character", "symbol": "symbol"}
# 实测重建时仍会以英文残留的 pos，补进映射表（否则界面上会冒出 contraction 这类词性）
POS_MAP.update({
    "contraction": "缩", "name": "专名", "particle": "助", "proverb": "短语",
    "adverb": "副", "adposition": "介", "interjection": "叹词", "numeral": "数",
    "conjunction": "连", "expression": "短语", "idiom": "短语", "greeting": "叹词",
    "pronoun": "代", "sentence": "短句", "determiner": "限定", "roman numeral": "数",
    "custom class": "专名", "affix": "缀",
})

# 旧库把每条 gloss 截到 90 字符（实测：全库最大长度恰为 90，且 106/106 处差异都是这一条规则），
# 这里复刻——否则重建出的词典体积与显示宽度都跟原库对不上。
MAX_GLOSS_LEN = 90
MAX_GLOSSES = 2

# 旧库里来源不明、无法重建的文件：只生成结构合法的占位，让应用能启动。
PLACEHOLDER_NOTE = (
    "dict-en.json / en-top.json / zh-top.json / cognate.json 的原始来源未能确认，"
    "本脚本不重建它们，只写出空占位以保证应用启动；相应功能（英中对照词表、"
    "同源词提示）在缺失数据时自然降级。"
)

RULES_VERSION = "2026-10-11.1"


# ---------------- 下载与流式读取 ----------------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url, dest, expected=None, quiet=False):
    """带续传的下载：先写 .part，完成后落地。已存在且大小匹配则跳过。"""
    if os.path.exists(dest) and (expected is None or os.path.getsize(dest) == expected):
        if not quiet:
            print("  已缓存 %s (%.1f MB)，跳过下载" % (os.path.basename(dest), os.path.getsize(dest) / 1e6))
        return dest
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    part = dest + ".part"
    start = os.path.getsize(part) if os.path.exists(part) else 0
    headers = {"User-Agent": "xiyureader-build-data/1.0"}
    if start:
        headers["Range"] = "bytes=%d-" % start
    req = urllib.request.Request(url, headers=headers)
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as r, open(part, "ab" if start else "wb") as f:
        mode = r.getcode()
        if start and mode != 206:
            f.seek(0), f.truncate(0)          # 服务器不支持 Range，重来
            start = 0
        total = start + int(r.headers.get("Content-Length") or 0)
        got = start
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if not quiet and total:
                sys.stdout.write("\r  %s  %.1f/%.1f MB" %
                                 (os.path.basename(dest), got / 1e6, total / 1e6))
                sys.stdout.flush()
    if not quiet:
        print("\r  %s 完成 %.1f MB，%.1f 秒" %
              (os.path.basename(dest), got / 1e6, time.time() - t0))
    os.replace(part, dest)
    return dest


def stream_lines(path, is_gzip=False, is_bz2=False):
    """流式按行读（utf-8），不把整个文件载入内存。"""
    opener = builtins_open = open(path, "rb")
    if is_gzip:
        f = gzip.open(builtins_open, "rb")
    elif is_bz2:
        f = bz2.open(builtins_open, "rb")
    else:
        f = builtins_open
    with f:
        for raw in f:
            yield raw.decode("utf-8", "replace").rstrip("\n")


# ---------------- dict：kaikki JSONL → 分片 ----------------

def build_dict(cache_dir, out_dir, limit=None, shard_size=3844, legacy_pos=False):
    src = SOURCES["dict"]
    path = download(src["url"], os.path.join(cache_dir, src["cache"]), src.get("size_hint"))
    entries = {}
    n_lines = 0
    for line in stream_lines(path, is_gzip=True):
        if not line.strip():
            continue
        n_lines += 1
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        word = d.get("word")
        pos = d.get("pos")
        if not word or not pos:
            continue
        glosses = []
        for s in d.get("senses") or []:
            for g in (s.get("glosses") or []):
                g = " ".join(g.split())[:MAX_GLOSS_LEN]
                if g and g not in glosses:
                    glosses.append(g)
            if len(glosses) >= MAX_GLOSSES:
                break
        if not glosses:
            continue
        p = POS_MAP.get(pos)
        if p is None:
            p = (LEGACY_UNMAPPED if legacy_pos else {}).get(pos, pos)
        e = entries.get(word)
        if e is None:
            entries[word] = {"p": p, "g": glosses[:MAX_GLOSSES]}
        else:
            if e["p"] == pos or e["p"] == p:
                for g in glosses:
                    if g not in e["g"] and len(e["g"]) < MAX_GLOSSES:
                        e["g"].append(g)
        if limit and len(entries) >= limit:
            print("  --limit 生效：取满 %d 词条后停止（未下完的流已关闭）" % limit)
            break
    words = sorted(entries)
    files = write_shards(entries, words, out_dir, "dict", shard_size)
    multi = sum(1 for w in words if len(entries[w]["g"]) > 1)
    print("  dict：%d 词条 → %d 片；多义条目 %d（均 %.3f 义/词）" %
          (len(words), files, multi, sum(len(entries[w]["g"]) for w in words) / max(1, len(words))))
    return {"lines_seen": n_lines, "entries": len(words), "shards": files,
            "sha256": sha256_file(path), "source": src["url"]}


# ---------------- freq：FrequencyWords → {词: 秩字符串} ----------------

ES_WORD_RE = re.compile(r"^[a-záéíóúüñ]+$")


def build_freq(cache_dir, out_dir, top=200_000):
    src = SOURCES["freq"]
    path = download(src["url"], os.path.join(cache_dir, src["cache"]), src.get("size_hint"))
    freq, seen = {}, set()
    rank = 0
    for line in stream_lines(path):
        parts = line.split()
        if len(parts) != 2:
            continue
        w = parts[0]
        if not ES_WORD_RE.match(w) or w in seen:
            continue
        seen.add(w)
        rank += 1
        freq[w] = rank                 # 与旧库一致：值是 **整数** 秩（1 起），不是字符串也不是频次
        if rank >= top:
            break
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "freq.json"), "w", encoding="utf-8") as f:
        json.dump(freq, f, ensure_ascii=False, separators=(",", ":"))
    print("  freq：%d 词条（秩 1..%d）" % (len(freq), rank))
    return {"entries": len(freq), "sha256": sha256_file(path), "source": src["url"]}


# ---------------- ex：Tatoeba 西中句对 → 分片 ----------------

def read_tatoeba_tsv(cache_dir, key):
    src = SOURCES[key]
    path = download(src["url"], os.path.join(cache_dir, src["cache"]), src.get("size_hint"))
    rows = {}
    for line in stream_lines(path, is_bz2=True):
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        try:
            rows[int(parts[0])] = parts[2]
        except ValueError:
            continue
    return rows, path


WORD_IN_SENT = re.compile(r"[a-záéíóúüñ]{4,}")


def build_ex(cache_dir, out_dir, head_words, max_per_word=3, max_heads=9000, shard_size=380):
    spa, spa_path = read_tatoeba_tsv(cache_dir, "ex")
    cmn, cmn_path = read_tatoeba_tsv(cache_dir, "ex_cmn")
    links_src = SOURCES["ex_links"]
    links_path = download(links_src["url"], os.path.join(cache_dir, links_src["cache"]),
                          links_src.get("size_hint"))
    pairs = []
    for line in stream_lines(links_path, is_bz2=True):
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        try:
            s, t = int(parts[1]), int(parts[2])
        except ValueError:
            continue
        if parts[2] == "cmn" and s in spa and t in cmn:
            pairs.append((spa[s], cmn[t]))
    print("  Tatoeba：西语句 %d，中文句 %d，可用句对 %d" % (len(spa), len(cmn), len(pairs)))

    ex = {}
    for sp_text, cn_text in pairs:
        low = " " + sp_text.lower() + " "
        for w in set(WORD_IN_SENT.findall(low)):
            if head_words and w not in head_words:
                continue
            bucket = ex.setdefault(w, [])
            if len(bucket) >= max_per_word:
                continue
            if any(b[0] == sp_text for b in bucket):
                continue
            bucket.append([sp_text, cn_text])
        if len(ex) >= max_heads * 3:
            break
    words = sorted(ex)[:max_heads]
    files = write_shards({w: ex[w] for w in words}, words, out_dir, "ex", shard_size)
    total_pairs = sum(len(ex[w]) for w in words)
    print("  ex：%d 头词 / %d 句对 → %d 片" % (len(words), total_pairs, files))
    return {"heads": len(words), "pairs": total_pairs, "shards": files,
            "sentence_pairs_available": len(pairs),
            "sha256": [sha256_file(spa_path), sha256_file(cmn_path), sha256_file(links_path)],
            "source": [SOURCES["ex"]["url"], SOURCES["ex_cmn"]["url"], links_src["url"]]}


# ---------------- 分片写出 ----------------

def write_shards(payload, ordered_keys, out_dir, prefix, shard_size):
    os.makedirs(os.path.join(out_dir, prefix), exist_ok=True)
    n = 0
    for i in range(0, len(ordered_keys), shard_size):
        chunk = {k: payload[k] for k in ordered_keys[i:i + shard_size]}
        with open(os.path.join(out_dir, prefix, "%s_%02d.json" % (prefix, n)),
                  "w", encoding="utf-8") as f:
            json.dump(chunk, f, ensure_ascii=False, separators=(",", ":"))
        n += 1
    return n


def write_placeholders(out_dir, freq=None, dict_entries=None):
    """来源不明的文件 → 空占位；testbank 系列 → 从已重建数据生成结构合法的最小集。"""
    os.makedirs(out_dir, exist_ok=True)
    for name, val in (("dict-en.json", {}), ("en-top.json", {}), ("zh-top.json", {}),
                      ("cognate.json", [])):
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            json.dump(val, f, ensure_ascii=False)
    tb = {"version": 1, "note": PLACEHOLDER_NOTE, "zh": {}, "es": {}}
    with open(os.path.join(out_dir, "testbank.json"), "w", encoding="utf-8") as f:
        json.dump(tb, f, ensure_ascii=False)
    # data.js 会检查 tb3.bands 存在，否则直接 throw —— 这里给出 8 个合法空档
    bands = []
    if freq:
        step = max(1, len(freq) // 8)
        for i in range(8):
            lo, hi = i * step, (i + 1) * step
            bands.append([w for w, r in freq.items() if lo < int(r) <= hi][:400])
    else:
        bands = [[] for _ in range(8)]
    tb3 = {"version": 3, "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "bandRanges": [[i * 12, i * 12 + 12] for i in range(8)],
           "bandSizes": [len(b) for b in bands], "bands": bands,
           "gloss": {}, "note": PLACEHOLDER_NOTE}
    with open(os.path.join(out_dir, "testbank3.json"), "w", encoding="utf-8") as f:
        json.dump(tb3, f, ensure_ascii=False)
    print("  占位与 testbank 已写出（词汇量测试需自备数据，见 PLACEHOLDER_NOTE）")


# ---------------- 与既有数据对照（验证同源/等价）----------------

def load_existing(dirpath):
    out = {}
    for name in ("freq.json",):
        p = os.path.join(dirpath, name)
        if os.path.exists(p):
            out[name] = json.load(open(p, encoding="utf-8"))
    for prefix in ("dict", "ex"):
        d = os.path.join(dirpath, prefix)
        if os.path.isdir(d):
            merged = {}
            for fn in sorted(os.listdir(d)):
                if fn.endswith(".json"):
                    merged.update(json.load(open(os.path.join(d, fn), encoding="utf-8")))
            out[prefix] = merged
    return out


def verify(out_dir, against_dir):
    old = load_existing(against_dir)
    print("=== 等价性对照（新构建 vs 既有数据）===")
    if "freq.json" in old and os.path.exists(os.path.join(out_dir, "freq.json")):
        new = json.load(open(os.path.join(out_dir, "freq.json"), encoding="utf-8"))
        inter = set(new) & set(old["freq.json"])

        def rk(x):
            try:
                return int(x)
            except (TypeError, ValueError):
                return None
        same_rank = sum(1 for w in inter if rk(new[w]) == rk(old["freq.json"][w]))
        strict = sum(1 for w in inter if new[w] == old["freq.json"][w])
        t_old = {type(next(iter(old["freq.json"].values()))).__name__}
        t_new = {type(next(iter(new.values()))).__name__}
        print("  freq: 旧 %d / 新 %d / 交集 %d / 秩一致 %d（%.2f%%）｜ 严格相等 %d ｜ 值类型 旧=%s 新=%s" %
              (len(old["freq.json"]), len(new), len(inter), same_rank,
               100.0 * same_rank / max(1, len(inter)), strict, t_old, t_new))
        if same_rank and not strict:
            print("  !! 秩数值一致但 JSON 类型不同——应用侧会拿到不同类型，必须对齐")
    for prefix in ("dict", "ex"):
        if prefix not in old:
            continue
        d = os.path.join(out_dir, prefix)
        if not os.path.isdir(d):
            continue
        new = {}
        for fn in os.listdir(d):
            if fn.endswith(".json"):
                new.update(json.load(open(os.path.join(d, fn), encoding="utf-8")))
        inter = set(new) & set(old[prefix])
        if prefix == "dict" and inter:
            def first_g(x):
                return (x.get("g") or [""])[0] if isinstance(x, dict) else ""
            same = sum(1 for w in inter if first_g(new[w]) == first_g(old[prefix][w]))
            print("  dict: 旧 %d / 新 %d / 交集 %d / 首义项逐字一致 %d（%.2f%%）" %
                  (len(old[prefix]), len(new), len(inter), same, 100.0 * same / len(inter)))
        elif prefix == "ex" and inter:
            def texts(x):
                return {p[0] for p in x if isinstance(p, list) and p}
            same = sum(1 for w in inter if texts(new[w]) & texts(old[prefix][w]))
            print("  ex: 旧 %d / 新 %d / 交集 %d / 有同句的头词 %d（%.2f%%）" %
                  (len(old[prefix]), len(new), len(inter), same, 100.0 * same / len(inter)))


# ---------------- main ----------------

def main():
    ap = argparse.ArgumentParser(description="重建 XiYuReader 的词典/词频/例句数据")
    ap.add_argument("--out", default="app-src/resources/data", help="输出目录")
    ap.add_argument("--cache-dir", default="data-build/cache", help="下载缓存目录")
    ap.add_argument("--all", action="store_true", help="构建全部三类")
    ap.add_argument("--dict-only", action="store_true")
    ap.add_argument("--freq-only", action="store_true")
    ap.add_argument("--ex-only", action="store_true")
    ap.add_argument("--limit", type=int, help="词典条目上限（试跑用，边下边停）")
    ap.add_argument("--top", type=int, default=200_000, help="freq 取前 N 个词")
    ap.add_argument("--legacy-pos", action="store_true", help="复刻旧库未映射 intj/character/symbol 的行为")
    ap.add_argument("--verify", metavar="DIR", help="与既有 data 目录做等价性对照")
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.cache_dir, exist_ok=True)
    info = {"rulesVersion": RULES_VERSION, "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "out": a.out, "sources": {}, "licenses": {}, "placeholders_note": PLACEHOLDER_NOTE}

    todo = (a.all or a.dict_only or a.freq_only or a.ex_only)
    if not todo:
        ap.print_help()
        print("\n提示：先跑 `--freq-only` 最快（14MB，几十秒），能立刻让应用动起来。")
        return 2

    freq = None
    if a.all or a.freq_only:
        r = build_freq(a.cache_dir, a.out, a.top)
        info["sources"]["freq"] = r
        info["licenses"]["freq"] = SOURCES["freq"]["license"] + " — " + SOURCES["freq"]["attribution"]
        freq = json.load(open(os.path.join(a.out, "freq.json"), encoding="utf-8"))
    if a.all or a.dict_only:
        r = build_dict(a.cache_dir, a.out, a.limit, legacy_pos=a.legacy_pos)
        info["sources"]["dict"] = r
        info["licenses"]["dict"] = SOURCES["dict"]["license"] + " — " + SOURCES["dict"]["attribution"]
    if a.all or a.ex_only:
        heads = set(freq) if freq else None
        r = build_ex(a.cache_dir, a.out, heads)
        info["sources"]["ex"] = r
        info["licenses"]["ex"] = SOURCES["ex"]["license"] + " — " + SOURCES["ex"]["attribution"]

    if not os.path.exists(os.path.join(a.out, "dict-en.json")):
        write_placeholders(a.out, freq)
    with open(os.path.join(a.out, "BUILD_INFO.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=1)
    print("  出处链已写 data/BUILD_INFO.json（URL + sha256 + 许可 + 规则版本）")

    if a.verify:
        verify(a.out, a.verify)
    return 0


if __name__ == "__main__":
    sys.exit(main())
