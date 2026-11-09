// 构建后检查：dist 里不得出现 Token / 密码相关字符串，防止误把服务端变量打进浏览器 bundle
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BAD = [/imgbed_[0-9a-f]{16,}/i, /IMGBED_LIST_TOKEN/, /\/api\/manage\//, /Bearer\s/, /adminPassword/i];
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})('dist');
let bad = 0;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const re of BAD) {
    if (re.test(s)) {
      console.error(`✗ ${f} 命中敏感模式 ${re}`);
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log(`✓ bundle 检查通过：${files.length} 个文件，无 Token / manage 接口字符串`);
