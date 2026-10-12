// 画面: /api/status を定期的に読み、カードと変化の履歴を描く。人に知らせる変化はブラウザ通知（Notification API）で出す

import { detectNotices, type Notice } from "../src/notify.ts";
import type { Milestone, MonitorEvent, Status } from "../src/types.ts";

const POLL_MS = 15_000; // サーバーの走査は既定 60 秒。画面はそれより短い間隔で取りに行く
const PHASES = ["discuss", "research", "plan", "impl", "verify", "reflect", "done", "blocked"];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  root: $("root"),
  summary: $("summary"),
  scanned: $("scanned"),
  cards: $("cards"),
  events: $("events"),
  filter: $<HTMLInputElement>("filter"),
  hideDone: $<HTMLInputElement>("hideDone"),
  rescan: $<HTMLButtonElement>("rescan"),
  notify: $<HTMLButtonElement>("notify"),
  notifyState: $("notifyState"),
};

let last: Status | null = null;
const openTasks = new Set<string>(); // 開いているタスク一覧（再描画で閉じないように）

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function ago(ms: number): string {
  if (!ms) return "-";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 時間前`;
  return `${Math.floor(s / 86400)} 日前`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** ### 見出しより前のタスクは名前が "" */
function groupLabel(name: string): string {
  return name || "最初の計画";
}

function phaseKey(m: Milestone): string {
  if (m.error) return "error";
  if (m.blocked) return "blocked";
  return PHASES.includes(m.phase) ? m.phase : "other";
}

function phaseColor(key: string): string {
  return PHASES.includes(key) ? `var(--phase-${key})` : key === "error" ? "var(--bad)" : "var(--idle)";
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0;
}

function card(m: Milestone): string {
  const key = phaseKey(m);
  const id = m.statePath;
  const turnPct = pct(m.turn ?? 0, m.maxTurns ?? 0);
  const taskPct = pct(m.tasksDone, m.tasksTotal);
  const cur = m.tasks.find((t) => t.id === m.currentTask);
  const stale = !m.loopRunning && (key === "done" || Date.now() - m.stateMtime > 7 * 86400_000);
  const head = `
    <div class="card-head">
      <div><h3>${esc(m.app)}</h3><span class="path">${esc(m.path)}</span></div>
      <div class="badges">
        <span class="loop ${m.loopRunning ? "on" : "off"}">${m.loopRunning ? "稼働中" : "停止"}</span>
        <span class="badge">${esc(key === "error" ? "読めない" : m.blocked ? "blocked" : m.phase || "-")}</span>
      </div>
    </div>`;
  if (m.error) {
    return `<article class="card" style="--phase-color:${phaseColor(key)}">${head}<div class="error">${esc(m.error)}</div></article>`;
  }
  // ### 見出し（修正ラウンド等）が PLAN にあるときだけ、一覧を区切り、最新のグループの進みを別の行に出す
  const grouped = m.taskGroups.length > 1;
  const latest = grouped ? m.taskGroups[m.taskGroups.length - 1]! : null;
  const groupStats = new Map(m.taskGroups.map((g) => [g.name, g]));
  let prevGroup: string | null = null;
  const taskItems = m.tasks.map((t) => {
    let head = "";
    if (grouped && t.group !== prevGroup) {
      const g = groupStats.get(t.group)!;
      head = `<li class="group"><span>${esc(groupLabel(t.group))}</span><span class="num">${g.done}/${g.total}</span></li>`;
    }
    prevGroup = t.group;
    return `${head}<li class="${t.done ? "done" : t.id === m.currentTask ? "now" : ""}">
              <span>${t.done ? "✔" : t.id === m.currentTask ? "▶" : "・"}</span>
              <span class="mono">${esc(t.id)}</span><span>${esc(t.title)}</span></li>`;
  });
  const tasksList = m.tasks.length
    ? `<details class="tasks" data-id="${esc(id)}" ${openTasks.has(id) ? "open" : ""}>
        <summary>タスク一覧（${m.tasksDone}/${m.tasksTotal}）</summary>
        <ol>${taskItems.join("")}</ol>
      </details>`
    : "";
  return `
  <article class="card${stale ? " stale" : ""}" style="--phase-color:${phaseColor(key)}">
    ${head}
    <div class="ms">${esc(m.milestone || "（マイルストーン未設定）")}</div>
    ${m.blocked ? `<div class="blocked-note">人の判断待ち（BLOCKED.md）</div>` : ""}
    <div class="row"><span class="label">タスク</span>
      <div class="bar"><span style="width:${taskPct}%"></span></div>
      <span class="num">${m.tasksTotal ? `${m.tasksDone}/${m.tasksTotal}` : "PLAN なし"}</span></div>
    ${latest ? `<div class="row"><span class="label">今回</span>
      <div class="bar"><span style="width:${pct(latest.done, latest.total)}%"></span></div>
      <span class="num">${esc(groupLabel(latest.name))} ${latest.done}/${latest.total}</span></div>` : ""}
    <div class="row"><span class="label">ターン</span>
      <div class="bar turns${turnPct >= 80 ? " hot" : ""}"><span style="width:${turnPct}%"></span></div>
      <span class="num">${m.turn ?? "-"}/${m.maxTurns ?? "-"}</span></div>
    ${cur ? `<div class="current"><b class="mono">${esc(cur.id)}</b>${esc(cur.title)}</div>` : ""}
    ${m.lastTurn ? `<div class="lastturn">直近: ${esc(m.lastTurn)}</div>` : ""}
    <div class="meta">
      <span>次: <code>${esc(m.nextCommand || "-")}</code></span>
      ${m.verifyRound != null ? `<span>verify ${m.verifyRound}/${m.verifyRoundMax ?? "-"}</span>` : ""}
      ${m.fixRound ? `<span>修正ラウンド ${m.fixRound}</span>` : ""}
      ${m.engine ? `<span>${esc(m.engine)}</span>` : ""}
      ${m.branch ? `<span class="mono">${esc(m.branch)}</span>` : ""}
      <span title="${esc(m.updatedAt)}">更新 ${ago(m.stateMtime)}</span>
    </div>
    ${tasksList}
  </article>`;
}

function render(): void {
  if (!last) return;
  const s = last;
  els.root.textContent = `${s.root} を ${s.intervalSec} 秒ごとに走査`;
  els.scanned.textContent = `最終走査 ${s.lastScan ? clock(s.lastScan) : "-"}`;

  const counts = new Map<string, number>();
  for (const m of s.projects) counts.set(phaseKey(m), (counts.get(phaseKey(m)) ?? 0) + 1);
  const running = s.projects.filter((m) => m.loopRunning).length;
  els.summary.innerHTML =
    `<span class="pill">全 <b>${s.projects.length}</b></span>` +
    `<span class="pill">稼働中 <b>${running}</b></span>` +
    [...PHASES, "other", "error"]
      .filter((k) => counts.get(k))
      .map((k) => `<span class="pill" style="box-shadow: inset 3px 0 0 ${phaseColor(k)}">${k} <b>${counts.get(k)}</b></span>`)
      .join("");

  const q = els.filter.value.trim().toLowerCase();
  const shown = s.projects.filter((m) => {
    if (els.hideDone.checked && phaseKey(m) === "done" && !m.loopRunning) return false;
    if (!q) return true;
    return [m.app, m.milestone, m.path, m.phase].some((v) => v.toLowerCase().includes(q));
  });
  // 稼働中 → blocked → それ以外、の順で上に
  const rank = (m: Milestone) => (m.loopRunning ? 0 : m.blocked ? 1 : phaseKey(m) === "done" ? 3 : 2);
  shown.sort((a, b) => rank(a) - rank(b) || b.stateMtime - a.stateMtime);
  els.cards.innerHTML = shown.length ? shown.map(card).join("") : `<div class="empty">該当なし</div>`;

  els.events.innerHTML = s.events.length
    ? s.events.slice(0, 100).map((e: MonitorEvent) =>
        `<li><span class="when">${clock(e.at)}</span><span class="who">${esc(e.app)}</span>${esc(e.text)}</li>`).join("")
    : `<li class="sub">まだ変化はありません（起動後に検知したものだけ並びます）</li>`;
}

// 通知: 許可は自動で求めず、ボタンを押したときだけ。secure context（https / localhost）でないと Notification は無い
const notifySupported = typeof window !== "undefined" && "Notification" in window && window.isSecureContext;

function renderNotifyState(): void {
  if (!notifySupported) {
    els.notify.hidden = true;
    els.notifyState.textContent = "通知: 非対応";
    return;
  }
  const p = Notification.permission;
  els.notify.hidden = p !== "default";
  els.notifyState.textContent = p === "granted" ? "通知: 許可済み" : p === "denied" ? "通知: 拒否済み（ブラウザの設定で変更）" : "";
}

function showNotice(n: Notice): void {
  if (!notifySupported || Notification.permission !== "granted") return;
  try {
    // 同じ tag は置き換わる（複数のタブや同じ変化で二重に出さない）
    const note = new Notification(n.title, { body: n.body, tag: n.tag });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // 通知を出せない環境（Android の Chrome 等）でも画面は止めない
  }
}

// API はページからの相対パス（URL プレフィックスの下で動くように）
async function load(path = "api/status", init?: RequestInit): Promise<void> {
  try {
    const res = await fetch(path, init);
    if (!res.ok) throw new Error(`${res.status}`);
    const next = (await res.json()) as Status;
    // 前回の取得結果との差だけ（ページを開いた直後の 1 回目は last が null なので出さない）
    for (const n of detectNotices(last?.projects, next.projects)) showNotice(n);
    last = next;
    render();
  } catch (e) {
    els.scanned.textContent = `取得に失敗: ${(e as Error).message}`;
  }
}

els.cards.addEventListener("toggle", (ev) => {
  const d = ev.target as HTMLDetailsElement;
  const id = d.dataset.id;
  if (!id) return;
  if (d.open) openTasks.add(id);
  else openTasks.delete(id);
}, true);
els.filter.addEventListener("input", render);
els.hideDone.addEventListener("change", render);
els.rescan.addEventListener("click", async () => {
  els.rescan.disabled = true;
  await load("api/rescan", { method: "POST" });
  els.rescan.disabled = false;
});

els.notify.addEventListener("click", async () => {
  els.notify.disabled = true;
  try {
    await Notification.requestPermission();
  } finally {
    els.notify.disabled = false;
    renderNotifyState();
  }
});

renderNotifyState();
load();
setInterval(load, POLL_MS);
