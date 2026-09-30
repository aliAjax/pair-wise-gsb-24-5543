import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState, Entity, EntityType, LogEntry, OutboxChange } from "./types";
import {
  COMPUTED_KEYS,
  cascadeInvalidate,
  recomputeAll,
} from "./model";
import { mergeOnReconnect } from "./sync";
import { buildSeed } from "./seed";

const STORAGE_KEY = "hxwl-10-fieldbook-v1";
const CURRENT_USER = "本机记录员";
const PEER_USER = "对端记录员";
const LOG_LIMIT = 100;

// ---------------------------------------------------------------------------
// 打开档案时自动继续：跑一轮重算，消化上次遗留的待办
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function withInitialRecompute(state: AppState): void {
  // 打开档案即继续：强制重算一轮，消化上次遗留的待办与未算坐标
  const outcomes = recomputeAll(state.entities, { force: true });
  const failed = outcomes.filter((o) => !o.ok) as {
    id: string;
    reason: string;
  }[];
  const now = state.lastSyncAt ?? Date.now();
  state.todos = failed.map((f) => {
    const old = state.todos.find((t) => t.entityId === f.id);
    return {
      entityId: f.id,
      reason: f.reason,
      createdAt: old?.createdAt ?? now,
    };
  });
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const state = JSON.parse(raw) as AppState;
      withInitialRecompute(state);
      return state;
    }
  } catch {
    // 存档损坏时回落到示例档案
  }
  const { state } = buildSeed();
  withInitialRecompute(state);
  return state;
}

let state: AppState = loadState();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储空间不足等情况：内存中的现场记录仍可继续
  }
}

function setState(mut: () => void) {
  mut();
  persist();
  listeners.forEach((l) => l());
}

function addLog(kind: LogEntry["kind"], text: string) {
  state.logs.unshift({ time: Date.now(), kind, text });
  if (state.logs.length > LOG_LIMIT) state.logs.length = LOG_LIMIT;
}

// ---------------------------------------------------------------------------
// 重算：成功的条目摘掉待办；失败的条目保留原因与草稿，等下次继续
// ---------------------------------------------------------------------------

function runRecompute(silent = false): { ok: number; failed: number } {
  const outcomes = recomputeAll(state.entities);
  const oldTodos = new Map(state.todos.map((t) => [t.entityId, t]));
  const failed = outcomes.filter((o) => !o.ok) as {
    id: string;
    reason: string;
  }[];
  const now = Date.now();
  state.todos = failed.map((f) => ({
    entityId: f.id,
    reason: f.reason,
    createdAt: oldTodos.get(f.id)?.createdAt ?? now,
  }));
  const okCount = outcomes.filter((o) => o.ok).length;
  if (!silent && (okCount || failed.length)) {
    addLog(
      "recompute",
      `重算完成：${okCount} 项恢复可用，${failed.length} 项保留待办`
    );
  }
  return { ok: okCount, failed: failed.length };
}

function applyCascade(id: string, changedKeys: string[]) {
  if (!changedKeys.length) return;
  const result = cascadeInvalidate(state.entities, id, changedKeys, Date.now());
  result.logs.forEach((l) => addLog("invalidate", l.text));
}

function nextId(): string {
  return `e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)
    .toString(36)
    .padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

export const actions = {
  toggleOnline(): void {
    setState(() => {
      const next = !state.online;
      state.online = next;
      if (next) {
        addLog("system", "网络恢复，开始回连合并");
        doSync();
      } else {
        addLog("system", "已断网：改动保留在本机并记录原版本，回连后合并");
      }
    });
  },

  sync(): void {
    setState(() => {
      if (!state.online) return;
      doSync();
    });
  },

  editEntity(id: string, patch: Record<string, string>): void {
    setState(() => {
      const e = state.entities[id];
      if (!e) return;
      const changedKeys = Object.keys(patch).filter(
        (k) => (e.fields[k] ?? "") !== patch[k] && !(k in e.conflicts)
      );
      if (!changedKeys.length) return;

      const now = Date.now();
      if (!state.online) {
        // 离线：锁住改动前的原版本与原字段值
        let box = state.outbox.find((o) => o.entityId === id);
        if (!box) {
          box = {
            entityId: id,
            baseVersion: e.version,
            baseFields: { ...e.fields },
            changes: {},
            createdAt: now,
            updatedAt: now,
          };
          state.outbox.push(box);
        }
        changedKeys.forEach((k) => {
          box!.changes[k] = patch[k];
          e.fields[k] = patch[k];
        });
        box.updatedAt = now;
        e.version += 1; // baseVersion 保持不动，作为三方合并依据
        e.updatedAt = now;
        e.updatedBy = CURRENT_USER;
        addLog(
          "edit",
          `离线登记 ${e.type === "square" ? "探方" : ""}${e.code} v${e.version}（原版本 v${e.baseVersion}，待回连 ${changedKeys.length} 个字段）`
        );
      } else {
        changedKeys.forEach((k) => (e.fields[k] = patch[k]));
        e.version += 1;
        e.baseVersion = e.version;
        e.updatedAt = now;
        e.updatedBy = CURRENT_USER;
        addLog("edit", `登记 ${e.code} v${e.version}（${changedKeys.length} 个字段，已同步）`);
      }

      applyCascade(id, changedKeys);
      runRecompute(true);
      if (state.online) state.remote[id] = clone(e);
    });
  },

  addEntity(type: EntityType, parentId: string | null, fields: Record<string, string>): void {
    setState(() => {
      const now = Date.now();
      const computedKeys = COMPUTED_KEYS[type];
      const e: Entity = {
        id: nextId(),
        type,
        code: fields.code || "未命名",
        parentId,
        fields,
        computed: Object.fromEntries(computedKeys.map((k) => [k, null])),
        version: 1,
        baseVersion: 1,
        origin: "local",
        isDraft: !state.online,
        conflicts: {},
        invalidated:
          computedKeys.length > 0
            ? { keys: computedKeys, reason: "新登记，等待重算", sinceVersion: now }
            : null,
        updatedAt: now,
        updatedBy: CURRENT_USER,
      };
      state.entities[e.id] = e;

      if (state.online) {
        state.remote[e.id] = clone(e);
      } else {
        const box: OutboxChange = {
          entityId: e.id,
          baseVersion: 0,
          baseFields: {},
          changes: { ...fields },
          createdAt: now,
          updatedAt: now,
        };
        state.outbox.push(box);
        addLog("edit", `离线新建草稿 ${e.code}，回连后上传`);
      }

      // 新地层会改变探方高程链；新遗迹/出土物自身坐标待算
      if (type === "stratum") {
        applyCascade(e.id, ["order", "thickness"]);
      }
      runRecompute(true);
      if (state.online) state.remote[e.id] = clone(e);
    });
  },

  /** 模拟对端（另一台设备）在服务端上的改动，回连时才并入本机 */
  simulateRemoteEdit(id: string, patch: Record<string, string>): void {
    setState(() => {
      const rem = state.remote[id];
      if (!rem) return;
      const keys = Object.keys(patch).filter((k) => rem.fields[k] !== patch[k]);
      if (!keys.length) return;
      keys.forEach((k) => (rem.fields[k] = patch[k]));
      rem.version += 1;
      rem.updatedAt = Date.now();
      rem.updatedBy = PEER_USER;
      addLog("system", `（模拟）对端改动 ${rem.code} v${rem.version}：${keys.length} 个字段，待回连`);
    });
  },

  /** 一键布置典型离线分歧：字段合并 + 同字段双版冲突 + 级联失效 */
  stageDivergence(): void {
    setState(() => {
      state.online = false;
      const s1 = Object.values(state.entities).find((e) => e.code === "第3层");
      const p1 = Object.values(state.entities).find((e) => e.code === "陶片12");
      if (!s1 || !p1) return;

      const now = Date.now();
      const localPatch = (
        e: Entity,
        patch: Record<string, string>
      ): string[] => {
        const changed = Object.keys(patch).filter(
          (k) => e.fields[k] !== patch[k]
        );
        if (!changed.length) return [];
        let box = state.outbox.find((o) => o.entityId === e.id);
        if (!box) {
          box = {
            entityId: e.id,
            baseVersion: e.version,
            baseFields: { ...e.fields },
            changes: {},
            createdAt: now,
            updatedAt: now,
          };
          state.outbox.push(box);
        }
        changed.forEach((k) => {
          box!.changes[k] = patch[k];
          e.fields[k] = patch[k];
        });
        e.version += 1;
        e.updatedAt = now;
        e.updatedBy = CURRENT_USER;
        return changed;
      };

      // 本机离线补录
      const c1 = localPatch(s1, { relation: "平行" });
      const c2 = localPatch(p1, { relX: "0.6" });
      applyCascade(s1.id, c1);
      applyCascade(p1.id, c2);
      runRecompute(true);

      // 对端在服务端：地层关系改向（同字段冲突），填土补录（不同字段自动合并），坐标另录一版
      const remotePatch = (e: Entity, patch: Record<string, string>) => {
        const rem = state.remote[e.id];
        if (!rem) return;
        Object.keys(patch).forEach((k) => (rem.fields[k] = patch[k]));
        rem.version += 1;
        rem.updatedAt = now;
        rem.updatedBy = PEER_USER;
      };
      remotePatch(s1, { relation: "打破", soilColor: "灰褐土，夹炭屑" });
      remotePatch(p1, { relX: "0.5" });

      addLog(
        "edit",
        `离线登记 第3层 v${s1.version}、陶片12 v${p1.version}，原版本已锁定待回连`
      );
      addLog("system", "（模拟）对端改了同批字段并补录填土描述，待回连");
      state.notice =
        "已布置分歧：本机离线改了第3层关系与陶片12坐标，对端另录一版并补了填土描述。点击「回连同步」查看按字段合并与双版冲突。";
    });
  },

  resolveConflict(id: string, key: string, value: string): void {
    setState(() => {
      const e = state.entities[id];
      if (!e || !e.conflicts[key]) return;
      const now = Date.now();
      delete e.conflicts[key];
      e.fields[key] = value;
      e.version += 1;
      e.updatedAt = now;
      e.updatedBy = `${CURRENT_USER}（冲突确认）`;
      addLog("conflict", `冲突已确认 ${e.code} · ${key} = ${value}，v${e.version}`);

      if (state.online) {
        e.baseVersion = e.version;
        state.remote[id] = clone(e);
      } else {
        let box = state.outbox.find((o) => o.entityId === id);
        if (!box) {
          box = {
            entityId: id,
            baseVersion: e.baseVersion,
            baseFields: { ...e.fields },
            changes: {},
            createdAt: now,
            updatedAt: now,
          };
          state.outbox.push(box);
        }
        box.changes[key] = value;
      }
      applyCascade(id, [key]);
      runRecompute(true);
    });
  },

  retryRecompute(): void {
    setState(() => {
      addLog("system", "继续待办：重新尝试失效坐标重算");
      runRecompute(false);
    });
  },

  dismissNotice(): void {
    setState(() => {
      state.notice = null;
    });
  },

  resetDemo(): void {
    setState(() => {
      const fresh = buildSeed().state;
      withInitialRecompute(fresh);
      state.online = fresh.online;
      state.entities = fresh.entities;
      state.remote = fresh.remote;
      state.outbox = [];
      state.todos = [];
      state.logs = fresh.logs;
      state.lastSyncAt = fresh.lastSyncAt;
      state.notice = "档案已重置为初始示例";;
    });
  },
};

function doSync(): void {
  if (!state.online) return;
  const pendingCount = state.outbox.length;
  const summary = mergeOnReconnect({
    entities: state.entities,
    remote: state.remote,
    outbox: state.outbox,
    at: Date.now(),
  });
  state.outbox = [];
  state.lastSyncAt = Date.now();

  // 合并触及的依赖字段 → 级联失效后统一重算
  for (const item of summary.merged) {
    applyCascade(item.id, item.changedKeys);
  }
  runRecompute(true);

  const conflictCount = summary.conflicts.length;
  addLog(
    "sync",
    `回连同步：上传离线草稿 ${summary.pushed.length}，自动合并 ${summary.merged.length}（待发 ${pendingCount} 条），导入对端 ${summary.imported.length}，同字段冲突 ${conflictCount} 项待确认`
  );
  state.notice =
    conflictCount > 0
      ? `同步完成：${conflictCount} 个记录存在同字段冲突，两版均已保留，请在「待确认项」中取舍；受影响坐标已失效并等待重算。`
      : "同步完成：字段已按字段合并，无冲突。";
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return state;
}

const ActionsContext = createContext(actions);

export function StoreProvider({ children }: { children: ReactNode }) {
  return (
    <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
  );
}

export function useStore(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useActions() {
  return useContext(ActionsContext);
}
