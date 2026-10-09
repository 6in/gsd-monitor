// サーバーと画面で共有する型（/api/status の形）

export interface Task {
  id: string;
  title: string;
  done: boolean;
}

/** 1 つの state.json から読めること */
export interface Milestone {
  /** .gsd-lite の親フォルダ名 */
  app: string;
  /** プロジェクトのディレクトリ（絶対パス） */
  path: string;
  statePath: string;
  milestone: string;
  phase: string;
  nextCommand: string;
  turn: number | null;
  maxTurns: number | null;
  verifyRound: number | null;
  verifyRoundMax: number | null;
  fixRound: number | null;
  branch: string;
  engine: string;
  updatedAt: string;
  /** state.json の mtime（ミリ秒） */
  stateMtime: number;
  tasks: Task[];
  tasksDone: number;
  tasksTotal: number;
  /** 最初の未完了タスクの ID */
  currentTask: string;
  /** PROGRESS.md の最後の「## turn N — phase — 題」 */
  lastTurn: string;
  loopRunning: boolean;
  blocked: boolean;
  error: string;
}

export interface MonitorEvent {
  /** ミリ秒 */
  at: number;
  app: string;
  path: string;
  milestone: string;
  text: string;
}

export interface Status {
  root: string;
  intervalSec: number;
  lastScan: number;
  scanCount: number;
  projects: Milestone[];
  events: MonitorEvent[];
}
