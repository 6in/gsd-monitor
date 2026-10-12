# gsd-monitor

複数リポジトリの `.gsd-lite/state.json` を横串で見るダッシュボード（Bun ＋ TypeScript）。

- 探索開始フォルダの下から `.gsd-lite/` を持つディレクトリを探し、親フォルダ名をアプリ名として並べる
- 既定で 60 秒ごとに走査し、`state.json`・`PLAN.md`・`PROGRESS.md`・`loop.pid` の mtime が変わったプロジェクトだけ読み直す
- 画面ではプロジェクトごとに、フェーズ・ターン数・タスクの完了数・今のタスク・直近のターン・ループの稼働を出す。起動後に検知した変化（フェーズの遷移、ターンやタスクの進み、ループの起動と停止）は履歴に並ぶ
- 画面の「通知を有効にする」を押して許可すると、タブを開いている間はブラウザ通知（OS の通知）で知らせる: phase が blocked / done に変わったとき、ループが止まりそのとき phase が done / blocked 以外のとき。ページを開いた直後の状態では出さず、前回の取得結果からの変化だけ（判定は `src/notify.ts`）。外部サービスには何も送らない。https か localhost でだけ動く
- 対応する形: in-repo（`.gsd-lite/state.json`）と gsd-control（`.gsd-lite/milestones/<slug>/state.json`）

## 使い方

```bash
bun install
bun run start                      # http://127.0.0.1:3300/app02-gsd-monitor/
bun run start -- --root ~/workspaces/dev --interval 60 --port 3300 --base-path /app02-gsd-monitor/
bun run start -- --exclude '*/archive/*'    # 除外を足す（既定の除外 '*/components/*' に加わる）
bun run start -- --no-default-exclude     # components/ の写しも出す
bun test
bun run typecheck
```

ポートは 3300 から探し、使用中なら +1 ずつ空きを探す（実際のポートは起動時の 1 行目に出る）。すべての URL は `--base-path`（既定 `/app02-gsd-monitor/`）の下に置く。
画面の JS / CSS も起動時にこのプレフィックス付きで束ねるので、同じプレフィックスでリバースプロキシに載せられる。
常駐は systemd user サービス（`docs/systemd/gsd-monitor.service`。導入手順はファイル冒頭。ログは `journalctl --user -u gsd-monitor`）。
`bun run start` は `--host 0.0.0.0` で待ち受ける（このマシンの外のリバースプロキシ https://fre.future.co.jp/app02-gsd-monitor/ から届くように）。CLI の既定は 127.0.0.1。

## 読み方

| 項目 | 出どころ |
|---|---|
| アプリ名 | `.gsd-lite` の親フォルダ名 |
| フェーズ・ターン・次のコマンド・verify の回数 | `state.json` |
| タスク（完了数 / 総数・今のタスク） | `PLAN.md` の `## Tasks` 節の `- [x] T1: 題` / `- [ ] T2: 題` |
| タスクのグループ（「今回」の行・一覧の区切り） | `## Tasks` 節の中の `### 修正ラウンド 1（…）` 見出し（括弧書きの前までを名前にする）。見出しが無ければ出さない |
| 直近のターン | `PROGRESS.md` の最後の `## turn N — phase — 題` |
| 稼働中 | `.gsd-lite/loop.pid` のプロセスが生きている |
| blocked | `state.json` の `phase` が `blocked`（`BLOCKED.md` は解決後も残るので見ない） |
| BLOCKED の見出し（通知の本文） | blocked のときだけ、`BLOCKED.md` の最初の見出し |

既定で `*/components/*`（他リポジトリに取り込んだ部品の写し。元のリポジトリと二重に出るため）を除く。`.gsd-lite` の中（scratch の写し）・`.git`・`node_modules`・`.venv` には降りない。
