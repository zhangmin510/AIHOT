# 评测前沿：本地首版

基于 AIHOT 开源框架，保留 MIT 许可、NOTICE 和原作者数字生命卡兹克署名。本站聚焦大模型、Agent 与应用评测；没有发布本站实测，也没有导入示例榜单成绩。

## 启动

需要 Node.js 24.11+ 和专用的本地 PostgreSQL 数据库。常规安装可先创建 `evalfrontier_local`（仓库部署文档使用 PostgreSQL 16/17），然后运行：

```bash
npm ci
npm run local:init -- --database-url postgres://127.0.0.1:5432/evalfrontier_local
npm run local:setup
npm run local:start
```

访问 http://localhost:3000，管理入口 `/admin`，随机管理员密码在 `.env.local`。`local:init` 不覆盖已有文件；`local:setup` 迁移专用数据库、导入信源和主题并构建；`local:start` 只启动 API 与 SSR 网页，强制关闭采集、模型、飞书通知和 IndexNow，不启动 worker。Ctrl+C 停止 API 与网页。

本次电脑验证使用 `/tmp/eval-frontier-pg` 的隔离 PostgreSQL，端口 `55432`，数据库为 `evalfrontier_local` 与独立的 `*_test`，没有连接用户现有数据库。当前 `.env.local` 已指向该临时实例。临时实例停止或 `/tmp` 被清理后，需要按上面的常规方式重新提供数据库并更新 `.env.local`。不要把本次测试实例当成生产数据库。

## 首版范围

- 栏目键统一为 `ai-models`（大模型）、`agent`（Agent）、`ai-products`（应用评测），网页/API/RSS/MCP 共用行业分类。论文与方法按评测对象归栏。已有旧分类的内容需要运营者另行审核/重新归类，本次不迁移已有业务数据。
- `/methodology` 说明四类证据与复现检查项。信息流仅展示存储标签中明确存在的“厂商声明”“第三方评测”“可复现方法”；未标注时不推断。模型标签仍可能错误，页面提示回到原文核对。自动标签白名单禁止“本站实测”。
- `/leaderboard` 保留原多源共识算法与来源页，标明外部榜单聚合；缺测不补零，不编造本站成绩。没有已发布计算结果时返回 503 并显示暂无可用榜单。
- 复用采集、判重、两次评分、事件聚类、日报和 `publication/` 公开读取层。页面只读取已发布结果，不触发模型。
- 原五维评分、类型权重和 T1 60 / T1_5 65 / T2 76 门槛不变。替换读者定位、重要信息和噪声例子；上线前仍需用人工标注样本校准。
- Codex 额度监控关闭。使用规则与隐私页明确为待运营者确认的模板。

## 信源与真实内容依赖

初始包含 18 个信源，以官方和研究来源为主。新加入 Anthropic News、METR、Epoch AI、arXiv cs.AI/cs.LG、Inspect AI 和 SWE-bench GitHub Releases。原有媒体示范源不再默认导入，保留 Simon Willison 作为独立实践来源。

新增官方网页的真实解析已检查：Anthropic 10 条、METR 24 条、Epoch 8 条。全部 15 个 RSS 已通过现有解析器只读检查（包括 arXiv cs.AI/cs.LG、Inspect AI、SWE-bench），均返回非空候选。网络、反爬和上游改版仍可能影响可用性。网页选择器需要维护；只有日期的记录不是精确发布时间，Epoch 列表无日期时交由详情提取，缺失时保持未知。

官方入口：[Anthropic](https://www.anthropic.com/news)、[METR](https://metr.org/blog/)、[Epoch AI](https://epoch.ai/latest)、[arXiv](https://rss.arxiv.org/rss/cs.AI)、[Inspect AI Releases](https://github.com/UKGovernmentBEIS/inspect_ai/releases)、[SWE-bench Releases](https://github.com/SWE-bench/SWE-bench/releases)。

`scripts/seed.ts` 仍使用 `ON CONFLICT (id) DO NOTHING`，仅新增缺失信源，不覆盖数据库中的频率、启用状态、权限或后台编辑。对已有站点，移除 JSON 中的源不会删除或停用数据库中的源；运营者应在后台单独审核。主题按原框架行为更新。

真实精选、日报和聚类需要 PostgreSQL、可访问的信源、OpenAI 兼容模型 Key 和后台 worker。模型榜还需要上游公开评测数据与原模块所需的计算环境。X、公众号及 Jina 是可选付费依赖，首版未配置或运行。要产生真实内容，需运营者另行确认后配置预算与安全阀，按 `docs/deploy.md` 启动 worker；不要使用安全本地启动命令开启付费处理。本次只读信源检查没有入库或调用模型。

## 验证

```bash
npm run typecheck
# 新建空 *_test 数据库，先迁移。不要重用带失败测试残留的数据库。
DATABASE_URL=postgres://.../evalfrontier_test node scripts/migrate.ts
DATABASE_URL=postgres://.../evalfrontier_test npm test
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
node scripts/smoke.ts --base http://localhost:3000
```

仓库没有 lint 脚本或 ESLint 配置，使用类型检查、测试及 `git diff --check`。后端测试的模型开关只在测试进程内开启，接口指向测试自建的 localhost 假服务，通知阀关闭；无真实外部模型调用。运行结果与截图见本任务的验证报告。

上线前待确认：运营主体与联系方式、使用规则和隐私说明、人工标注样本校准、信源许可/可用性，以及首次真实采集与榜单计算。代码交付使用用户授权的 `eval-frontier` 分支；首版未部署、未合并 main。代码推送不代表手机可访问的公网部署已完成。
