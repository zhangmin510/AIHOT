# 本地生成内容，发布到 Cloudflare

正式工作流是：**本地采集与生成 → 本地审阅 → 导出公开快照 → 构建并发布到 Cloudflare**。`b.zhangmin.name` 使用一个 Worker 提供 React Router SSR 和内存快照 API，浏览器静态资源由 Workers Assets 提供。数据库、模型服务和 worker 采集任务留在本机；Cloudflare 端不需要 PostgreSQL、业务后台、模型密钥或管理员密码。

这是匿名公开的只读预览。`noindex` 用于避免搜索引擎收录，不是访问控制。网站、RSS、REST API 和 MCP 读取同一份公开快照；管理、登录、写入和反馈提交关闭，收藏保存在读者自己的浏览器。

## 数据与边界

- 导出命令只从 `.env.local` 取 `DATABASE_URL`，目标必须是 `127.0.0.1:55432/evalfrontier_local`。测试库、CI 库、未知来源和 fixture 标记会导致导出失败。
- 导出全程使用 PostgreSQL 只读事务，只允许连接这一本机端口，阻断 HTTP、DNS 和子进程；采集、模型、飞书和 IndexNow 安全阀保持关闭。
- 数据来自现有公开读取层的 DTO。未获授权的原文正文、内部分析、调用回执、预算、凭据和数据库配置不会进入快照。本部署的信源没有全文许可，导出遇到正文或 X 原文会直接拒绝；搜索仅使用公开标题、摘要、来源名称和展示标签。
- 完整动态集合通过公开读取层游标导出；网站列表仍保留 50 页 / 2,000 条的浏览上限，筛选、搜索与 API 使用完整集合。报告索引保留最近 400 期，旧刊沿上一期 / 下一期关系补齐，启用的周/月 API 各支持最多 180 期。日报停用，旧日报页面跳到周报，旧 API 和 RSS 返回 404。
- 快照格式 2 将重复的时间线卡片存为共享索引，查询时再组装分页响应；同一卡片在不同筛选下的来源数、进展数保持独立。HTTP 响应不变，读取器仍支持格式 1 的旧快照与回滚版本。
- 完全相同的固定 HTTP 响应通过别名共享，比较包括状态、内容类型、正文和响应头。API、MCP、资源准备和验证工具使用同一读取函数；别名只能直接指向已存响应，启动时拒绝循环、链、悬空引用和覆盖原路径。
- `.data/cloudflare-preview/snapshot.json` 只编译进服务器包，不复制到 `apps/web/build-cloudflare/client/`。不要把整个 `.data/`、仓库目录或 `.env*` 上传为静态资产。
- 品牌、来源标识和分享图由 `scripts/prepare-cloudflare-assets.ts` 离线准备。短期有效的图片代理链接会移除并使用界面占位；不会下载第三方媒体。
- 首版的历史基线是129个公开详情，内容更新停留在2026-10-02。后续版本的实际内容量、报告和榜单状态以各版本保存的快照与验证记录为准；重新导出不会把旧资料变成新资讯。

## 手动构建和本地验证

需要 Node.js 24、项目依赖和已启动的本地 PostgreSQL。以下命令不启动采集任务，也不调用模型。

本地采集、模型预算、worker 配置和运维沿用[运行与部署](../../docs/deploy.md)、[本地站点及真实内容依赖](../../docs/eval-frontier.md#信源与真实内容依赖)、[信源配置](../../docs/sources.md)。采集和模型生成须先在本地单独完成；下面的发布命令不会代替这一步，也不会把本地处理进程搬到 Cloudflare。

```bash
npm run preview:build
npm run preview:check
npm run preview:dry-run
npm run preview:dev
```

`preview:build` 依次执行公开快照导出、Cloudflare 专用 Web 构建和白名单静态资源准备。单独刷新数据可运行 `npm run preview:export`，但上线前仍需完成整个构建，确保页面、API 和分享图对应同一份快照。

内容仍在生成时，只读容量审查可运行 `node scripts/export-cloudflare-preview.ts --out .data/cloudflare-preview/capacity/in-progress.json`。该选项只允许容量目录，产物带 `capacityOnly` 标记，不能用于发布或静态资源准备；最终发布仍需重新执行默认导出和完整构建。

保持本地预览进程运行，在另一个终端执行：

```bash
npm run preview:smoke -- --base http://127.0.0.1:8794
```

核对首页、搜索、分类组合、详情、事件、主题、RSS、REST、MCP 和静态图片；同时确认管理与写入入口不可用。`X-Preview-Snapshot` 应与快照的 `generatedAt` 一致。

默认 `--coverage full` 会验证所有导出详情、固定响应和分享图。本地全量通过后，跨到云端候选版本时可显式使用 `--coverage representative`，避免再次下载全部图片。该模式是**抽样验收，不是公网全量**：文章按栏目、分类、精选状态和阅读模式分组，固定响应按路由族、状态、内容类型及查询参数组合分组，详情页和图片按类型分组；各组保留最小、最大及可用时间的新旧边界，没有时间字段时以稳定路径顺序取边界。图片大小来自本地已经锁定的静态目录，因此该目录必须与目标快照一致。

抽样模式保留全部公共页面入口、榜单类别与过滤断言、完整列表 / 搜索 / 时间线 / 精选分页、RSS、十个 MCP 工具、ETag、CORS、404、只读模式与写入封锁检查；快照中的正文许可和报告 / 榜单引用闭合检查仍覆盖全部记录。输出明确记录 `coverage`、实际请求数以及每个抽样集合和分组的总数 / 样本数。样本数随数据类型增加，不通过硬截断牺牲路由或状态覆盖。

只使用 Workers 免费方案。按 [Cloudflare 当前限制](https://developers.cloudflare.com/workers/platform/limits/#worker-size)（2026-11-04 核验），Worker 包上限为 **64 MiB 未压缩**，已没有旧版 3 MiB gzip 限制；每个 isolate 的内存上限仍为 **128 MB**，并发请求共享这份内存。静态资产不占 Worker 包体积，免费方案最多 20,000 个文件，单文件最多 25 MiB。

该页面的 Worker size 原文为：“There is no compressed size limit. Only the uncompressed bundle size counts.” 页面更新时间为 2026-10-29；其中 `Total Upload` 是未压缩大小，gzip 数值仅供参考。

每次数据增长后核对 dry-run 的未压缩包体积、启动时间、静态文件数量，并在实际 workerd 上运行并发搜索、报告和模型详情验证。快照文本大小或 gzip 大小不能代表运行时堆占用，JSON 解析、索引和 SSR 都需要额外内存。如超出免费限制，先优化快照存储；仍不满足则停止发布，不自动升级套餐、添加付费数据库或开启自动采集。

## 发布与保存版本

`wrangler.jsonc` 已配置 Worker 名称 `evalfrontier-preview` 和自定义域名 `b.zhangmin.name`。Cloudflare 认证在发布工具自己的认证配置中管理，不应放入 `wrangler.jsonc`、`vars`、前端或快照。

项目的 Wrangler npm 脚本均设置 `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` 并使用 `--env-file /dev/null`，防止 Wrangler 自动把本机 `.env.local` 加载为云端变量。手工使用 Wrangler 时也要保留这两个设置。

完成本地验证后发布：

```bash
npm run preview:deploy
npm run preview:smoke -- --base https://b.zhangmin.name
```

数据明显增长时，先使用[版本定向验证](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)检查实际云端资源限制。上传版本后，将旧版本保留100%流量、新版本设为0%，验证请求通过指定头访问候选版本；smoke每个请求仍校验快照时间，避免误把旧版本当作验证通过。

```bash
export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
export WRANGLER_SEND_METRICS=false
./node_modules/.bin/wrangler versions upload --env-file /dev/null
# 使用上传输出和当前deployment中的真实版本ID替换下面的OLD_ID/NEW_ID。
./node_modules/.bin/wrangler versions deploy OLD_ID@100 NEW_ID@0 --yes --env-file /dev/null
npm run preview:smoke -- --base https://b.zhangmin.name --version-override evalfrontier-preview=NEW_ID
./node_modules/.bin/wrangler versions deploy NEW_ID@100 --yes --env-file /dev/null
```

此模式不需要开放额外预览域名。验证失败时保留旧版本服务；候选通过后再切换，并使用普通请求确认正式域名快照已更新。

若同一快照已经完成本地全量，可将候选验证命令改为：

```bash
npm run preview:smoke -- --base https://b.zhangmin.name --version-override evalfrontier-preview=NEW_ID --coverage representative
```

数据规模接近内存上限时，还应对搜索、最大模型 / 来源详情等大页面做并发请求验证；抽样通过本身不证明所有数据或云端资源上限安全。

保存部署输出中的版本 ID，并在本地忽略目录 `.data/cloudflare-preview/releases/<版本ID>/` 留存该版本的 `snapshot.json`、`wrangler.jsonc` 与验证结果。版本标识应同时记录快照的 `generatedAt` 和 `contentHash`，便于确认线上正在提供哪批公开数据。不要把这份本地目录提交到 Git。

部署命令会更新线上 Worker 与域名服务；首次使用前需确保当前 Cloudflare 账户对目标域名有权限。这里没有定时刷新、自动采集或持续部署。

## 更新、撤稿与回滚

本地内容发生变化后，重新执行 `preview:build`、`preview:check`、`preview:dry-run`、本地 smoke，再发布并进行线上 smoke。只修改本地数据库不会改变已经发布的快照。

撤稿也必须重新导出并发布。检查详情是否返回 404，以及列表、相关事件、报告、搜索、RSS、API 和 MCP 是否同步移除或隐藏对应内容；还需等待或清理旧 HTTP 缓存。旧部署可能仍包含已撤内容，不要回滚到这种版本。

查看版本和回滚到已验证的版本：

```bash
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false \
  ./node_modules/.bin/wrangler deployments list --env-file /dev/null

CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false \
  ./node_modules/.bin/wrangler rollback <版本ID> --env-file /dev/null
```

回滚后使用对应版本保留的快照进行验证：

```bash
npm run preview:smoke -- --base https://b.zhangmin.name \
  --snapshot .data/cloudflare-preview/releases/<版本ID>/snapshot.json
```

回滚不会改动本机数据库。确认页面、API 和静态资源都恢复为目标版本后，再安排下一次正常构建。
