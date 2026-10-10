// .gsd-lite/ の発見と読み取り
//
// - 発見: 探索開始フォルダから下へ歩き、.gsd-lite/ を持つディレクトリをプロジェクトとする。
//   .gsd-lite の中（scratch に残った写し）・.git・node_modules 等には降りない。シンボリックリンクはたどらない
// - 形: in-repo（.gsd-lite/state.json）と gsd-control（.gsd-lite/milestones/<slug>/state.json）の両方
// - タスク: PLAN.md の「## Tasks」節の「- [x] T1: 題」「- [ ] T2: 題」を数える。
//   節の中の「### 修正ラウンド 1（…）」はグループの区切り（括弧書きの前までをグループ名にする）

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Milestone, Task, TaskGroup } from "./types.ts";

export const PRUNE_DIRS = new Set([
  ".git", ".gsd-lite", "node_modules", ".venv", "venv", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".tox", ".cache",
]);

const TASK_RE = /^- \[(?<mark>[ xX])\] \*{0,2}(?<id>[A-Z][A-Za-z0-9_.-]*)\*{0,2}\s*[:：]\s*(?<title>.*)$/;
const TURN_RE = /^## turn \d+ — \S+/;

/** シェル風の簡易グロブ（* と ?）。パス全体に当てる */
export function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

/** .gsd-lite/ を持つディレクトリを、パスの昇順で返す */
export function discover(root: string, excludes: string[] = []): string[] {
  const ex = excludes.map(globToRegExp);
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 読めないディレクトリは飛ばす
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    if (dirs.includes(".gsd-lite") && !ex.some((re) => re.test(dir))) found.push(dir);
    for (const name of dirs) {
      if (!PRUNE_DIRS.has(name)) walk(join(dir, name));
    }
  };
  walk(root);
  return found;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function mtime(p: string): number | undefined {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
}

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** プロジェクトの state.json（in-repo なら 1 つ、gsd-control ならマイルストーンごと） */
export function stateFiles(project: string): string[] {
  const gsd = join(project, ".gsd-lite");
  const files: string[] = [];
  if (isFile(join(gsd, "state.json"))) files.push(join(gsd, "state.json"));
  try {
    for (const e of readdirSync(join(gsd, "milestones"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(gsd, "milestones", e.name, "state.json");
      if (isFile(p)) files.push(p);
    }
  } catch {
    // milestones/ が無い = in-repo 形
  }
  return files;
}

/** 「### 修正ラウンド 1（2026-10-10 plan、…）」→「修正ラウンド 1」 */
export function groupName(heading: string): string {
  const name = heading.replace(/^###\s+/, "").split(/[（(]/)[0]!.trim();
  return name || heading.replace(/^###\s+/, "").trim();
}

export function parseTasks(planText: string): Task[] {
  const tasks: Task[] = [];
  let inTasks = false;
  let group = "";
  for (const line of planText.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      inTasks = line.trim() === "## Tasks";
      group = "";
      continue;
    }
    if (!inTasks) continue;
    if (line.startsWith("### ")) {
      group = groupName(line.trim());
      continue;
    }
    const g = TASK_RE.exec(line)?.groups;
    if (g) tasks.push({ id: g.id!, title: g.title!.trim(), done: g.mark !== " ", group });
  }
  return tasks;
}

/** タスクを持つグループを PLAN の順に。同じ名前の見出しが離れて出ても 1 つにまとめる */
export function taskGroups(tasks: Task[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const t of tasks) {
    const g = groups.get(t.group) ?? { name: t.group, done: 0, total: 0 };
    g.total++;
    if (t.done) g.done++;
    groups.set(t.group, g);
  }
  return [...groups.values()];
}

export function lastTurn(progressText: string): string {
  let last = "";
  for (const line of progressText.split(/\r?\n/)) {
    if (TURN_RE.test(line)) last = line.slice(3).trim();
  }
  return last;
}

export function pidAlive(pidFile: string): boolean {
  const pid = Number.parseInt(readText(pidFile).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 他ユーザーのプロセスは生きている
  }
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function readMilestone(project: string, statePath: string): Milestone {
  const msDir = dirname(statePath); // in-repo: .gsd-lite / gsd-control: .gsd-lite/milestones/<slug>
  const gsd = join(project, ".gsd-lite");
  const m: Milestone = {
    app: basename(project), path: project, statePath,
    milestone: "", phase: "", nextCommand: "", turn: null, maxTurns: null,
    verifyRound: null, verifyRoundMax: null, fixRound: null, branch: "", engine: "", updatedAt: "",
    stateMtime: mtime(statePath) ?? 0,
    tasks: [], tasksDone: 0, tasksTotal: 0, taskGroups: [], currentTask: "", lastTurn: "",
    loopRunning: false, blocked: false, error: "",
  };
  let state: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("object ではない");
    state = parsed as Record<string, unknown>;
  } catch (e) {
    m.error = `state.json を読めない: ${(e as Error).message}`;
    return m;
  }
  const branch = state.branch;
  m.milestone = str(state.milestone);
  m.phase = str(state.phase);
  m.nextCommand = str(state.next_command);
  m.turn = int(state.turn);
  m.maxTurns = int(state.max_turns);
  m.verifyRound = int(state.verify_round);
  m.verifyRoundMax = int(state.verify_round_max);
  m.fixRound = int(state.fix_round);
  m.branch = typeof branch === "object" && branch !== null ? str((branch as Record<string, unknown>).name) : "";
  m.engine = str(state.engine);
  m.updatedAt = str(state.updated_at);

  m.tasks = parseTasks(readText(join(msDir, "PLAN.md")));
  m.tasksTotal = m.tasks.length;
  m.tasksDone = m.tasks.filter((t) => t.done).length;
  m.taskGroups = taskGroups(m.tasks);
  m.currentTask = m.tasks.find((t) => !t.done)?.id ?? "";
  m.lastTurn = lastTurn(readText(join(msDir, "PROGRESS.md")));
  m.loopRunning = pidAlive(join(gsd, "loop.pid"));
  // BLOCKED.md は解決後も残るので、ループ本体が書く phase だけで判定する
  m.blocked = m.phase === "blocked";
  return m;
}

/** 変化の検知に使うファイルの mtime。state.json が主で、タスクの進みは PLAN / PROGRESS にも出る */
export function watchedMtimes(project: string): string {
  const parts: string[] = [];
  for (const sp of stateFiles(project)) {
    const d = dirname(sp);
    for (const p of [sp, join(d, "PLAN.md"), join(d, "PROGRESS.md"), join(d, "BLOCKED.md")]) {
      parts.push(`${p}=${mtime(p) ?? "-"}`);
    }
  }
  const pid = join(project, ".gsd-lite", "loop.pid");
  parts.push(`${pid}=${mtime(pid) ?? "-"}`);
  return parts.join("\n");
}
