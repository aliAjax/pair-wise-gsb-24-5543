import { computeAbs, currentDeps, DEP_LABEL } from "./coord";
import { makeRecord } from "./model";
import { seedState } from "./seed";
import type {
  CoordDeps,
  LogEntry,
  RecordKind,
  RecomputeTask,
  StoreState,
  VersionedRecord,
} from "./types";

export const AUTHOR_LOCAL = "记录员（本机）";
export const AUTHOR_PEER = "领队端（对方）";

const STORAGE_KEY = "hxwl10.fieldstore.v1";

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function log(s: StoreState, tone: LogEntry["tone"], text: string) {
  s.log.unshift({ at: Date.now(), tone, text });
  if (s.log.length > 80) s.log.length = 80;
}

function setSynced(s: StoreState, id: string, field: string, rev: number) {
  (s.syncedFields[id] ??= {})[field] = rev;
}

/** 本机登记：写入本机副本并进入待同步清单，改动带原版本 */
function applyLocalEdit(
  s: StoreState,
  recordId: string,
  field: string,
  value: unknown
): { baseRev: number; baseFieldRev: number } | null {
  const rec = s.local[recordId];
  if (!rec) return null;
  const prev = s.outbox.find((o) => o.recordId === recordId && o.field === field);
  const baseRev = prev?.baseRev ?? rec.rev;
  const baseFieldRev = prev?.baseFieldRev ?? rec.fields[field]?.rev ?? 0;
  rec.rev += 1;
  rec.fields[field] = { value, rev: rec.rev, by: AUTHOR_LOCAL, at: Date.now() };
  s.outbox = s.outbox.filter((o) => !(o.recordId === recordId && o.field === field));
  s.outbox.push({ recordId, field, value, baseRev, baseFieldRev, by: AUTHOR_LOCAL, at: Date.now() });
  s.localSeq += 1;
  return { baseRev, baseFieldRev };
}

function createLocal(s: StoreState, kind: RecordKind, id: string, fields: Record<string, unknown>) {
  s.local[id] = { id, kind, rev: 0, fields: {} };
  for (const [field, value] of Object.entries(fields)) applyLocalEdit(s, id, field, value);
}

/** 对方改动：直接写入对方副本（模拟服务器），不参与本机合并 */
function peerEdit(s: StoreState, recordId: string, field: string, value: unknown) {
  const rec = s.server[recordId];
  if (!rec) return;
  rec.rev += 1;
  rec.fields[field] = { value, rev: rec.rev, by: AUTHOR_PEER, at: Date.now() };
}

/**
 * 回连合并：以 syncedFields 为基线逐字段三路合并。
 * 仅一侧改动 → 采用该侧；两侧改同一字段且值不同 → 冲突，两版都保留，待确认。
 */
function doSync(s: StoreState) {
  s.syncSeq += 1;
  let pushed = 0;
  let pulled = 0;
  let created = 0;
  let conflicts = 0;
  const ids = new Set([...Object.keys(s.local), ...Object.keys(s.server)]);
  for (const id of ids) {
    const l = s.local[id];
    const r = s.server[id];
    if (l && !r) {
      s.server[id] = structuredClone(l);
      for (const [f, fv] of Object.entries(l.fields)) setSynced(s, id, f, fv.rev);
      created += 1;
      log(s, "ok", `新增记录 ${id} 已推送给对方`);
      continue;
    }
    if (!l && r) {
      s.local[id] = structuredClone(r);
      for (const [f, fv] of Object.entries(r.fields)) setSynced(s, id, f, fv.rev);
      created += 1;
      log(s, "ok", `接收对方新增记录 ${id}`);
      continue;
    }
    if (!l || !r) continue;
    const fields = new Set([...Object.keys(l.fields), ...Object.keys(r.fields)]);
    for (const f of fields) {
      const lf = l.fields[f];
      const rf = r.fields[f];
      const syncRev = s.syncedFields[id]?.[f] ?? 0;
      const lChanged = !!lf && lf.rev !== syncRev;
      const rChanged = !!rf && rf.rev !== syncRev;
      if (lChanged && rChanged && lf && rf) {
        if (sameValue(lf.value, rf.value)) {
          setSynced(s, id, f, lf.rev);
        } else {
          const existing = s.conflicts.find((c) => c.recordId === id && c.field === f);
          if (existing) {
            existing.local = structuredClone(lf);
            existing.remote = structuredClone(rf);
            existing.detectedAt = Date.now();
          } else {
            s.conflicts.push({
              id: `${id}:${f}`,
              recordId: id,
              kind: l.kind,
              field: f,
              local: structuredClone(lf),
              remote: structuredClone(rf),
              detectedAt: Date.now(),
            });
            conflicts += 1;
            log(s, "conflict", `字段冲突 ${id}.${f}：两版均已保留待确认，不再互相覆盖`);
          }
        }
      } else if (lChanged && lf) {
        r.fields[f] = structuredClone(lf);
        r.rev = Math.max(r.rev, lf.rev);
        setSynced(s, id, f, lf.rev);
        pushed += 1;
        log(s, "ok", `合并 ${id}.${f} ← 本机 v${lf.rev}`);
      } else if (rChanged && rf) {
        l.fields[f] = structuredClone(rf);
        l.rev = Math.max(l.rev, rf.rev);
        setSynced(s, id, f, rf.rev);
        pulled += 1;
        log(s, "ok", `合并 ${id}.${f} ← 对方 v${rf.rev}`);
      } else {
        const rev = Math.max(lf?.rev ?? 0, rf?.rev ?? 0);
        if (rev > 0) setSynced(s, id, f, rev);
      }
    }
  }
  // 重建待同步清单：已对齐的离线改动出列，冲突中的本机版本保留待确认
  s.outbox = s.outbox.filter(
    (c) => (s.local[c.recordId]?.fields[c.field]?.rev ?? -1) !== (s.syncedFields[c.recordId]?.[c.field] ?? 0)
  );
  log(s, "info", `第 ${s.syncSeq} 轮回连合并完成：推送 ${pushed} 项、接收 ${pulled} 项、新增 ${created} 条、冲突保留 ${conflicts} 项`);
}

function upsertTask(s: StoreState, rec: VersionedRecord, cause: string) {
  const t = s.tasks.find((x) => x.recordId === rec.id);
  if (t) {
    t.cause = cause;
    if (t.status === "failed") t.status = "pending";
  } else {
    const task: RecomputeTask = {
      recordId: rec.id,
      kind: rec.kind,
      cause,
      attempts: 0,
      lastError: null,
      enqueuedAt: Date.now(),
      status: "pending",
    };
    s.tasks.push(task);
  }
}

function depsChanged(a: CoordDeps, b: CoordDeps): (keyof CoordDeps)[] {
  return (Object.keys(a) as (keyof CoordDeps)[]).filter((k) => a[k] !== b[k]);
}

/**
 * 失效传播 + 重算：依赖（坐标基准/探方原点/地层关系/所属遗迹/自身坐标）任一版本变化，
 * 坐标即失效并排入重算；失败保留草稿与待办，下次打开继续。
 */
function revalidate(s: StoreState) {
  for (const rec of Object.values(s.local)) {
    if (rec.kind !== "feature" && rec.kind !== "artifact") continue;
    const deps = currentDeps(rec, s.local);
    const cur = s.coords[rec.id];
    const diff = cur?.deps ? depsChanged(deps, cur.deps) : null;
    if (!cur || !cur.deps || (diff && diff.length > 0)) {
      const cause = !cur?.deps ? "初始登记" : `${diff!.map((k) => DEP_LABEL[k]).join("、")}已变更`;
      upsertTask(s, rec, cause);
      if (!cur || cur.status === "valid") log(s, "warn", `${rec.id} 坐标失效：${cause}，等待重算`);
      s.coords[rec.id] = {
        status: "stale",
        abs: cur?.abs ?? null,
        deps: cur?.deps ?? null,
        reason: cause,
        updatedAt: Date.now(),
      };
    }
  }
  for (const task of [...s.tasks]) {
    const rec = s.local[task.recordId];
    if (!rec) {
      s.tasks = s.tasks.filter((t) => t !== task);
      continue;
    }
    const res = computeAbs(rec, s.local);
    task.attempts += 1;
    if (res.ok) {
      s.coords[rec.id] = { status: "valid", abs: res.abs, deps: res.deps, reason: null, updatedAt: Date.now() };
      s.tasks = s.tasks.filter((t) => t !== task);
      log(s, "ok", `${rec.id} 坐标重算成功：E ${res.abs.e.toFixed(2)} / N ${res.abs.n.toFixed(2)} / Z ${res.abs.z.toFixed(2)}`);
    } else {
      const cur = s.coords[rec.id];
      s.coords[rec.id] = {
        status: "pending",
        abs: cur?.abs ?? null,
        deps: cur?.deps ?? null,
        reason: res.error,
        updatedAt: Date.now(),
      };
      if (task.lastError !== res.error) {
        log(s, "warn", `${rec.id} 坐标重算失败：${res.error}；草稿与待办已保留，下次打开继续`);
      }
      task.lastError = res.error;
      task.status = "failed";
    }
  }
}

function persist(s: StoreState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 存储不可用时仅保留内存态 */
  }
}

function load(): StoreState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoreState;
    if (!parsed || !parsed.local || !parsed.server || !parsed.syncedFields) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class FieldStore {
  private state: StoreState;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = load() ?? seedState();
    const pending = this.state.tasks.length;
    // 下次打开继续：未完成的重算在打开时自动重试
    this.commit((s) => {
      log(
        s,
        "info",
        pending > 0
          ? `打开现场档案：继续上次未完成的 ${pending} 项坐标重算`
          : "打开现场档案：无待办，依赖坐标均为最新"
      );
    });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.state;

  private commit(mut: (s: StoreState) => void, opts: { sync?: boolean } = {}) {
    const next = structuredClone(this.state);
    mut(next);
    if (next.online && opts.sync !== false) doSync(next);
    revalidate(next);
    this.state = next;
    persist(next);
    this.listeners.forEach((fn) => fn());
  }

  /** 本机登记（在线时随改动自动合并；离线时带原版本暂存） */
  edit(recordId: string, field: string, value: unknown) {
    this.commit((s) => {
      const base = applyLocalEdit(s, recordId, field, value);
      if (base) {
        log(
          s,
          "info",
          `登记 ${recordId}.${field}（基于 v${base.baseRev}）${s.online ? "" : "［离线，待回连合并］"}`
        );
      }
    });
  }

  create(kind: "layer" | "feature" | "artifact"): string {
    const prefix = { layer: "L", feature: "H", artifact: "A" }[kind];
    const id = `${prefix}${String(this.state.idSeq + 1).padStart(3, "0")}`;
    this.commit((s) => {
      s.idSeq += 1;
      const trenchId = Object.values(s.local).find((r) => r.kind === "trench")?.id ?? "";
      const defaults: Record<string, Record<string, unknown>> = {
        layer: { trenchId, name: "新层位", soilColor: "", depthTop: null, depthBottom: null, overlies: [], note: "" },
        feature: { trenchId, ftype: "灰坑", name: "新遗迹", layerId: "", localE: null, localN: null, localZ: null, note: "" },
        artifact: { trenchId, name: "新出土物", featureId: "", layerId: "", localE: null, localN: null, localZ: null, note: "" },
      };
      createLocal(s, kind, id, defaults[kind]);
      log(s, "info", `新增记录 ${id}，请补全字段`);
    });
    return id;
  }

  setOnline(online: boolean) {
    this.commit(
      (s) => {
        s.online = online;
        if (online) {
          log(s, "info", "回连：开始按字段合并");
          doSync(s);
        } else {
          log(s, "warn", "已断网：登记将带原版本暂存本机，回连后按字段合并");
        }
      },
      { sync: false }
    );
  }

  syncNow() {
    this.commit(
      (s) => {
        if (s.online) doSync(s);
        else log(s, "warn", "当前离线，无法合并；请先回连");
      },
      { sync: false }
    );
  }

  /** 冲突确认：选定一版写入双方副本，另一版留存于日志（需在线） */
  resolveConflict(conflictId: string, keep: "local" | "remote") {
    if (!this.state.online) return;
    this.commit(
      (s) => {
        const c = s.conflicts.find((x) => x.id === conflictId);
        if (!c) return;
        const winner = keep === "local" ? c.local : c.remote;
        const loser = keep === "local" ? c.remote : c.local;
        for (const replica of [s.local, s.server]) {
          const rec = replica[c.recordId];
          if (!rec) continue;
          rec.fields[c.field] = structuredClone(winner);
          rec.rev = Math.max(rec.rev, winner.rev);
        }
        setSynced(s, c.recordId, c.field, winner.rev);
        s.conflicts = s.conflicts.filter((x) => x.id !== conflictId);
        s.outbox = s.outbox.filter(
          (o) => (s.local[o.recordId]?.fields[o.field]?.rev ?? -1) !== (s.syncedFields[o.recordId]?.[o.field] ?? 0)
        );
        log(
          s,
          "ok",
          `冲突 ${c.recordId}.${c.field} 已确认：采用${keep === "local" ? "本机" : "对方"} v${winner.rev}「${JSON.stringify(winner.value)}」；另版 v${loser.rev}「${JSON.stringify(loser.value)}」留存于此`
        );
      },
      { sync: false }
    );
  }

  retryTasks() {
    this.commit((s) => {
      if (s.tasks.length > 0) log(s, "info", `手动重试 ${s.tasks.length} 项坐标重算`);
    });
  }

  /** 演示：断网期间本机登记（H12 复测、L103 土色、新增陶纺轮） */
  demoLocal() {
    this.commit((s) => {
      applyLocalEdit(s, "H12", "localE", 2.6);
      applyLocalEdit(s, "H12", "localN", 3.55);
      applyLocalEdit(s, "H12", "note", "记录员：坑壁局部坍塌，东缘复测");
      applyLocalEdit(s, "L103", "soilColor", "灰褐夹烧土");
      const id = `A${String((s.idSeq += 1)).padStart(3, "0")}`;
      createLocal(s, "artifact", id, {
        trenchId: "T0203",
        name: "陶纺轮",
        featureId: "H12",
        layerId: "L103",
        localE: 2.55,
        localN: 3.5,
        localZ: 1.15,
        note: "断网期间登记",
      });
      log(s, "info", `断网登记完成：H12 复测、L103 土色修订、新增 ${id} 陶纺轮（均带原版本，待回连合并）`);
    });
  }

  /** 演示：对方补录地层关系（新增 L104，L103 叠压于 L104） */
  peerStrata() {
    this.commit(
      (s) => {
        if (s.server["L104"]) return;
        s.server["L104"] = makeRecord("L104", "layer", {
          trenchId: "T0203",
          name: "第4层",
          soilColor: "灰黑土",
          depthTop: null,
          depthBottom: null,
          overlies: [],
          note: "新确认层位，深度待测",
        }, AUTHOR_PEER);
        peerEdit(s, "L103", "overlies", ["L104"]);
        s.serverSeq += 1;
        log(s, "warn", "对方（领队端）补录地层关系：新增 L104，L103 叠压于 L104；深度未闭合");
      },
      { sync: false }
    );
  }

  /** 演示：对方改动 H12（层位、N 坐标、备注） */
  peerFeature() {
    this.commit(
      (s) => {
        if (!s.server["L104"]) return;
        peerEdit(s, "H12", "layerId", "L104");
        peerEdit(s, "H12", "localN", 3.6);
        peerEdit(s, "H12", "note", "领队：开口改第4层下，坐标复测待核");
        s.serverSeq += 1;
        log(s, "warn", "对方（领队端）改动 H12：开口层位→L104、复测 N 坐标、备注");
      },
      { sync: false }
    );
  }

  /** 演示：对方调整坐标基准（北偏角 12° → 12.4°） */
  peerDatum() {
    this.commit(
      (s) => {
        peerEdit(s, "datum", "rotationDeg", 12.4);
        s.serverSeq += 1;
        log(s, "warn", "对方（领队端）调整坐标基准：北偏角 12° → 12.4°");
      },
      { sync: false }
    );
  }

  reset() {
    this.state = seedState();
    persist(this.state);
    this.listeners.forEach((fn) => fn());
  }
}

export const store = new FieldStore();
