// 现场记录的核心数据结构：
// 所有实体（探方 / 地层 / 遗迹单位 / 出土物）统一成一张版本化的记录表，
// 以支持「离线改动带原版本、按字段合并、同字段冲突保留两版」。

export type EntityType = "square" | "stratum" | "feature" | "find";

/** 同字段冲突：原版本（共同祖先）与本机、对端两版同时保留，等待人工确认 */
export interface FieldConflict {
  key: string;
  base: string;
  local: string;
  remote: string;
  baseVersion: number;
  localVersion: number;
  remoteVersion: number;
}

/** 失效标记：地层关系或坐标基准变化后，依赖它们的派生坐标/高程全部失效 */
export interface Invalidation {
  /** 失效的派生字段（absX / topElev …） */
  keys: string[];
  /** 失效原因（谁的哪一项变更引起） */
  reason: string;
  sinceVersion: number;
}

export interface Entity {
  id: string;
  type: EntityType;
  /** 探方编号 / 地层编号 / 遗迹编号 / 出土物编号 */
  code: string;
  parentId: string | null;

  /** 当前字段值；存在冲突的字段先保留「原版本」值，待确认后替换 */
  fields: Record<string, string>;
  /** 重算得到的派生坐标、高程；失效或重算失败时为 null */
  computed: Record<string, string | null>;

  /** 当前版本号，每次改动 +1 */
  version: number;
  /** 离线改动所基于的原版本号（回连三方合并的依据） */
  baseVersion: number;
  origin: "local" | "remote" | "merged";
  /** 本机离线新建、尚未回连同步的草稿 */
  isDraft: boolean;

  /** 待确认的同字段冲突，按字段存放 */
  conflicts: Record<string, FieldConflict>;
  invalidated: Invalidation | null;

  updatedAt: number;
  updatedBy: string;
}

/** 离线发件箱：每个实体一条，按字段累积，baseFields 锁住原版本值 */
export interface OutboxChange {
  entityId: string;
  baseVersion: number;
  baseFields: Record<string, string>;
  changes: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** 重算待办：重算失败时保留，下次打开档案自动继续 */
export interface RecomputeTodo {
  entityId: string;
  reason: string;
  createdAt: number;
}

export interface LogEntry {
  time: number;
  kind: "sync" | "edit" | "invalidate" | "recompute" | "conflict" | "system";
  text: string;
}

export interface AppState {
  online: boolean;
  /** 本机档案库（localStorage 持久化，断网可继续登记） */
  entities: Record<string, Entity>;
  /** 服务端 / 对端影子库，仅用于在纯前端演示回连合并 */
  remote: Record<string, Entity>;
  outbox: OutboxChange[];
  todos: RecomputeTodo[];
  logs: LogEntry[];
  lastSyncAt: number | null;
  notice: string | null;
}
