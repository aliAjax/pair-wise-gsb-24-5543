/** 记录类别：坐标基准 / 探方 / 地层 / 遗迹单位 / 出土物 */
export type RecordKind = "datum" | "trench" | "layer" | "feature" | "artifact";

/** 单字段版本：每次字段级修改都留下 值 + 版本号 + 操作人 + 时间 */
export interface FieldVersion {
  value: unknown;
  rev: number;
  by: string;
  at: number;
}

/** 版本化记录：rev 为记录级版本，字段各自携带写入时的版本 */
export interface VersionedRecord {
  id: string;
  kind: RecordKind;
  rev: number;
  fields: Record<string, FieldVersion>;
}

/** 离线改动：带原版本（baseRev / baseFieldRev），回连时据此做三路合并 */
export interface OfflineChange {
  recordId: string;
  field: string;
  value: unknown;
  baseRev: number;
  baseFieldRev: number;
  by: string;
  at: number;
}

/** 同字段冲突：本机版与对方版都保留，等待人工确认 */
export interface Conflict {
  id: string;
  recordId: string;
  kind: RecordKind;
  field: string;
  local: FieldVersion;
  remote: FieldVersion;
  detectedAt: number;
}

export type CoordStatus = "valid" | "stale" | "pending";

export interface AbsCoord {
  e: number;
  n: number;
  z: number;
}

/** 坐标依赖的版本指纹：任一依赖版本变化，坐标即失效 */
export interface CoordDeps {
  self: number;
  datum: number;
  trench: number;
  layer: number;
  feature: number;
}

/** 坐标状态：失效/待重算时保留旧值作为草稿参考 */
export interface CoordState {
  status: CoordStatus;
  abs: AbsCoord | null;
  deps: CoordDeps | null;
  reason: string | null;
  updatedAt: number;
}

/** 重算待办：失败保留，下次打开继续 */
export interface RecomputeTask {
  recordId: string;
  kind: RecordKind;
  cause: string;
  attempts: number;
  lastError: string | null;
  enqueuedAt: number;
  status: "pending" | "failed";
}

export interface LogEntry {
  at: number;
  tone: "info" | "ok" | "warn" | "conflict";
  text: string;
}

export interface StoreState {
  online: boolean;
  localSeq: number;
  serverSeq: number;
  syncSeq: number;
  idSeq: number;
  /** 本机副本 */
  local: Record<string, VersionedRecord>;
  /** 对方（领队端）副本，模拟服务器 */
  server: Record<string, VersionedRecord>;
  /** 上次同步时各字段的版本（三路合并的基线） */
  syncedFields: Record<string, Record<string, number>>;
  outbox: OfflineChange[];
  conflicts: Conflict[];
  coords: Record<string, CoordState>;
  tasks: RecomputeTask[];
  log: LogEntry[];
}
