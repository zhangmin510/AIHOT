# 评测前沿完整预览部署

此材料尚未对外部署。已确认项目原生支持 Docker Compose、PostgreSQL 17、Fastify API、React Router SSR 和 Caddy HTTPS；本机 Docker 客户端可用，OrbStack 守护进程未运行，没有发现可确定的公网目标。先确定已有服务器/域名，或明确授权电脑临时公网预览。不得把 `/tmp` 测试数据库作为部署数据库。

部署准备验证：类型检查与网页生产构建通过；前端 SSR 19/19（含预览提示、noindex 和法律模板隐藏回归）；普通及 HTTPS profile 的 Compose `config --quiet` 均通过，默认服务只有 db/setup/api/web，无 worker。由于尚无目标，未创建真实部署凭证、数据库卷、容器或公网地址；未完成镜像/Caddy 运行验证及外部 HTTPS/手机检查。

## 必要确认

- 已有目标：可用 SSH 别名/主机、项目目录、域名及 DNS 控制权，确认目标为本项目授权范围。不要在聊天发送秘密。
- 持久凭证：批准为此独立部署生成并保存数据库密码、会话与图片签名密钥、管理员密码，或指定已授权的秘密注入方式。模板不是真实凭证；本次未生成部署凭证。
- 费用：仅使用已有资源；资源购买、订阅隧道或新增付费服务另行确认。电脑临时预览需要持续在线，不承诺公网 SLA。
- 正式发布：确认运营主体、联系方式、使用规则及隐私文本。预览模式不展示原法律模板，只显示尚未确认的状态。

## 已准备的完整应用

`deploy/compose.preview.yml` 使用独立的 `evalfrontier-preview` Compose 项目、镜像和三个持久卷；不复用原项目数据库或卷，不含 worker。PostgreSQL 和 API 不映射主机端口，网页默认映射 `127.0.0.1:3100`。预览始终关闭采集、模型、飞书与 IndexNow 安全阀。无需模型 Key。

`AIHOT_PREVIEW=true` 会在网页显示预览提示，`/terms`、`/privacy` 隐藏未经确认的法律模板，HTTP 响应带 `X-Robots-Tag: noindex, nofollow`。独立 Caddy 配置另外阻止公网后台、认证与反馈提交入口；运营者从本机受控入口管理。不会把管理员密码提供给手机访客。

模板为 `deploy/preview.env.example`。经批准后在目标工作目录创建权限 0600 的 `.env.preview`，按模板注入真实专用凭证并填写实际 HTTPS `SITE_URL` / `SITE_DOMAIN`。本项目 `.gitignore` 与 `.dockerignore` 排除该文件；不要在终端打印它，不要用会展开秘密的 `docker compose config`，使用 `config --quiet`。

在不影响其他项目的目录执行：

```bash
docker compose --env-file .env.preview -f deploy/compose.preview.yml config --quiet
docker compose --env-file .env.preview -f deploy/compose.preview.yml up -d --build db setup api web
```

先检查已有 80/443/3100 监听与容器、反向代理站点，不抢占端口。若目标已有 Nginx/Caddy，增设此域名的独立虚拟主机代理到 `127.0.0.1:3100`，复制预览配置的后台/提交限制及 noindex 响应头；不要覆盖现有配置。若没有反向代理并确认端口可用、DNS 指向该主机，可启用项目 Caddy：

```bash
docker compose --env-file .env.preview -f deploy/compose.preview.yml --profile https up -d caddy
```

电脑临时公网预览还需要已批准可用的 HTTPS 隧道；本次未安装、注册、配置或同意任何隧道服务条款，也未更改防火墙。只允许向网页端口转发，数据库与 API 保持私有。任何公开访问带来的新网络权限或持久访问凭证另行确认。

## 持久性与验证

数据库保存于 `evalfrontier-preview_db` 卷，应用数据于 `evalfrontier-preview_data`，证书于 `evalfrontier-preview_caddy`。容器重建和不带 `-v` 的 down 保留数据；宿主机磁盘故障仍会丢失数据，正式使用前应配置备份。不要执行 `down -v` 或清理卷。

迁移与种子数据沿用现有 setup，信源只增不覆盖。最初没有精选、日报或榜单计算结果；真实空态与榜单 503 都应保留。不开后台模型任务就不会自动生成内容。

部署后必须从目标以外网络检查：

```bash
node scripts/smoke.ts --base https://实际域名
```

还需确认 HTTPS 证书、首页预览提示、三栏目与搜索参数、`/methodology`、两政策页不含法律模板、`/admin` / `/api/admin` 不可公网访问，以及 iPhone/Android 或移动视口页面。只有本机 HTTP 成功不能算公网部署完成；未获得外部 HTTPS 验证前不得报告手机已可访问。

## 运行、备份与回滚

使用本 Compose 文件查看 `ps` 和日志，不带任何秘密值输出。部署更新前记录前一镜像 ID并创建数据库备份；当前迁移都是增量兼容，回滚应用镜像应使用已记录的 ID，不猜测版本。

```bash
docker compose --env-file .env.preview -f deploy/compose.preview.yml ps
docker compose --env-file .env.preview -f deploy/compose.preview.yml logs --tail 100 api web
docker compose --env-file .env.preview -f deploy/compose.preview.yml exec -T db pg_dump -U evalfrontier evalfrontier > evalfrontier-backup.sql
docker compose --env-file .env.preview -f deploy/compose.preview.yml --profile https down
```

备份可能含反馈和其他运营数据，存放于权限受控目录，不提交 Git 或公开上传。首次预览的撤回方式是停止本项目容器并移除此域名的代理/隧道，仅操作本项目；持久卷保留。已有应用的回滚不要重置数据库、删除卷或操作其他站点。
