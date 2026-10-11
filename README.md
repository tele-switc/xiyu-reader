# 西语阅读器 · Lector

一个离线桌面阅读器，用来做**西班牙语沉浸式阅读**：导入自己的书，读的时候点词就出释义和例句，
生词记进生词本，还能同步到欧路词典／西语助手的开放 API。基于 [Neutralino.js](https://neutralino.js.org/)，
不是 Electron，装完很小。

能读 epub / PDF / MOBI / TXT；PDF 带高亮与批注落盘；内置变位引擎（点 `comiendo`、`se sentó`
这类词形也能识别到原形）、词汇量测试、阅读进度与画像。

> ## ⚠️ 这个仓库**不含词典数据**，需要先自己构建一次
>
> 运行时要读的 `resources/data/`（词典 24MB）逐字来自 **en.wiktionary**（经 wiktextract/kaikki.org）
> 与 **frequency_words**，两者都是 **CC BY-SA 4.0**（带 ShareAlike），例句来自 **Tatoeba**（CC BY 2.0 FR，需署名）。
> 把这份数据以 MIT 名义直接发布属于违规再分发，所以本仓库只发**代码 + 构建脚本**，
> 数据由你从上述公开来源自行生成，各自遵守原许可。
> `tools/build_data.py` 会把 URL、sha256、条目数、许可都写进 `data/BUILD_INFO.json`，出处链留档。

## 1. 构建数据

只需要 Python 3.9+ 标准库，不用 pip install。

```bash
# 最快：只建词频表（14.5MB 下载，实测本机 5.9 秒出 200,000 词条）
python tools/build_data.py --freq-only

# 完整：词典 + 词频 + 例句（词典 gz 约 95MB， uncompressed 1.0GB）
python tools/build_data.py --all

# 试跑：只取前 20000 个词条，先看格式对不对
python tools/build_data.py --dict-only --limit 20000

# 与已有数据对照（验证同源与秩一致）
python tools/build_data.py --freq-only --verify <你手上那份 data 目录>
```

输出落在 `app-src/resources/data/`（默认），下载缓存在 `data-build/cache/`，可重复运行、支持断点续传。

产物格式：

| 文件 | 结构 | 来源 |
|---|---|---|
| `dict/dict_NN.json` | `{"词": {"p": "中文词性", "g": ["英文释义", …]}}` | kaikki Spanish |
| `ex/ex_NN.json` | `{"词": [["西语原句", "中文译文"], …]}` | Tatoeba spa↔cmn |
| `freq.json` | `{"词": 整数秩}`，秩从 1 起 | frequency_words `es_full.txt` |

词频表这条路径是**逐条可复现的**：对 `es_full.txt` 施加"只保留 `^[a-záéíóúüñ]+$` + 去重 + 取前 20 万"
规则后，与本项目此前使用的 200,000 条词表**交集 200,000、秩逐条一致**。

词典路径做过等价性对照（取 kaikki 前 5000 词条与既有词典比）：**交集 3639 词，首义项逐字一致 99.31%**。
过程中定位并复刻了原库两条隐藏规则——① gloss 截断到 **90 字符**（原库全库最大长度恰为 90）；
② `pos → 中文词性`映射表有缺项（`contraction`/`name`/`particle`/`proverb` 会以英文残留），已补全。
修好这两条后一致率从 96.40% 升到 99.31%，剩余 25 处是同一词多个词性/词源时**义项选取顺序**不同
（如 `gala` 本脚本取屈折释义、原库取词条本义），原库的优先级无从反推，不影响点词查询可用性。
本脚本每词最多保留 2 条义项（均值 1.33），比原库（1.09）略全。

### 数据来源不明、因此不重建的部分

`dict-en.json`（西→英）、`en-top.json`、`zh-top.json`、`cognate.json` 这四个文件在本项目里查不到可靠出处
（且 `en-top`/`zh-top` 存在机翻错值，如 `se→"if"`、`te→"茶"`），所以**不发布也不代生成**。
构建脚本只为它们写出空占位，保证应用能启动，对应功能自然降级：

- 英中对照词表提示 → 无
- 同源词（cognate）高亮 → 无
- 词汇量测试（testbank）→ 需要自备语料，否则出题不可用（脚本会生成结构合法的空档位）

## 2. 跑起来

```bash
cd app-src
npm install                # 装 @neutralinojs/neu 与 pdf-lib
npx neu run                # 开发模式直接跑
npx neu build              # 出包到 dist/
```

`resources/bin/`（各平台 Neutralino 壳，约 22MB）不在仓库里，由 `neu` 首次运行时自行下载。

## 3. 生词本同步的隐私设计

- Token 由你自己粘贴，只存本机 `localStorage`（键 `sr-eshelper`），代码里没有内置凭据
- 限流退避按官方口径实现：1 分钟 30 次封 1 小时、30 分钟 500 次封 24 小时，合并批量发送
- 生词本 ID 一律按**字符串**处理。官方 ID 是 18 位、大于 2^53，用 `Number()` 存会被双精度改掉尾数，
  词就进错本子；代码里带一段按词本名找回正确 ID 的自愈逻辑
- 仓库内的测试桩、fixture 用的是人造占位 ID，不是任何真实账号

## 4. 许可

- 代码：MIT，见 `LICENSE`
- 捆绑第三方库（epub.js / JSZip / pdf-lib / pdf.js）：见 `NOTICE`，各文件头部版权与许可原文均未删改
- 你构建出的 `data/`：**不受 MIT 覆盖**，分别受 CC BY-SA 4.0（词典、词频）与 CC BY 2.0 FR（例句，需署名）约束
- `resources/demo/` 里是《堂吉诃德》节选与两个合成示例文件（公版/占位）

## 5. 目录

```
app-src/
  neutralino.config.json
  resources/
    index.html  styles.css
    js/         应用代码（阅读器、变位引擎、生词本同步、测试等）
    lib/        捆绑的第三方库（见 NOTICE）
    icons/  demo/
    data/       ← 由 tools/build_data.py 生成，不入库（.gitignore）
tools/          build_data.py、部署脚本、同步契约测试桩
docs/           状态与校准记录
```
