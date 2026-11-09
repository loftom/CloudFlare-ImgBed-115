# 私人图库（gallery/）

一个只读的私人图库前端：浏览 ImgBed（本仓库，线上 `loftom-imgbed.pages.dev`）里的目录（GE / HC / BBB …），
以 **目录墙 → 套图网格 / 竖向阅读 → 灯箱** 的方式看图。单独部署为一个新的 Cloudflare Pages 项目（如 `loftom-gallery`），
**不改动 ImgBed 本体和它的部署**。界面风格借自 115Deck（毛玻璃侧栏、AlbumCard 海报墙、VerticalReader、Lightbox、QueuedImage 排队加载）。

技术栈：Vite 5 + React 18 + TypeScript + Tailwind 3 + react-router 6，服务端是 `functions/` 下的 Pages Functions。

## 功能

- **目录墙**：面包屑导航；每个子目录一张 2:3 海报卡，封面 = 该目录按上传顺序的第一张图（目录下没有直接图片时沿第一个子目录往下找，最多 3 层）；卡片接近视口才请求封面，封面接口与图片加载都有并发上限。子目录多时分批渲染（每批 48 张）。
- **套图页**：三列网格；「竖向阅读」模式（`?view=reader`，J/K 或 ←/→ 跳张，Esc 返回）；灯箱（←/→/空格/PageUp/PageDown 翻页，Home/End，Z 或双击缩放，Esc 关闭，触屏左右滑），预取前后相邻图，翻到已加载末尾会自动拉下一页。
- **大目录**：文件每页 60 条，无限滚动（也可点「加载更多」）；ImgBed 一次返回全部子目录（上限 500）。
- **排序**：侧栏可切换「上传顺序」（默认，套图从 001 开始）/「最新在前」；并发加载数可调（默认 4）。
- **原图直出**：不做 CF Images 缩放，缩略图就是原图，靠懒加载 + 并发队列控制带宽。

## 目录结构

```
gallery/
├── functions/                 # Cloudflare Pages Functions（只在服务端运行）
│   ├── _lib/common.js         # 参数清洗、调用 ImgBed 列表接口、字段白名单、分页/排序
│   ├── _lib/access.js         # 可选：校验 Cloudflare Access JWT（WebCrypto + 团队 JWKS）
│   ├── api/_middleware.js     # /api/* 只允许 GET/HEAD + Access 校验
│   ├── api/list.js            # GET /api/list   目录分页列表
│   ├── api/cover.js           # GET /api/cover  目录封面
│   ├── api/config.js          # GET /api/config 前端配置（图片基址，不含 Token）
│   ├── file/_middleware.js    # /file/* Access 校验
│   └── file/[[path]].js       # 可选：同源图片代理（IMAGE_PROXY=true 才启用）
├── public/_routes.json        # 只让 /api/* 和 /file/* 走 Functions，静态资源不计 Functions 调用
├── public/_headers            # 安全头、静态资源长缓存
├── src/                       # React 前端
│   ├── components/            # Sidebar、Breadcrumbs、AlbumCard、ImageGrid、VerticalReader、Lightbox、QueuedImage…
│   ├── lib/                   # api、imageQueue（并发队列）、useDirectory（分页）、useNearViewport…
│   └── pages/DirectoryPage.tsx
├── mock/imgbed-mock.mjs       # 本地 mock ImgBed（/api/manage/list + /file/*，SVG 占位图）
├── mock/pages-shim.mjs        # 本地开发：在 Vite 里按 Pages 约定执行 functions/ 的真实代码
├── scripts/test-functions.mjs # Functions 自测（无需外网）
└── scripts/check-bundle.mjs   # 构建后检查 dist 不含 Token / manage 接口字符串
```

## 架构与安全

```
浏览器（Cloudflare Access 之后）
  ├─ GET /api/list|cover|config ──► Pages Functions ──(Authorization: Bearer IMGBED_LIST_TOKEN)──► ImgBed /api/manage/list
  └─ <img src="https://loftom-imgbed.pages.dev/file/<path>">  （默认直连；可选改走同源 /file/* 代理）
```

- 浏览器 bundle 里 **没有** 管理员密码，也没有任何 Token。Token 只存在于 Pages 项目的加密环境变量 `IMGBED_LIST_TOKEN` 中，`npm run build` 会自动扫描 `dist/`，发现 `imgbed_…`、`IMGBED_LIST_TOKEN`、`/api/manage/`、`Bearer ` 等字符串就直接构建失败。
- 代理只做「列目录」：上游路径写死为 `/api/manage/list`，只转发 `dir` / `start` / `count` 三个参数（**绝不转发 `action`、`search` 等**），所以拿不到 ImgBed 的重建索引之类操作。`dir` 会做清洗：去掉多余斜杠，拒绝 `.`/`..` 段、反斜杠、控制字符和超长输入；`count` 上限 200。
- 上游偶发 5xx、429、网络错误，或正文出现 `D1 DB is overloaded` 时，Function 会按约 300ms / 800ms / 1.6s（带抖动）重试，最多 3 次；401/403 和其它 4xx 不重试。成功的上游列表 JSON 写入 Cache API（`caches.default`）约 5 分钟。缓存键只有规范化后的 `dir` / `start` / `count`，不含 Cookie、Access JWT 或上游 `Authorization`。Access 校验在读缓存之前完成，错误响应不缓存。返回给浏览器的 `/api/list` 是 `private, max-age=300, stale-while-revalidate=600`，`/api/cover` 是 `private, max-age=86400`。
- 返回给浏览器的字段是白名单：`path / name / kind / ts / size / blocked`，ImgBed 元数据里的渠道、TG ChatId、上传 IP 等一律丢弃。
- 可选 `ALLOWED_DIRS` 把可浏览范围限制在若干顶层目录。
- 可选 Access JWT 校验：配置 `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` 后，`/api/*` 和 `/file/*` 会校验 `Cf-Access-Jwt-Assertion`（或 `CF_Authorization` Cookie）的 RS256 签名、`aud`、`exp`、`iss`，可再用 `CF_ACCESS_ALLOWED_EMAILS` 限定邮箱。Access 本来就在边缘拦截，这一层是纵深防御（防止有人绕过 Access 直接打 `*.pages.dev` 的预览域名等）。

### ImgBed 列表接口的鉴权（以代码为准）

| 项目 | 结论 | 代码出处 |
|---|---|---|
| 接口 | `GET /api/manage/list?dir=<目录>&start=<偏移>&count=<条数>` | `functions/api/manage/list.js` |
| 鉴权中间件 | 所有 `/api/manage/*` 走 `authenticate({ authScope: ADMIN, requiredPermission })`；`/api/manage/list`（以及 `/api/manage/list/*`、`/api/manage/batch/list`）需要的权限是 **`list`**，删除是 `delete`，其余是 `manage` | `functions/api/manage/_middleware.js` 的 `extractRequiredPermission()` |
| Token 校验顺序 | API Token 优先，通过即视为管理员身份；不通过再看管理员会话 | `functions/utils/auth/authCore.js` 的 `authenticate()` |
| 请求头 | `Authorization: Bearer <token>`（也接受不带 `Bearer ` 的裸 token） | `functions/utils/auth/tokenValidator.js` 的 `validateApiToken()` |
| Token 格式 | `imgbed_` + 64 位十六进制 | `functions/api/manage/apiTokens.js` 的 `generateApiToken()` |
| 权限取值 | `permissions` 数组，前端可选 `upload` / `delete` / `list` / `manage`；校验是 `permissions.includes('list')`，并检查 `expiresAt` 是否过期 | `tokenValidator.js`；`apiTokens.js`（存在 `manage@sysConfig@security` 的 `apiTokens.tokens` 里） |
| 返回结构 | `{ files:[{name, metadata}], directories:[完整子目录路径，不带结尾 /], totalCount, directFileCount, directFolderCount, returnedCount, countsUnavailable? }`；文件按 `timestamp DESC, id ASC` 分页，只含直接文件；子目录一次全返回、排序、上限 500 | `list.js`；`functions/utils/d1Database.js` 的 `queryDirectoryListing` / `buildDirectoryFileQuery` / `listChildDirectories`（`MAX_CHILD_DIRECTORIES = 500`） |

注意：带 `list` 权限的 Token 在 ImgBed 侧也能调用 `/api/manage/list?action=rebuild|merge-operations|delete-operations|info|index-storage-stats`（`list.js` 没有对 action 再分权限）。本代理永远不转发 `action`，但 **Token 本身仍要当密钥保管**。另外 ImgBed 每次处理列表请求都会顺带清理一批已到期文件（`maybeCleanupExpiredFiles`），这是 ImgBed 自身行为。

### 图片加载方式：默认浏览器直连 ImgBed `/file/*`

ImgBed 的 `/file/<path>` 对普通读取 **不需要登录**（`functions/file/[[path]].js` 只有带 `?from=admin` 时才鉴权），并且会返回 `Access-Control-Allow-Origin: *`。所以默认让 `<img>` 直接加载 `${IMGBED_ORIGIN}/file/<path>`：

- 优点：不占 Pages Functions 调用次数和 CPU；Range、CDN 缓存、ImgBed 自己的缓存策略原样生效；对 TG 存储的大图不多一跳。
- `<img>` 不需要 CORS，`/api/config` 只把公开的 ImgBed 地址告诉前端。
- 前端对所有图片设置 `referrerPolicy="no-referrer"`。ImgBed 的「放行域名」（`allowedDomains`）只在请求 **带了 Referer** 时才检查（`functions/file/fileTools.js` 的 `isDomainAllowed()`），不发 Referer 就不会被当成盗链。如果你更愿意显式放行，可以在 ImgBed「系统设置 → 安全设置 → 放行域名」里加上图库域名，再把代码里的 `no-referrer` 去掉。
- 影响：**图片本身不受 Cloudflare Access 保护**，知道 URL 的人仍能直接打开（与现在的 ImgBed 一样）；Access 只保护图库页面和列表接口。被 ImgBed 标成 `Block` 或 `adult` 的文件、以及开启「白名单模式」时未加白的文件，`/file` 会返回拦截图（网格上会显示「受限」角标）。

**可选：同源代理**（`IMAGE_PROXY=true`）。图片改走图库自己的 `/file/*` Function 转发到 ImgBed（只转发 GET/HEAD 及 Range / If-None-Match 等头，不附带 Token、不带 Referer）。适用于以后把 ImgBed 的 `/file` 也放进 Access、浏览器不能直连的情况——这时图库的 Function 需要能访问 ImgBed（例如给 ImgBed 的 Access 应用加一条 Service Token 放行规则，并在代理里附带 `CF-Access-Client-Id/Secret` 头，目前代码 **没有** 实现这一步）。代价是每张图都算一次 Functions 调用，且大文件多一跳。

## 环境变量

| 变量 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `IMGBED_ORIGIN` | 是 | 明文 | ImgBed 地址，如 `https://loftom-imgbed.pages.dev`（只取 origin，必须 https） |
| `IMGBED_LIST_TOKEN` | 是 | **Secret** | ImgBed 后台创建的、只勾了「列出」权限的 API Token（`imgbed_…`） |
| `ALLOWED_DIRS` | 否 | 明文 | 逗号分隔的可浏览目录，如 `GE,HC,BBB`；为空不限制 |
| `IMAGE_PROXY` | 否 | 明文 | `true` 时图片走同源 `/file/*` 代理，默认 `false`（直连） |
| `CF_ACCESS_TEAM_DOMAIN` | 否 | 明文 | Zero Trust 团队域名，如 `yourteam.cloudflareaccess.com`（也可只写 `yourteam`） |
| `CF_ACCESS_AUD` | 否 | 明文 | Access 应用的 Application Audience (AUD) Tag；与上一项同时配置才启用 JWT 校验 |
| `CF_ACCESS_ALLOWED_EMAILS` | 否 | 明文 | 逗号分隔的邮箱白名单（JWT 校验通过后再比对 `email`） |
| `GALLERY_TITLE` | 否 | 明文 | 页面标题，默认「私人图库」 |

## 在 ImgBed 后台创建只读（list-only）Token

1. 以管理员登录 ImgBed（`https://loftom-imgbed.pages.dev`）→ **系统设置 → 安全设置 → API Token 管理**，点右侧「+」（创建新 API Token）。
2. 名称随意（如 `gallery-list`）；**权限只勾「列出」**，不要勾上传 / 删除 / 管理；过期时间按需（可选永不过期）。
3. 创建后弹窗里会显示完整 Token（`imgbed_` 开头），立刻复制；之后列表里只显示前 15 位。
4. 自测（只读，不会改任何东西）：
   ```bash
   curl -s -H "Authorization: Bearer imgbed_xxx" "https://loftom-imgbed.pages.dev/api/manage/list?dir=GE&count=1" | head -c 300
   # 再验证它确实没有 manage 权限（应返回 401 You need to login）：
   curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer imgbed_xxx" "https://loftom-imgbed.pages.dev/api/manage/sysConfig/security"
   ```

## 部署为独立的 Pages 项目

在 `gallery/` 目录下执行（Functions 来自 **当前目录** 下的 `functions/`，所以一定要在 `gallery/` 里运行）：

```bash
cd gallery
npm ci && npm run build                      # 产物在 dist/，构建会顺带检查 bundle 不含 Token

npx wrangler login                           # 首次
npx wrangler pages project create loftom-gallery --production-branch main

# 环境变量：Token 用 secret；其他变量也可以用 secret put，或在 Dashboard → loftom-gallery → 设置 → 变量和机密 里添加
npx wrangler pages secret put IMGBED_LIST_TOKEN --project-name loftom-gallery
npx wrangler pages secret put IMGBED_ORIGIN     --project-name loftom-gallery   # 输入 https://loftom-imgbed.pages.dev

npx wrangler pages deploy dist --project-name loftom-gallery --branch main
```

- `wrangler pages deploy` 会自动把 `./functions` 编译成 Worker 一起上传；`dist/_routes.json`（来自 `public/`）限定只有 `/api/*`、`/file/*` 走 Functions，其余是静态文件（单页应用的 `/d/...` 路由由 Pages 自动回落到 `index.html`）。
- 环境变量修改后需要重新部署一次才生效。预览分支（`--branch xxx`）用的是 Preview 环境变量，要单独配置。
- 也可以用 Git 集成：新建 Pages 项目连接本仓库，**根目录设为 `gallery`**，构建命令 `npm ci && npm run build`，输出目录 `dist`。注意不要动 ImgBed 原来的 Pages 项目。

## Cloudflare Access（只放行自己的邮箱）

1. Cloudflare Dashboard → **Zero Trust → Access → Applications → Add an application → Self-hosted**。
2. 应用域名填 `loftom-gallery.pages.dev`；建议再加一条 `*.loftom-gallery.pages.dev`，把预览部署也挡住（或在 Pages 项目「设置 → 常规 → 启用访问策略」只保护预览）。如以后绑定自定义域名，也要加进来。
3. Policy：Action = Allow，Include → Emails → 填你自己的邮箱；登录方式用 One-time PIN 或已接入的 IdP。
4. 保存后在应用的 Overview 里复制 **Application Audience (AUD) Tag**，团队域名在 Zero Trust → Settings → Custom Pages 里能看到（`<team>.cloudflareaccess.com`）。
5. （可选纵深防御）在 Pages 项目里设置 `CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`（可再加 `CF_ACCESS_ALLOWED_EMAILS`），重新部署。之后没有合法 Access JWT 的请求打到 `/api/*` 会得到 403。

## 本地开发（mock 模式，无需外网）

```bash
cd gallery
npm ci
npm run dev            # http://127.0.0.1:5173
```

- `npm run dev` 会在 `127.0.0.1:18787` 起一个 mock ImgBed（实现了 `/api/manage/list` 的 Bearer Token 校验和 D1 的分页/排序语义，`/file/*` 返回本地生成的 SVG 占位图），并在 Vite 里按 Pages 约定执行 `functions/` 的 **真实代码**（中间件链、`onRequestGet`、`[[path]]` 参数）。
- mock 数据：`GE`（18 套）、`HC`（12 套）、`BBB`（4 个合集 × 10 套，`超大合集/全集 1500P` 测分页，`海量套图` 240 个子目录测目录墙分批）。
- 可调：`MOCK_DELAY=300 npm run dev`（模拟慢速网络）、`IMAGE_PROXY=true npm run dev`（测同源代理）、`ALLOWED_DIRS=GE,BBB npm run dev`。
- `npm test`：先跑 vitest（上游重试 / 缓存键 / 前端列表重试），再跑 `npm run test:functions`（路径清洗、asc/desc 分页、ALLOWED_DIRS、Token 错误、封面查找、代理开关、Access JWT 的各种通过/拒绝情形）。
- 连真实 ImgBed 联调：`cp .dev.vars.example .dev.vars` 填好后 `npm run build && npx wrangler pages dev dist`（`.dev.vars` 已被 gitignore）。

## 已知限制

- **排序**：ImgBed 只支持按上传时间倒序分页。「上传顺序」是用 `directFileCount` 反算窗口再倒序得到的，翻页时会把总数带回服务端以省一次请求；同一时间戳内按文件名自然排序（仅页内）。ImgBed 计数不可用（D1 过载，`countsUnavailable`）时会自动退回「最新在前」并提示。
- **子目录上限 500**：ImgBed 的子目录查询上限是 500，超过的子目录不会出现。
- **封面开销**：每张目录卡片的封面需要 1–2 次（无直接图片时最多 8 次）上游列表请求。封面接近视口才请求，同时最多 2 个，失败只显示占位、不拖垮整页；浏览器缓存一天。列表在浏览器侧失败后再试 2 次。服务端对成功的上游列表另有约 5 分钟的 Cache API 缓存。
- **原图做缩略图**：未开 CF Images 缩放，网格里加载的是原图，流量较大；并发队列和懒加载能保证首屏优先，但大目录快速滚动仍会比较耗流量。
- 只显示图片；视频和其他文件只计数不展示。
- 文件名里含 `%`、`,` 的路径在 ImgBed `/file` 侧本身就可能解析异常（它把路径段用逗号拼接后再 decode），图库不做额外处理。
