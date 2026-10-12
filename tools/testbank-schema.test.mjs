/* testbank3.json 占位题库的契约回归测试（不联网）
 * 用法：node tools/testbank-schema.test.mjs   （也会被 `node --test tools/` 收进去）
 *
 * 背景：README 推荐的最快路径 `python tools/build_data.py --freq-only` 只会写出占位题库。
 * 旧占位缺 meta / glossLang，且 bandSizes 被错写成题池长度（≤400），
 * 结果词汇测试一跑（test.js 的 SHARES() 读 TB3.meta.map）就 TypeError。
 * 本测试用 build_data.py 真实产出验证：字段齐全、量程与 test.js/simulate-test.cjs 对齐、
 * 且把 teststat.js 的 estimate() 在空观测上跑通（对应 finish() 的交付路径）。 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const TS = require(path.join(ROOT, 'app-src', 'resources', 'js', 'teststat.js'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  → ' + detail}`);
}

/* 找可用的 python：与 eshelper-sync.test.mjs 同样的本机路径优先，再退到 PATH */
function findPython() {
  const cands = process.platform === 'win32'
    ? [process.env.PYTHON, 'C:\\Python314\\python.exe', 'python', 'python3']
    : [process.env.PYTHON, 'python3', 'python'];
  for (const c of cands) {
    if (!c) continue;
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch (e) {}
  }
  throw new Error('找不到可用的 python');
}

const tmp = mkdtempSync(path.join(tmpdir(), 'xyr-tb3-'));
try {
  const py = findPython();
  // 直接调 build_data.write_placeholders，freq 用合成词表（秩 1..3000）
  execFileSync(py, ['-c',
    'import sys; sys.path.insert(0, sys.argv[1]); import build_data; ' +
    `build_data.write_placeholders(sys.argv[2], {('w%05d' % i): i for i in range(1, 3001)})`,
    path.join(ROOT, 'tools'), tmp], { stdio: 'inherit' });

  const bank = JSON.parse(readFileSync(path.join(tmp, 'testbank3.json'), 'utf-8'));

  // ① test.js 消费面：SIZES/SHARES/gloss/glossLang 一个都不能缺
  check('A bandSizes 为真实词频带量程', JSON.stringify(bank.bandSizes) === JSON.stringify([500, 500, 1000, 1000, 2000, 3000, 4000, 8000]),
    JSON.stringify(bank.bandSizes));
  check('A meta 存在且 8 带各含 cognateShare', Array.isArray(bank.meta) && bank.meta.length === 8 &&
    bank.meta.every(m => typeof m.cognateShare === 'number'));
  check('A glossLang 存在', !!bank.glossLang && typeof bank.glossLang === 'object');
  const shares = bank.meta.map(m => m.cognateShare);       // 旧版在这里 TypeError
  const sizes = bank.bandSizes;
  check('A SHARES()/SIZES() 取数路径跑通', shares.length === 8 && sizes[7] === 8000);

  // ② 词要落进正确的带（秩 1 进带 0，秩 600 进带 1……）
  const b0 = bank.bands[0].includes('w00001'), b1 = bank.bands[1].includes('w00600');
  const wrong = bank.bands[7].some(w => parseInt(w.slice(1), 10) <= 12000);
  check('B 词条按真实秩区间分带', b0 && b1 && !wrong, `带0含w00001=${b0} 带1含w00600=${b1}`);

  // ③ 交付路径：空观测也能走完 estimate（对应界面 finish()），不 NaN 不抛
  const obs = Array.from({ length: 8 }, () => ({ items: [], prod: { items: [] } }));
  const res = TS.estimate(obs, sizes, shares, { m0: 2 });
  check('C estimate 空观测交付不崩', Number.isFinite(res.vocab) && Number.isFinite(res.lo) && Number.isFinite(res.hi),
    `vocab=${res.vocab} lo=${res.lo} hi=${res.hi}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== 汇总：共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} =====`);
if (failed.length) process.exit(1);
