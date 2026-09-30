import {
  AppState,
  Entity,
  EntityType,
  FieldConflict,
  Invalidation,
} from "./types";

// ---------------------------------------------------------------------------
// 字段定义：原始录入字段 vs 由地层关系 / 坐标基准推导出的重算字段
// ---------------------------------------------------------------------------

export interface FieldDef {
  key: string;
  label: string;
  kind: "text" | "number" | "select";
  placeholder?: string;
  options?: string[];
}

export const ENTITY_LABEL: Record<EntityType, string> = {
  square: "探方",
  stratum: "地层",
  feature: "遗迹单位",
  find: "出土物",
};

export const FIELDS: Record<EntityType, FieldDef[]> = {
  square: [
    { key: "code", label: "探方编号", kind: "text", placeholder: "如 T0203" },
    { key: "datumName", label: "坐标基准点", kind: "text", placeholder: "如 BM07" },
    { key: "datumX", label: "基准东坐标 E(m)", kind: "number" },
    { key: "datumY", label: "基准北坐标 N(m)", kind: "number" },
    { key: "datumZ", label: "基准高程(m)", kind: "number" },
    { key: "note", label: "备注", kind: "text" },
  ],
  stratum: [
    { key: "code", label: "地层编号", kind: "text", placeholder: "如 第3层" },
    { key: "order", label: "层序(自地表向下)", kind: "number" },
    { key: "thickness", label: "层厚(m)", kind: "number" },
    { key: "soilColor", label: "土色土质", kind: "text" },
    { key: "relation", label: "地层关系", kind: "select", options: ["叠压", "打破", "平行"] },
    { key: "note", label: "备注", kind: "text" },
  ],
  feature: [
    { key: "code", label: "遗迹编号", kind: "text", placeholder: "如 H12 灰坑" },
    { key: "kind", label: "遗迹类别", kind: "select", options: ["灰坑", "墓葬", "房址", "沟状遗迹", "柱洞"] },
    { key: "openDepth", label: "开口深度(m)", kind: "number" },
    { key: "offsetX", label: "相对基准点 E(m)", kind: "number" },
    { key: "offsetY", label: "相对基准点 N(m)", kind: "number" },
    { key: "soilColor", label: "填土描述", kind: "text" },
    { key: "note", label: "备注", kind: "text" },
  ],
  find: [
    { key: "code", label: "出土物编号", kind: "text", placeholder: "如 陶片12" },
    { key: "name", label: "名称", kind: "text" },
    { key: "relX", label: "相对遗迹/地层 E(m)", kind: "number" },
    { key: "relY", label: "相对遗迹/地层 N(m)", kind: "number" },
    { key: "depth", label: "出土深度(m,自地表)", kind: "number" },
    { key: "note", label: "备注", kind: "text" },
  ],
};

/** 需要重算的派生字段及其展示名 */
export const COMPUTED_LABEL: Record<string, string> = {
  topElev: "层顶高程(m)",
  bottomElev: "层底高程(m)",
  absX: "绝对坐标 E(m)",
  absY: "绝对坐标 N(m)",
  absElev: "绝对高程(m)",
};

export const COMPUTED_KEYS: Record<EntityType, string[]> = {
  square: [],
  stratum: ["topElev", "bottomElev"],
  feature: ["absX", "absY", "absElev"],
  find: ["absX", "absY", "absElev"],
};

/** 触发级联失效的关键字段 */
const DATUM_KEYS = ["datumName", "datumX", "datumY", "datumZ"];
const STRATUM_CHAIN_KEYS = ["order", "thickness", "relation"];

export function fieldLabel(type: EntityType, key: string): string {
  return (
    FIELDS[type].find((f) => f.key === key)?.label ??
    COMPUTED_LABEL[key] ??
    key
  );
}

// ---------------------------------------------------------------------------
// 依赖关系：探方 → 地层 → 遗迹单位 → 出土物
// ---------------------------------------------------------------------------

export function childrenOf(
  entities: Record<string, Entity>,
  parentId: string
): Entity[] {
  return Object.values(entities).filter((e) => e.parentId === parentId);
}

function descendants(
  entities: Record<string, Entity>,
  rootId: string
): Entity[] {
  const out: Entity[] = [];
  const walk = (pid: string) => {
    for (const child of childrenOf(entities, pid)) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(rootId);
  return out;
}

function squareOf(e: Entity, byId: Map<string, Entity>): Entity | null {
  let cur: Entity | undefined = e;
  while (cur) {
    if (cur.type === "square") return cur;
    if (!cur.parentId) return null;
    cur = byId.get(cur.parentId);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 级联失效
// 坐标基准一变 → 本探方全部遗迹、出土物坐标失效；
// 地层关系/层序/层厚一变 → 本探方高程链与开口于该层的遗迹、出土物失效。
// ---------------------------------------------------------------------------

export interface InvalidateResult {
  invalidIds: string[];
  logs: { id: string; text: string }[];
}

export function cascadeInvalidate(
  entities: Record<string, Entity>,
  changedId: string,
  changedKeys: string[],
  changedAt: number
): InvalidateResult {
  const changed = entities[changedId];
  if (!changed) return { invalidIds: [], logs: [] };
  const byId = new Map(Object.values(entities).map((e) => [e.id, e]));
  const targets = new Map<string, { keys: Set<string>; reasons: string[] }>();

  const mark = (id: string, keys: string[], reason: string) => {
    const slot = targets.get(id) ?? { keys: new Set<string>(), reasons: [] };
    keys.forEach((k) => slot.keys.add(k));
    if (!slot.reasons.includes(reason)) slot.reasons.push(reason);
    targets.set(id, slot);
  };

  const changedNames = changedKeys.map((k) => fieldLabel(changed.type, k));
  const because = `${ENTITY_LABEL[changed.type]}${changed.code}的${changedNames.join("、")}变更`;

  if (changed.type === "square") {
    if (changedKeys.some((k) => DATUM_KEYS.includes(k))) {
      // 基准变化：探方内所有地层高程链与遗迹/出土物坐标全部失效
      for (const d of descendants(entities, changedId)) {
        mark(d.id, COMPUTED_KEYS[d.type], because);
      }
    }
  } else if (changed.type === "stratum") {
    if (changedKeys.some((k) => STRATUM_CHAIN_KEYS.includes(k))) {
      const square = changed.parentId ? byId.get(changed.parentId) : null;
      // 同探方全部地层（高程链整体重算）
      const strata = square
        ? childrenOf(entities, square.id).filter((e) => e.type === "stratum")
        : [changed];
      for (const s of strata) mark(s.id, ["topElev", "bottomElev"], because);
      // 开口于本探方地层的遗迹，及其出土物
      const featureIds = new Set<string>();
      for (const s of strata) {
        for (const f of childrenOf(entities, s.id)) {
          if (f.type === "feature") {
            mark(f.id, ["absX", "absY", "absElev"], because);
            featureIds.add(f.id);
          }
        }
      }
      for (const fId of featureIds) {
        for (const fd of childrenOf(entities, fId)) {
          if (fd.type === "find") mark(fd.id, COMPUTED_KEYS.find, because);
        }
      }
      // 直接挂在受影响地层下的出土物
      for (const s of strata) {
        for (const fd of childrenOf(entities, s.id)) {
          if (fd.type === "find") mark(fd.id, COMPUTED_KEYS.find, because);
        }
      }
    }
  } else if (changed.type === "feature") {
    // 遗迹的开口深度或相对坐标变化 → 其出土物坐标失效
    const affect = ["openDepth", "offsetX", "offsetY"];
    if (changedKeys.some((k) => affect.includes(k))) {
      for (const fd of childrenOf(entities, changedId)) {
        if (fd.type === "find") mark(fd.id, COMPUTED_KEYS.find, because);
      }
    }
  }

  const logs: { id: string; text: string }[] = [];
  for (const [id, slot] of targets) {
    const e = entities[id];
    if (!e) continue;
    const inv: Invalidation = {
      keys: [...slot.keys],
      reason: slot.reasons.join("；"),
      sinceVersion: changedAt,
    };
    e.invalidated = inv;
    inv.keys.forEach((k) => {
      e.computed[k] = null;
    });
    logs.push({
      id,
      text: `失效 ${ENTITY_LABEL[e.type]}${e.code}：${inv.keys
        .map((k) => COMPUTED_LABEL[k])
        .join("、")}（${inv.reason}）`,
    });
  }
  return { invalidIds: [...targets.keys()], logs };
}

// ---------------------------------------------------------------------------
// 重算：按依赖顺序（地层 → 遗迹 → 出土物）逐轮尝试
// 上游缺失/有阻塞冲突/重算失败 → 本项失败，原因写入待办，草稿保留
// ---------------------------------------------------------------------------

export type RecomputeOutcome =
  | { ok: true; id: string }
  | { ok: false; id: string; reason: string };

export function recomputeAll(
  entities: Record<string, Entity>,
  opts?: { force?: boolean }
): RecomputeOutcome[] {
  const byId = new Map(Object.values(entities).map((e) => [e.id, e]));
  const outcomes: RecomputeOutcome[] = [];

  const order: EntityType[] = ["stratum", "feature", "find"];
  let progressed = true;
  // 只处理失效项；多轮执行以消化「本轮上游刚算好」的情况
  while (progressed) {
    progressed = false;
    for (const type of order) {
      for (const e of [...byId.values()].sort((a, b) =>
        a.type === b.type ? a.code.localeCompare(b.code, "zh") : 0
      )) {
        if (e.type !== type) continue;
        const needs =
          (opts?.force || e.invalidated !== null) &&
          COMPUTED_KEYS[e.type].some((k) => e.computed[k] == null);
        if (!needs) continue;

        const result = computeEntity(e, byId);
        if (result.ok) {
          e.invalidated = null;
          COMPUTED_KEYS[e.type].forEach((k) => {
            e.computed[k] = result.values[k] ?? null;
          });
          outcomes.push({ ok: true, id: e.id });
          progressed = true;
        } else {
          outcomes.push({ ok: false, id: e.id, reason: result.reason });
        }
      }
    }
  }
  return outcomes;
}

class ComputeError extends Error {}

function num(v: string | null | undefined, label: string): number {
  if (v == null || v.trim() === "") throw new ComputeError(`缺少${label}`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ComputeError(`${label}不是有效数值`);
  return n;
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** 检查依赖字段是否仍有未确认的同字段冲突（冲突确认前禁止重算） */
function blockingConflict(e: Entity, keys: string[]): FieldConflict | null {
  for (const k of keys) {
    if (e.conflicts[k]) return e.conflicts[k];
  }
  return null;
}

function computeEntity(
  e: Entity,
  byId: Map<string, Entity>
): { ok: true; values: Record<string, string> } | { ok: false; reason: string } {
  try {
    if (e.type === "stratum") return { ok: true, values: computeStratum(e, byId) };
    if (e.type === "feature") return { ok: true, values: computeFeature(e, byId) };
    if (e.type === "find") return { ok: true, values: computeFind(e, byId) };
    return { ok: true, values: {} };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "重算失败",
    };
  }
}

function computeStratum(e: Entity, byId: Map<string, Entity>): Record<string, string> {
  const square = e.parentId ? byId.get(e.parentId) : undefined;
  if (!square || square.type !== "square") throw new ComputeError("缺少所属探方");
  const bc = blockingConflict(square, ["datumZ"]);
  if (bc) throw new ComputeError(`坐标基准高程存在待确认冲突（${fieldLabel(square.type, bc.key)}）`);
  const own = blockingConflict(e, ["order", "thickness", "relation"]);
  if (own) throw new ComputeError(`本层${fieldLabel(e.type, own.key)}存在待确认冲突`);

  const datumZ = num(square.fields.datumZ, "探方基准高程");
  const order = num(e.fields.order, "层序");

  // 高程链：上方地层（层序更小）的层厚之和决定本层层顶；
  // 上层层厚暂缺时跳过该项，避免一个草稿卡死整个探方
  let above = 0;
  for (const s of childrenOf(Object.fromEntries(byId), square.id)) {
    if (s.type !== "stratum" || s.id === e.id) continue;
    const so = Number(s.fields.order);
    const st = Number(s.fields.thickness);
    if (Number.isFinite(so) && so < order && Number.isFinite(st)) {
      above += st;
    }
  }
  const thickness = num(e.fields.thickness, "层厚");
  const top = datumZ - above;
  return { topElev: fmt(top), bottomElev: fmt(top - thickness) };
}

function computeFeature(e: Entity, byId: Map<string, Entity>): Record<string, string> {
  const stratum = e.parentId ? byId.get(e.parentId) : undefined;
  if (!stratum || stratum.type !== "stratum") throw new ComputeError("缺少所属地层");
  const square = stratum.parentId ? byId.get(stratum.parentId) : undefined;
  if (!square || square.type !== "square") throw new ComputeError("缺少所属探方");

  const bc = blockingConflict(square, ["datumX", "datumY", "datumZ", "datumName"]);
  if (bc) throw new ComputeError(`坐标基准存在待确认冲突（${fieldLabel(square.type, bc.key)}）`);
  const own = blockingConflict(e, ["offsetX", "offsetY", "openDepth"]);
  if (own) throw new ComputeError(`遗迹${fieldLabel(e.type, own.key)}存在待确认冲突`);
  if (stratum.invalidated || stratum.computed.topElev == null) {
    throw new ComputeError(`所属地层${stratum.code}高程链未就绪，等待重算`);
  }

  const dx = num(square.fields.datumX, "基准东坐标");
  const dy = num(square.fields.datumY, "基准北坐标");
  const ox = num(e.fields.offsetX, "相对东距");
  const oy = num(e.fields.offsetY, "相对北距");
  const depth = num(e.fields.openDepth, "开口深度");
  const topElev = num(stratum.computed.topElev, "地层顶高程");

  return {
    absX: fmt(dx + ox),
    absY: fmt(dy + oy),
    absElev: fmt(topElev - depth),
  };
}

function computeFind(e: Entity, byId: Map<string, Entity>): Record<string, string> {
  const parent = e.parentId ? byId.get(e.parentId) : undefined;
  if (!parent) throw new ComputeError("缺少所属遗迹单位或地层");
  const square = squareOf(e, byId);
  if (!square) throw new ComputeError("缺少所属探方");

  const bc = blockingConflict(square, ["datumX", "datumY", "datumZ"]);
  if (bc) throw new ComputeError(`坐标基准存在待确认冲突（${fieldLabel(square.type, bc.key)}）`);
  const own = blockingConflict(e, ["relX", "relY", "depth"]);
  if (own) throw new ComputeError(`出土物${fieldLabel(e.type, own.key)}存在待确认冲突`);

  const rx = num(e.fields.relX, "相对东距");
  const ry = num(e.fields.relY, "相对北距");
  const depth = num(e.fields.depth, "出土深度");
  const datumZ = num(square.fields.datumZ, "探方基准高程");

  if (parent.type === "feature") {
    if (parent.invalidated || parent.computed.absX == null) {
      throw new ComputeError(`所属遗迹${parent.code}坐标未就绪，等待重算`);
    }
    const px = num(parent.computed.absX, "遗迹东坐标");
    const py = num(parent.computed.absY, "遗迹北坐标");
    return {
      absX: fmt(px + rx),
      absY: fmt(py + ry),
      absElev: fmt(datumZ - depth),
    };
  }
  // 直接出土于地层：以探方基准点为坐标原点
  const dx = num(square.fields.datumX, "基准东坐标");
  const dy = num(square.fields.datumY, "基准北坐标");
  return {
    absX: fmt(dx + rx),
    absY: fmt(dy + ry),
    absElev: fmt(datumZ - depth),
  };
}
