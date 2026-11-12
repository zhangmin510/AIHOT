import { titled } from "./lib/seo";
import { SITE } from "@aihot/industry/site";
import {
  isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, useNavigation, useRouteError, useRouteLoaderData,
  type ShouldRevalidateFunction,
} from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/root";
import "./app.css";
import "./portfolio-navigation.css";
import { PortfolioNavigation } from "./components/shell/PortfolioNavigation";
import { Sidebar } from "./components/shell/Sidebar";
import { MobileTabBar } from "./components/shell/MobileTabBar";
import { BackToTop, NavigationProgress } from "./components/shell/Chrome";
import { RingMark } from "./components/Logo";
import { buttonClass } from "./components/ui/Controls";
import { THEME_BOOT_SCRIPT } from "./lib/local-state";
import { apiGet } from "./lib/api.server";
import { useHydratedFlag } from "./lib/hydration";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "icon", type: "image/png", href: "/icon.png" },
  { rel: "apple-touch-icon", href: "/apple-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "alternate", type: "application/rss+xml", title: `${SITE.name} — 精选`, href: "/feed.xml" },
];

interface SiteMeta {
  changelogVersion: string | null;
  preview?: { readOnly: boolean; exportedAt: string | null } | null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const deploymentPreview = process.env.AIHOT_PREVIEW === "true";
  const fallbackPreview = process.env.CLOUDFLARE_PREVIEW === "true" ? { readOnly: true, exportedAt: null } : null;
  try {
    const meta = await apiGet<SiteMeta>("/api/site/meta", { signal: request.signal });
    return { ...meta, deploymentPreview, preview: meta.preview ?? fallbackPreview };
  } catch {
    return { changelogVersion: null, deploymentPreview, preview: fallbackPreview };
  }
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={SITE.locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf9f6" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#13191c" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration getKey={(location) => location.key} />
        <Scripts />
      </body>
    </html>
  );
}

/** Only a page nobody matched falls back to this; every page names itself. */
export function meta({ error }: Route.MetaArgs) {
  if (!error) return [];
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return [{ title: titled(notFound ? "页面不存在" : "暂时无法加载") }, { name: "robots", content: "noindex" }];
}

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ changelogVersion, deploymentPreview = false, preview, children }: { changelogVersion: string | null; deploymentPreview?: boolean; preview?: SiteMeta["preview"]; children: ReactNode }) {
  const navigation = useNavigation();
  return (
    <div className="flex min-h-dvh">
      <NavigationProgress active={navigation.state === "loading"} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
        跳到正文
      </a>
      <Sidebar changelogVersion={changelogVersion} />
      {/* Mobile shell (≤ 960px): one centred column, the tab bar below. Desktop: the page fills the main area
          up to the list width (--page-max-wide), centred beyond it. */}
      <main id="main" className="min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] lg:px-7 lg:pb-[72px] lg:pt-6">
        <div className="mx-auto w-full max-w-[640px] px-4 lg:max-w-[var(--page-max-wide)] lg:px-0">
          <PortfolioNavigation />
          {(deploymentPreview || preview?.readOnly) && <p role="status" className="mb-4 rounded-card border border-line bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-3">
            {preview?.readOnly ? <>只读预览站 · 当前展示现有公开内容的快照，由运营者手动更新。
              {preview.exportedAt && Number.isFinite(Date.parse(preview.exportedAt)) && <> 快照导出于 <time dateTime={preview.exportedAt}>{new Date(preview.exportedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>（UTC+8）。</>}
              {" "}采集、模型处理、通知与反馈提交已关闭。
            </> : <>预览站 · 采集、模型处理与通知已关闭。</>}
            {" "}使用规则与隐私说明待运营者确认。
          </p>}
          {children}
        </div>
      </main>
      <MobileTabBar changelogVersion={changelogVersion} />
      <BackToTop />
    </div>
  );
}

export default function App() {
  const meta = useLoaderData<typeof loader>();
  useHydratedFlag();
  const { pathname } = useLocation();
  // The admin has its own chrome.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return <Outlet />;
  return (
    <SiteShell changelogVersion={meta.changelogVersion} deploymentPreview={meta.deploymentPreview} preview={meta.preview}>
      <Outlet />
    </SiteShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const site = useRouteLoaderData<typeof loader>("root");
  const { pathname } = useLocation();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const notFound = status === 404;
  const body = (
    <div className="flex min-h-[70vh] items-center justify-center px-2 py-16">
      <div className="max-w-sm text-center">
        <RingMark className="mx-auto mb-5 size-10 text-accent" />
        <div className="mono text-[12px] text-ink-4">{status}</div>
        <h1 className="mt-1.5 text-[20px] font-bold text-ink">{notFound ? "这里没有内容" : "暂时无法加载"}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
          {notFound ? "你访问的页面不存在，或内容已不再公开。" : "服务暂时繁忙，请稍后再试。已经加载过的内容不受影响。"}
        </p>
        <div className="mt-6 flex justify-center gap-2.5">
          <Link to="/" className={buttonClass("primary")}>
            回到精选
          </Link>
          <Link to="/all" className={buttonClass("secondary")}>
            浏览全部动态
          </Link>
        </div>
      </div>
    </div>
  );
  // Admin errors stay inside the admin's own chrome.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return body;
  return <SiteShell changelogVersion={site?.changelogVersion ?? null} deploymentPreview={site?.deploymentPreview} preview={site?.preview}>{body}</SiteShell>;
}
