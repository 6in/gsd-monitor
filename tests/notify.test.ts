import { describe, expect, test } from "bun:test";
import { detectNotices } from "../src/notify.ts";
import type { Milestone } from "../src/types.ts";

function ms(over: Partial<Milestone> = {}): Milestone {
  return {
    app: "app", path: "/w/app", statePath: "/w/app/.gsd-lite/state.json",
    milestone: "m18", phase: "impl", nextCommand: "", turn: 3, maxTurns: 60,
    verifyRound: null, verifyRoundMax: null, fixRound: null, branch: "", engine: "", updatedAt: "2026-10-12T10:00:00Z",
    stateMtime: 1, tasks: [], tasksDone: 0, tasksTotal: 0, taskGroups: [], currentTask: "", lastTurn: "",
    loopRunning: true, blocked: false, blockedTitle: "", error: "",
    ...over,
  };
}

describe("detectNotices", () => {
  test("初回（前回の走査結果が無い）は通知しない", () => {
    expect(detectNotices(null, [ms({ phase: "blocked", blocked: true, loopRunning: false })])).toEqual([]);
    expect(detectNotices(undefined, [ms({ phase: "done" })])).toEqual([]);
  });

  test("blocked に変わったら BLOCKED の通知。本文はマイルストーン名と BLOCKED.md の最初の見出し", () => {
    const n = detectNotices([ms()], [ms({ phase: "blocked", blocked: true, blockedTitle: "BLOCKED — verify 上限超過", loopRunning: false })]);
    expect(n.length).toBe(1);
    expect(n[0]!.kind).toBe("blocked");
    expect(n[0]!.title).toBe("BLOCKED: app");
    expect(n[0]!.body).toBe("m18\nBLOCKED — verify 上限超過");
    // 見出しが無ければマイルストーン名だけ
    expect(detectNotices([ms()], [ms({ phase: "blocked", blocked: true })])[0]!.body).toBe("m18");
  });

  test("done に変わったら完了の通知", () => {
    const n = detectNotices([ms({ phase: "reflect" })], [ms({ phase: "done" })]);
    expect(n.map((x) => [x.kind, x.title, x.body])).toEqual([["done", "完了: app", "m18"]]);
  });

  test("ループが止まり phase が impl のままなら、ループ停止の通知", () => {
    const n = detectNotices([ms({ loopRunning: true })], [ms({ loopRunning: false })]);
    expect(n.map((x) => [x.kind, x.title])).toEqual([["loop-stopped", "ループ停止: app（phase: impl）"]]);
  });

  test("ループ停止と done への変化が同時なら「完了」の 1 件だけ", () => {
    const n = detectNotices([ms({ phase: "reflect", loopRunning: true })], [ms({ phase: "done", loopRunning: false })]);
    expect(n.map((x) => x.kind)).toEqual(["done"]);
  });

  test("done / blocked のままループが止まっても通知しない", () => {
    expect(detectNotices([ms({ phase: "done" })], [ms({ phase: "done", loopRunning: false })])).toEqual([]);
    expect(detectNotices([ms({ phase: "blocked", blocked: true })], [ms({ phase: "blocked", blocked: true, loopRunning: false })])).toEqual([]);
  });

  test("変化なし・別の変化（ターンの進み・ループ起動）・新しく見つかったものは通知しない", () => {
    expect(detectNotices([ms()], [ms()])).toEqual([]);
    expect(detectNotices([ms({ turn: 3 })], [ms({ turn: 4, phase: "impl" })])).toEqual([]);
    expect(detectNotices([ms({ loopRunning: false })], [ms({ loopRunning: true })])).toEqual([]);
    expect(detectNotices([ms()], [ms(), ms({ statePath: "/w/b/.gsd-lite/state.json", phase: "blocked" })])).toEqual([]);
  });

  test("マイルストーンごとに判定し、tag は同じ変化で同じ値・別の変化で別の値", () => {
    const a = "/w/a/.gsd-lite/state.json";
    const b = "/w/b/.gsd-lite/state.json";
    const prev = [ms({ app: "a", statePath: a }), ms({ app: "b", statePath: b })];
    const next = [ms({ app: "a", statePath: a, phase: "blocked" }), ms({ app: "b", statePath: b, phase: "done" })];
    const n1 = detectNotices(prev, next);
    const n2 = detectNotices(prev, next);
    expect(n1.map((x) => x.title)).toEqual(["BLOCKED: a", "完了: b"]);
    expect(n1.map((x) => x.tag)).toEqual(n2.map((x) => x.tag));
    expect(new Set(n1.map((x) => x.tag)).size).toBe(2);
  });
});
