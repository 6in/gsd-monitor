// ブラウザ通知のきっかけ: 前回の /api/status と今回の差から、人に知らせる変化だけを拾う（純粋関数。画面から使う）
//
// - マイルストーン（statePath）ごとに、前回の走査結果からの変化だけを見る。前回が無い（ページを開いた直後）なら何も出さない
// - phase が blocked / done に変わった、ループが「動いている」→「止まった」でそのとき phase が done / blocked 以外
// - ループ停止と done への変化が同時に来たら「完了」の 1 件だけ
// - tag は同じ変化で同じ値になる（複数のタブや再描画で二重に出さないため）

import type { Milestone } from "./types.ts";

export type NoticeKind = "blocked" | "done" | "loop-stopped";

export interface Notice {
  kind: NoticeKind;
  /** Notification の tag */
  tag: string;
  title: string;
  body: string;
}

const STOPPED_OK = new Set(["done", "blocked"]);

function tagOf(kind: NoticeKind, m: Milestone): string {
  return `gsd-monitor:${kind}:${m.statePath}:${m.updatedAt || m.stateMtime}`;
}

export function detectNotices(prev: readonly Milestone[] | null | undefined, next: readonly Milestone[]): Notice[] {
  if (!prev) return [];
  const before = new Map(prev.map((m) => [m.statePath, m]));
  const notices: Notice[] = [];
  for (const m of next) {
    const o = before.get(m.statePath);
    if (!o || m.error) continue; // 新しく見つかったもの・読めないものは知らせない
    const ms = m.milestone || "（マイルストーン未設定）";
    if (o.phase !== m.phase && m.phase === "blocked") {
      notices.push({
        kind: "blocked", tag: tagOf("blocked", m), title: `BLOCKED: ${m.app}`,
        body: m.blockedTitle ? `${ms}\n${m.blockedTitle}` : ms,
      });
    } else if (o.phase !== m.phase && m.phase === "done") {
      notices.push({ kind: "done", tag: tagOf("done", m), title: `完了: ${m.app}`, body: ms });
    } else if (o.loopRunning && !m.loopRunning && !STOPPED_OK.has(m.phase)) {
      notices.push({
        kind: "loop-stopped", tag: tagOf("loop-stopped", m),
        title: `ループ停止: ${m.app}（phase: ${m.phase || "-"}）`, body: ms,
      });
    }
  }
  return notices;
}
