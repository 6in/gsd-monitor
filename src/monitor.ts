// 一定間隔で探索 → 変化したプロジェクトだけ読み直し、変化の履歴を残す

import { basename, join } from "node:path";
import { discover, pidAlive, readMilestone, stateFiles, watchedMtimes } from "./scanner.ts";
import type { Milestone, MonitorEvent, Status } from "./types.ts";

export interface MonitorOptions {
  root: string;
  intervalSec?: number;
  excludes?: string[];
  historySize?: number;
}

export class Monitor {
  readonly root: string;
  readonly intervalSec: number;
  readonly excludes: string[];
  private readonly historySize: number;
  private mtimes = new Map<string, string>(); // project -> 監視ファイルの mtime の連結
  private milestones = new Map<string, Milestone[]>(); // project -> milestones
  private events: MonitorEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  lastScan = 0;
  scanCount = 0;

  constructor(opts: MonitorOptions) {
    this.root = opts.root;
    this.intervalSec = opts.intervalSec ?? 60;
    this.excludes = opts.excludes ?? [];
    this.historySize = opts.historySize ?? 200;
  }

  scan(): void {
    const now = Date.now();
    const projects = discover(this.root, this.excludes);
    const seen = new Set(projects);
    for (const proj of projects) {
      const mt = watchedMtimes(proj);
      const prev = this.milestones.get(proj);
      if (prev && this.mtimes.get(proj) === mt) {
        // ファイルは変わらないが、ループのプロセスは止まりうる（pid を見るだけ）
        const running = pidAlive(join(proj, ".gsd-lite", "loop.pid"));
        for (const m of prev) {
          if (!m.error && m.loopRunning !== running) {
            m.loopRunning = running;
            this.push(now, m, running ? "ループ起動" : "ループ停止");
          }
        }
        continue;
      }
      const next = stateFiles(proj).map((sp) => readMilestone(proj, sp));
      this.recordChanges(prev, next, now);
      this.mtimes.set(proj, mt);
      this.milestones.set(proj, next);
    }
    for (const gone of [...this.milestones.keys()].filter((p) => !seen.has(p))) {
      this.pushRaw({ at: now, app: basename(gone), path: gone, milestone: "", text: "見つからなくなった" });
      this.milestones.delete(gone);
      this.mtimes.delete(gone);
    }
    this.lastScan = now;
    this.scanCount++;
  }

  private recordChanges(prev: Milestone[] | undefined, next: Milestone[], now: number): void {
    if (this.scanCount === 0) return; // 初回の読み込みは履歴にしない
    if (!prev) {
      for (const m of next) this.push(now, m, `新しく見つかった（${m.milestone || "-"} / ${m.phase || "-"}）`);
      return;
    }
    const before = new Map(prev.map((m) => [m.statePath, m]));
    for (const m of next) {
      const o = before.get(m.statePath);
      if (!o) {
        this.push(now, m, `マイルストーン追加: ${m.milestone || "-"}`);
        continue;
      }
      const parts: string[] = [];
      if (o.milestone !== m.milestone) parts.push(`マイルストーン ${o.milestone || "-"} → ${m.milestone || "-"}`);
      if (o.phase !== m.phase) parts.push(`${o.phase || "-"} → ${m.phase || "-"}`);
      if (o.turn !== m.turn) parts.push(`turn ${o.turn ?? "-"} → ${m.turn ?? "-"}`);
      if (o.tasksDone !== m.tasksDone || o.tasksTotal !== m.tasksTotal) {
        parts.push(`タスク ${o.tasksDone}/${o.tasksTotal} → ${m.tasksDone}/${m.tasksTotal}`);
      }
      if (o.blocked !== m.blocked) parts.push(m.blocked ? "BLOCKED" : "BLOCKED 解除");
      if (o.loopRunning !== m.loopRunning) parts.push(m.loopRunning ? "ループ起動" : "ループ停止");
      if (o.error !== m.error && m.error) parts.push(m.error);
      if (parts.length) this.push(now, m, parts.join("、"));
    }
  }

  private push(at: number, m: Milestone, text: string): void {
    this.pushRaw({ at, app: m.app, path: m.path, milestone: m.milestone, text });
  }

  private pushRaw(e: MonitorEvent): void {
    this.events.unshift(e);
    if (this.events.length > this.historySize) this.events.length = this.historySize;
  }

  snapshot(): Status {
    const projects = [...this.milestones.values()].flat()
      .sort((a, b) => a.app.localeCompare(b.app) || a.path.localeCompare(b.path) || a.milestone.localeCompare(b.milestone));
    return {
      root: this.root,
      intervalSec: this.intervalSec,
      lastScan: this.lastScan,
      scanCount: this.scanCount,
      projects,
      events: [...this.events],
    };
  }

  start(): void {
    this.scan();
    this.timer = setInterval(() => {
      try {
        this.scan();
      } catch (e) {
        // 1 回の失敗で監視を止めない
        this.pushRaw({ at: Date.now(), app: "-", path: "", milestone: "", text: `走査に失敗: ${(e as Error).message}` });
      }
    }, this.intervalSec * 1000);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
