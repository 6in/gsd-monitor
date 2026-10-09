import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor } from "../src/monitor.ts";
import { normalizeBasePath, startServer } from "../src/server.ts";

describe("normalizeBasePath", () => {
  test("前後のスラッシュをそろえる", () => {
    expect(normalizeBasePath("app02-gsd-monitor")).toBe("/app02-gsd-monitor/");
    expect(normalizeBasePath("/app02-gsd-monitor")).toBe("/app02-gsd-monitor/");
    expect(normalizeBasePath("//a//b/")).toBe("/a/b/");
    expect(normalizeBasePath("/")).toBe("/");
    expect(normalizeBasePath("")).toBe("/");
  });
  test("使えない形は拒む", () => {
    expect(() => normalizeBasePath("/a/../b")).toThrow();
    expect(() => normalizeBasePath("/a?x")).toThrow();
    expect(() => normalizeBasePath("/a b")).toThrow();
  });
});

describe("startServer", () => {
  let root: string;
  let monitor: Monitor;
  const servers: { stop: (force?: boolean) => unknown }[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "gsd-monitor-srv-"));
    mkdirSync(join(root, "app", ".gsd-lite"), { recursive: true });
    writeFileSync(join(root, "app", ".gsd-lite", "state.json"), JSON.stringify({ milestone: "m", phase: "impl" }));
    monitor = new Monitor({ root });
    monitor.scan();
  });
  afterAll(() => {
    for (const s of servers) s.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("プレフィックスの下で画面・API・束ねた JS を配信し、外は 404", async () => {
    const s = await startServer(monitor, { host: "127.0.0.1", port: 0, basePath: "app02-gsd-monitor" });
    servers.push(s);
    const u = (p: string) => new URL(p, s.url).href;

    const noSlash = await fetch(u("/app02-gsd-monitor"), { redirect: "manual" });
    expect(noSlash.status).toBe(301);
    expect(noSlash.headers.get("location")).toBe("/app02-gsd-monitor/");

    const page = await fetch(u("/app02-gsd-monitor/"));
    expect(page.status).toBe(200);
    const html = await page.text();
    const js = html.match(/src="([^"]+\.js)"/)?.[1];
    const css = html.match(/href="([^"]+\.css)"/)?.[1];
    expect(js?.startsWith("/app02-gsd-monitor/")).toBe(true);
    expect(css?.startsWith("/app02-gsd-monitor/")).toBe(true);
    expect((await fetch(u(js!))).status).toBe(200);
    expect((await fetch(u(css!))).status).toBe(200);

    const st = await fetch(u("/app02-gsd-monitor/api/status"));
    expect(((await st.json()) as { projects: unknown[] }).projects.length).toBe(1);
    expect((await fetch(u("/app02-gsd-monitor/api/rescan"), { method: "POST" })).status).toBe(200);
    expect((await fetch(u("/app02-gsd-monitor/api/rescan"))).status).toBe(405);

    expect((await fetch(u("/"))).status).toBe(404);
    expect((await fetch(u("/api/status"))).status).toBe(404);
  });

  test("使用中のポートは +1 して空きを探す", async () => {
    const a = await startServer(monitor, { host: "127.0.0.1", port: 0, basePath: "/" });
    servers.push(a);
    const b = await startServer(monitor, { host: "127.0.0.1", port: a.port!, basePath: "/" });
    servers.push(b);
    expect(b.port).toBe(a.port! + 1);
  });

  test("探す回数を超えたら失敗", async () => {
    const a = await startServer(monitor, { host: "127.0.0.1", port: 0, basePath: "/" });
    servers.push(a);
    await expect(startServer(monitor, { host: "127.0.0.1", port: a.port!, basePath: "/", maxTries: 1 })).rejects.toThrow("空いているポートが無い");
  });
});
