#!/usr/bin/env bun
// 起動: bun run start [--root DIR] [--interval 秒] [--host H] [--port N] [--base-path P] [--exclude グロブ ...]

import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Monitor } from "./monitor.ts";
import { normalizeBasePath, startServer } from "./server.ts";

/** 既定の除外: 他リポジトリの components/ に取り込んだ写し（元のリポジトリと同じ名前で二重に出る） */
export const DEFAULT_EXCLUDES = ["*/components/*"];

const USAGE = `gsd-monitor — 複数リポジトリの .gsd-lite/state.json を横串で見るダッシュボード

  --root DIR       探索開始フォルダ（既定 ~/workspaces/dev）
  --interval 秒    走査の間隔（既定 60）
  --host H         待ち受けるアドレス（既定 127.0.0.1）
  --port N         待ち受けるポート（既定 3300。使用中なら +1 ずつ空きを探す）
  --base-path P    URL プレフィックス（既定 /app02-gsd-monitor/）
  --exclude GLOB   除外するプロジェクトのパス（* と ?。複数可）。既定の除外に足される
  --no-default-exclude  既定の除外（${DEFAULT_EXCLUDES.join(" ")}）を使わない
  -h, --help       この説明`;

function fail(msg: string): never {
  console.error(`gsd-monitor: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        root: { type: "string" },
        interval: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        "base-path": { type: "string" },
        exclude: { type: "string", multiple: true },
        "no-default-exclude": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (e) {
    fail((e as Error).message);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const rootArg = values.root ?? "~/workspaces/dev";
  const root = resolve(rootArg.replace(/^~(?=$|\/)/, homedir()));
  const interval = Number(values.interval ?? "60");
  if (!Number.isFinite(interval) || interval < 1) fail(`--interval は 1 以上の数: ${values.interval}`);
  const port = Number(values.port ?? "3300");
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port は 0〜65535: ${values.port}`);
  const host = values.host ?? "127.0.0.1";
  let basePath: string;
  try {
    basePath = normalizeBasePath(values["base-path"] ?? "/app02-gsd-monitor/");
  } catch (e) {
    fail((e as Error).message);
  }

  const excludes = [...(values["no-default-exclude"] ? [] : DEFAULT_EXCLUDES), ...(values.exclude ?? [])];
  const monitor = new Monitor({ root, intervalSec: interval, excludes });
  monitor.start();
  let server;
  try {
    server = await startServer(monitor, { host, port, basePath });
  } catch (e) {
    monitor.stop();
    fail(`待ち受けに失敗: ${(e as Error).message}`);
  }
  const n = monitor.snapshot().projects.length;
  const url = new URL(basePath, server.url).href;
  const moved = server.port !== port ? `・${port} は使用中だったので ${server.port}` : "";
  console.log(`gsd-monitor: ${url} （探索 ${root}・${interval} 秒ごと・${n} 件・除外 ${excludes.join(" ") || "なし"}${moved}）`);
}

await main();
