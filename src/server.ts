// HTTP サーバー（Bun.serve）
//
// - すべて URL プレフィックス（既定 /app02-gsd-monitor/）の下に置く。リバースプロキシの下でも動くように、
//   画面の JS / CSS も publicPath 付きで起動時に束ね、プレフィックスの下から配信する
// - データは <prefix>api/status、1 分を待たずに読み直すのは <prefix>api/rescan（POST）
// - ポートは指定値から空いているところを +1 刻みで探す

import type { Server } from "bun";
import type { Monitor } from "./monitor.ts";

const ENTRY = new URL("../public/index.html", import.meta.url).pathname;

/** "app02-gsd-monitor" / "/app02-gsd-monitor" / "/app02-gsd-monitor/" → "/app02-gsd-monitor/"（"/" はそのまま） */
export function normalizeBasePath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.some((s) => s === "." || s === ".." || /[?#\s]/.test(s))) {
    throw new Error(`URL プレフィックスに使えない文字がある: ${p}`);
  }
  return parts.length ? `/${parts.join("/")}/` : "/";
}

interface Asset {
  body: Blob;
  type: string;
}

/** 画面を publicPath 付きで束ね、配信するパス → 中身 の表を返す */
export async function buildAssets(basePath: string): Promise<Map<string, Asset>> {
  const r = await Bun.build({ entrypoints: [ENTRY], publicPath: basePath, minify: true });
  if (!r.success) throw new Error(`画面の束ねに失敗: ${r.logs.map(String).join("\n")}`);
  const assets = new Map<string, Asset>();
  for (const o of r.outputs) {
    const name = o.path.replace(/^\.\//, "");
    const path = name === "index.html" ? basePath : `${basePath}${name}`;
    assets.set(path, { body: o, type: o.type });
  }
  return assets;
}

function isAddrInUse(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(err?.message ?? "");
}

export interface ServeOptions {
  host: string;
  /** 探し始めるポート */
  port: number;
  basePath: string;
  /** 空きを探す回数（既定 100） */
  maxTries?: number;
}

export async function startServer(monitor: Monitor, opts: ServeOptions): Promise<Server<undefined>> {
  const base = normalizeBasePath(opts.basePath);
  const assets = await buildAssets(base);
  const json = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });

  const fetch = (req: Request): Response => {
    const { pathname } = new URL(req.url);
    if (base !== "/" && pathname === base.slice(0, -1)) {
      return Response.redirect(base, 301); // 末尾のスラッシュなし → あり（相対パスの API 呼び出しのため）
    }
    if (pathname === `${base}api/status`) {
      return req.method === "GET" ? json(monitor.snapshot()) : new Response("Method Not Allowed", { status: 405 });
    }
    if (pathname === `${base}api/rescan`) {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      monitor.scan();
      return json(monitor.snapshot());
    }
    const a = req.method === "GET" || req.method === "HEAD" ? assets.get(pathname) : undefined;
    if (a) {
      const cache = pathname === base ? "no-cache" : "public, max-age=31536000, immutable"; // チャンク名は内容のハッシュ
      return new Response(a.body, { headers: { "content-type": a.type, "cache-control": cache } });
    }
    return new Response("Not Found", { status: 404 });
  };

  const tries = opts.maxTries ?? 100;
  for (let i = 0; i < tries; i++) {
    const port = opts.port + i;
    if (port > 65535) break;
    try {
      return Bun.serve({ hostname: opts.host, port, fetch });
    } catch (e) {
      if (!isAddrInUse(e)) throw e;
    }
  }
  throw new Error(`空いているポートが無い（${opts.port} から ${tries} 個）`);
}
