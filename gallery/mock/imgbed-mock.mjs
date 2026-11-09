// 本地 mock ImgBed：模拟 GET /api/manage/list（含 Bearer Token + list 权限校验）和 GET /file/<path>。
// 列表语义照抄 ImgBed D1 实现：只列直接文件，ORDER BY timestamp DESC, id ASC；子目录名不带结尾斜杠、排序、上限 500。
// 图片是本地生成的 SVG 占位图，不需要外网。
import http from 'node:http';

export const MOCK_TOKEN = 'imgbed_mock0000000000000000000000000000000000000000000000000000000000';
const MAX_CHILD_DIRECTORIES = 500;

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildDataset() {
  const files = []; // { id, directory, ts, name }
  let ts = Date.UTC(2025, 0, 1);
  const addSet = (dir, n) => {
    for (let i = 1; i <= n; i++) {
      ts += 1000;
      const name = `${String(i).padStart(3, '0')}.jpg`;
      files.push({ id: `${dir}/${name}`, directory: `${dir}/`, ts, name });
    }
  };
  const models = ['雪見', '小柔', '阿狸', '桃子', '七七', 'Mina', 'Yuki', '若若', '星野', '鹿鹿', '糖糖', 'Rin'];
  const themes = ['夏日泳池', '和服庭院', '校园制服', '夜色霓虹', '海边日落', '森系少女', '咖啡馆', '雨天窗台', '复古港风', '白衬衫', '樱花季', '冬日毛衣'];
  for (let i = 0; i < 18; i++) addSet(`GE/2025-${String((i % 12) + 1).padStart(2, '0')} ${models[i % 12]} ${themes[i % 12]}`, 8 + (hash('GE' + i) % 33));
  for (let i = 0; i < 12; i++) addSet(`HC/${models[(i + 3) % 12]}·${themes[(i + 5) % 12]} Vol.${String(i + 1).padStart(2, '0')}`, 10 + (hash('HC' + i) % 30));
  const collections = ['合集A·摄影棚', '合集B·街拍', '合集C·旅拍', '合集D·写真'];
  collections.forEach((c, ci) => {
    for (let s = 0; s < 10; s++) addSet(`BBB/${c}/${models[(s + ci) % 12]} 第${s + 1}套`, 12 + (hash(c + s) % 40));
  });
  // 大目录：1500 张图，测试分页 / 无限滚动
  addSet('BBB/超大合集/全集 1500P', 1500);
  // 很多子目录：测试目录墙分页
  for (let s = 0; s < 240; s++) addSet(`BBB/海量套图/套图 ${String(s + 1).padStart(3, '0')}`, 6 + (hash('H' + s) % 10));
  // 根目录散图
  ts += 1000;
  files.push({ id: 'readme-cover.jpg', directory: '', ts, name: 'readme-cover.jpg' });
  return files;
}

const DATA = buildDataset();

function list(dir, start, count) {
  const direct = DATA.filter((f) => f.directory === dir).sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
  const children = new Set();
  for (const f of DATA) {
    if (!f.directory.startsWith(dir) || f.directory === dir) continue;
    const rest = f.directory.slice(dir.length);
    children.add(dir + rest.slice(0, rest.indexOf('/')));
  }
  const directories = [...children].sort().slice(0, MAX_CHILD_DIRECTORIES);
  const page = count === -1 ? direct : direct.slice(start, start + count);
  return {
    files: page.map((f) => ({
      name: f.id,
      metadata: {
        FileName: f.name,
        FileType: 'image/svg+xml',
        FileSizeBytes: 200000 + (hash(f.id) % 3000000),
        TimeStamp: f.ts,
        Channel: 'TelegramNew',
        Directory: f.directory,
        ListType: 'None',
        Label: 'None',
        TgChatId: '-100secret-should-be-stripped',
      },
    })),
    directories,
    totalCount: DATA.filter((f) => f.directory.startsWith(dir)).length,
    directFileCount: direct.length,
    directFolderCount: directories.length,
    returnedCount: page.length,
    indexLastUpdated: Date.now(),
    isIndexedResponse: false,
  };
}

const PALETTES = [
  ['#0ea5e9', '#6366f1'], ['#d946ef', '#f43f5e'], ['#14b8a6', '#0ea5e9'], ['#f59e0b', '#ef4444'],
  ['#8b5cf6', '#ec4899'], ['#22c55e', '#06b6d4'], ['#64748b', '#0f172a'], ['#f97316', '#a855f7'],
];

function svgFor(id) {
  const h = hash(id);
  const shape = h % 7;
  const [w, hgt] = shape === 0 ? [1800, 1200] : shape === 1 ? [1080, 1920] : [1200, 1800];
  const [c1, c2] = PALETTES[h % PALETTES.length];
  const parts = id.split('/');
  const file = parts.pop();
  const dir = parts.slice(-1)[0] || '根目录';
  const num = file.replace(/\.[^.]+$/, '');
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const cx = 200 + (h % (w - 400));
  const cy = 200 + ((h >> 8) % (hgt - 400));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
<radialGradient id="r"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${cx}" cy="${cy}" r="${Math.min(w, hgt) * 0.35}" fill="url(#r)"/>
<path d="M0 ${hgt * 0.78} Q ${w * 0.3} ${hgt * 0.62} ${w * 0.55} ${hgt * 0.74} T ${w} ${hgt * 0.7} V ${hgt} H 0 Z" fill="#020617" fill-opacity=".35"/>
<text x="50%" y="46%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(Math.min(w, hgt) * 0.22)}" font-weight="700" fill="#fff" fill-opacity=".92">${esc(num)}</text>
<text x="50%" y="56%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(Math.min(w, hgt) * 0.045)}" fill="#fff" fill-opacity=".85">${esc(dir)}</text>
<text x="50%" y="61%" text-anchor="middle" font-family="monospace" font-size="${Math.round(Math.min(w, hgt) * 0.03)}" fill="#fff" fill-opacity=".6">${w}×${hgt} · mock</text>
</svg>`;
}

export function createMockImgbed({ delayMs = 0 } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (url.pathname === '/api/manage/list') {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
      if (token !== MOCK_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        return res.end('You need to login');
      }
      if (url.searchParams.get('action')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('mock: action should never be forwarded by the gallery');
      }
      let dir = (url.searchParams.get('dir') || '').replace(/^\/+/, '');
      if (dir && !dir.endsWith('/')) dir += '/';
      const start = parseInt(url.searchParams.get('start'), 10) || 0;
      const count = parseInt(url.searchParams.get('count'), 10) || 50;
      if (delayMs) await wait(delayMs);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(list(dir, start, count)));
    }
    if (url.pathname.startsWith('/file/')) {
      const id = decodeURIComponent(url.pathname.slice('/file/'.length));
      if (!DATA.some((f) => f.id === id)) {
        res.writeHead(404);
        return res.end('Error: Image Not Found');
      }
      if (delayMs) await wait(delayMs + (hash(id) % 200));
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=2592000',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(svgFor(id));
    }
    res.writeHead(404);
    res.end('Not Found');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_IMGBED_PORT || 18787);
  createMockImgbed({ delayMs: Number(process.env.MOCK_DELAY || 0) }).listen(port, '127.0.0.1', () => {
    console.log(`mock ImgBed listening on http://127.0.0.1:${port}  token=${MOCK_TOKEN}`);
  });
}
