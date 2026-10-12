import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor } from "../src/monitor.ts";
import { discover, groupName, lastTurn, parseTasks, readMilestone, stateFiles, taskGroups } from "../src/scanner.ts";

let root: string;

function put(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function project(rel: string, state: object, plan = "", progress = "") {
  const dir = join(root, rel);
  put(join(dir, ".gsd-lite", "state.json"), JSON.stringify(state));
  if (plan) put(join(dir, ".gsd-lite", "PLAN.md"), plan);
  if (progress) put(join(dir, ".gsd-lite", "PROGRESS.md"), progress);
  return dir;
}

const PLAN = `# PLAN
## 検証コマンド
- [x] X1: Tasks の外は数えない
## Tasks
- [x] T1: 一つ目
- [x] **T2**: 二つ目
- [ ] T3a: 三つ目（未）
  - [ ] T9: 字下げは数えない
- [ ] F1-1：全角コロン
## impl への注意
- [ ] T99: ここも数えない
`;

const GROUPED_PLAN = `# PLAN
## Tasks
- [x] T1: 一つ目
- [x] T2: 二つ目
- **F タスクの定型**: 説明の行（チェックボックスではない）
### 修正ラウンド 1（2026-10-10 plan、turn 19。REQUIREMENTS「修正ラウンド 1」）
- [x] F1-1: 直す一つ目
- [ ] F1-2: 直す二つ目
### 修正ラウンド 2 (英数の括弧)
- [ ] F2-1: 三回目
## 決めた事項
### 修正ラウンド 1 で確定した細部
- [ ] F9: 節の外は数えない
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gsd-monitor-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseTasks", () => {
  test("## Tasks 節の行頭のチェックボックスだけ数える", () => {
    const t = parseTasks(PLAN);
    expect(t.map((x) => x.id)).toEqual(["T1", "T2", "T3a", "F1-1"]);
    expect(t.map((x) => x.done)).toEqual([true, true, false, false]);
    expect(t[2]!.title).toBe("三つ目（未）");
  });
  test("### 見出しより前のタスクのグループは空", () => {
    expect(parseTasks(PLAN).map((x) => x.group)).toEqual(["", "", "", ""]);
  });
  test("## Tasks 節の中の ### 見出しでグループに分ける。節を出たら数えない", () => {
    const t = parseTasks(GROUPED_PLAN);
    expect(t.map((x) => [x.id, x.group])).toEqual([
      ["T1", ""], ["T2", ""], ["F1-1", "修正ラウンド 1"], ["F1-2", "修正ラウンド 1"], ["F2-1", "修正ラウンド 2"],
    ]);
    expect(taskGroups(t)).toEqual([
      { name: "", done: 2, total: 2 },
      { name: "修正ラウンド 1", done: 1, total: 2 },
      { name: "修正ラウンド 2", done: 0, total: 1 },
    ]);
  });
  test("PLAN が空なら 0 件", () => {
    expect(parseTasks("")).toEqual([]);
  });
});

test("groupName は括弧書きの前まで。括弧しか無ければ全体", () => {
  expect(groupName("### 修正ラウンド 1（2026-10-10 plan）")).toBe("修正ラウンド 1");
  expect(groupName("### Round 2 (fix)")).toBe("Round 2");
  expect(groupName("### （注記だけ）")).toBe("（注記だけ）");
});

test("lastTurn は最後のターン見出し", () => {
  expect(lastTurn("# P\n## turn 1 — research — 調査\n- x\n## turn 2 — plan — 計画\n")).toBe("turn 2 — plan — 計画");
  expect(lastTurn("")).toBe("");
});

describe("discover", () => {
  test(".gsd-lite の中・node_modules には降りない。除外グロブが効く", () => {
    project("a", { phase: "impl" });
    project("b/c", { phase: "done" });
    project("a/.gsd-lite/logs/scratch/copy", { phase: "x" });
    project("node_modules/pkg", { phase: "x" });
    project("b/vendor/d", { phase: "x" });
    expect(discover(root).map((p) => p.slice(root.length))).toEqual(["/a", "/b/c", "/b/vendor/d"]);
    expect(discover(root, ["*/vendor/*"]).map((p) => p.slice(root.length))).toEqual(["/a", "/b/c"]);
  });
  test("無い探索開始フォルダは空", () => {
    expect(discover(join(root, "nope"))).toEqual([]);
  });
});

describe("readMilestone", () => {
  test("state・PLAN・PROGRESS を読む", () => {
    const dir = project(
      "app1",
      { milestone: "m1", phase: "impl", next_command: "/gsd-lite-impl", turn: 5, max_turns: 60, verify_round: 0,
        verify_round_max: 3, fix_round: 0, branch: { name: "gsd-lite/m1", base: "main" }, engine: "claude", updated_at: "2026-10-10T00:00:00Z" },
      PLAN,
      "## turn 4 — impl — T2\n## turn 5 — impl — T3a\n",
    );
    const m = readMilestone(dir, stateFiles(dir)[0]!);
    expect(m.app).toBe("app1");
    expect([m.milestone, m.phase, m.turn, m.maxTurns, m.branch]).toEqual(["m1", "impl", 5, 60, "gsd-lite/m1"]);
    expect([m.tasksDone, m.tasksTotal, m.currentTask]).toEqual([2, 4, "T3a"]);
    expect(m.taskGroups).toEqual([{ name: "", done: 2, total: 4 }]);
    expect(m.lastTurn).toBe("turn 5 — impl — T3a");
    expect(m.loopRunning).toBe(false);
    expect(m.blocked).toBe(false);
  });
  test("blocked は phase で判定（解決後に残った BLOCKED.md では立てない）。生きている pid ならループ稼働中", () => {
    const dir = project("app2", { phase: "done" });
    put(join(dir, ".gsd-lite", "BLOCKED.md"), "x");
    put(join(dir, ".gsd-lite", "loop.pid"), String(process.pid));
    const m = readMilestone(dir, stateFiles(dir)[0]!);
    expect(m.blocked).toBe(false);
    expect(m.blockedTitle).toBe("");
    expect(m.loopRunning).toBe(true);
    const b = project("app3", { phase: "blocked" });
    expect(readMilestone(b, stateFiles(b)[0]!).blocked).toBe(true);
    expect(readMilestone(b, stateFiles(b)[0]!).blockedTitle).toBe("");
  });
  test("blocked のときだけ BLOCKED.md の最初の見出しを読む", () => {
    const b = project("app5", { phase: "blocked" });
    put(join(b, ".gsd-lite", "BLOCKED.md"), "前置き\n\n# BLOCKED — verify round 3 の指摘が上限超過  \n\n## 詳細\n");
    expect(readMilestone(b, stateFiles(b)[0]!).blockedTitle).toBe("BLOCKED — verify round 3 の指摘が上限超過");
    const c = project("app6", { milestones: true }, "");
    put(join(c, ".gsd-lite", "milestones", "ms-a", "state.json"), JSON.stringify({ phase: "blocked" }));
    put(join(c, ".gsd-lite", "milestones", "ms-a", "BLOCKED.md"), "## 見出し 2 でも拾う\n");
    const sp = stateFiles(c).find((p) => p.includes("ms-a"))!;
    expect(readMilestone(c, sp).blockedTitle).toBe("見出し 2 でも拾う");
  });
  test("死んだ pid・壊れた pid ファイルは停止", () => {
    const dir = project("app4", { phase: "impl" });
    put(join(dir, ".gsd-lite", "loop.pid"), "999999999");
    expect(readMilestone(dir, stateFiles(dir)[0]!).loopRunning).toBe(false);
    put(join(dir, ".gsd-lite", "loop.pid"), "abc");
    expect(readMilestone(dir, stateFiles(dir)[0]!).loopRunning).toBe(false);
  });
  test("壊れた state.json は error に入れて落ちない", () => {
    const dir = join(root, "bad");
    put(join(dir, ".gsd-lite", "state.json"), "{ not json");
    const m = readMilestone(dir, stateFiles(dir)[0]!);
    expect(m.error).toContain("state.json を読めない");
    put(join(dir, ".gsd-lite", "state.json"), "[1,2]");
    expect(readMilestone(dir, stateFiles(dir)[0]!).error).toContain("object ではない");
  });
  test("型の違う値は空・null として読む", () => {
    const dir = project("odd", { milestone: 3, phase: null, turn: "5", branch: "main" });
    const m = readMilestone(dir, stateFiles(dir)[0]!);
    expect([m.milestone, m.phase, m.turn, m.branch]).toEqual(["3", "", null, ""]);
  });
  test("gsd-control 形はマイルストーンごとに読む", () => {
    const dir = join(root, "ctl");
    put(join(dir, ".gsd-lite", "config.json"), "{}");
    put(join(dir, ".gsd-lite", "milestones", "x", "state.json"), JSON.stringify({ milestone: "x", phase: "plan" }));
    put(join(dir, ".gsd-lite", "milestones", "x", "PLAN.md"), PLAN);
    put(join(dir, ".gsd-lite", "milestones", "y", "state.json"), JSON.stringify({ milestone: "y", phase: "done" }));
    const ms = stateFiles(dir).map((sp) => readMilestone(dir, sp));
    expect(ms.map((m) => [m.milestone, m.tasksTotal])).toEqual([["x", 4], ["y", 0]]);
  });
});

describe("Monitor", () => {
  test("2 回目以降の走査で変化を履歴に残す", () => {
    const dir = project("app", { milestone: "m", phase: "plan", turn: 2 }, PLAN);
    const mon = new Monitor({ root });
    mon.scan();
    expect(mon.snapshot().projects.length).toBe(1);
    expect(mon.snapshot().events).toEqual([]); // 初回は履歴にしない

    const sp = join(dir, ".gsd-lite", "state.json");
    writeFileSync(sp, JSON.stringify({ milestone: "m", phase: "impl", turn: 3 }));
    const later = new Date(Date.now() + 5000);
    utimesSync(sp, later, later);
    project("new", { milestone: "n", phase: "research" });
    mon.scan();
    const texts = mon.snapshot().events.map((e) => `${e.app}: ${e.text}`);
    expect(texts).toContain("app: plan → impl、turn 2 → 3");
    expect(texts).toContain("new: 新しく見つかった（n / research）");

    rmSync(join(root, "new"), { recursive: true });
    mon.scan();
    expect(mon.snapshot().events[0]!.text).toBe("見つからなくなった");
    expect(mon.snapshot().projects.map((p) => p.app)).toEqual(["app"]);
  });
  test("ファイルが変わらなければ読み直さない（同じオブジェクト）", () => {
    project("app", { phase: "plan" });
    const mon = new Monitor({ root });
    mon.scan();
    const a = mon.snapshot().projects[0];
    mon.scan();
    expect(mon.snapshot().projects[0]).toBe(a);
  });
});
