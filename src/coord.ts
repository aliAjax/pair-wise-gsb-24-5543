import { farr, fnum, fstr } from "./model";
import type { AbsCoord, CoordDeps, VersionedRecord } from "./types";

type Records = Record<string, VersionedRecord>;

export const DEP_LABEL: Record<keyof CoordDeps, string> = {
  self: "本记录坐标字段",
  datum: "坐标基准",
  trench: "探方原点",
  layer: "地层关系/层位",
  feature: "所属遗迹",
};

type Depth = { ok: true; top: number; bottom: number } | { ok: false; error: string };

/**
 * 由地层关系推导层位深度区间：
 * 层顶缺失时取上覆层（谁叠压于我）的层底；层底缺失时取下伏层（我叠压于谁）的层顶。
 * 关系缺失或成环都会推导失败 —— 这正是“地层关系一变，依赖坐标失效”的来源。
 */
export function deriveLayerDepth(layerId: string, local: Records, seen: Set<string> = new Set()): Depth {
  const layer = local[layerId];
  if (!layer) return { ok: false, error: `层位 ${layerId || "未填"} 记录缺失` };
  if (seen.has(layerId)) return { ok: false, error: `地层关系成环（${layerId}）` };
  const next = new Set(seen).add(layerId);

  let top = fnum(layer, "depthTop");
  if (top === null) {
    const above = Object.values(local).find(
      (r) => r.kind === "layer" && farr(r, "overlies").includes(layerId)
    );
    if (!above) return { ok: false, error: "层顶深度缺失，且无上覆层关系可推导" };
    const d = deriveLayerDepth(above.id, local, next);
    if (!d.ok) return { ok: false, error: `上覆层 ${above.id} 深度不可推：${d.error}` };
    top = d.bottom;
  }

  let bottom = fnum(layer, "depthBottom");
  if (bottom === null) {
    const belowIds = farr(layer, "overlies");
    if (belowIds.length === 0) return { ok: false, error: "层底深度缺失，且无下伏层关系可推导" };
    const d = deriveLayerDepth(belowIds[0], local, next);
    if (!d.ok) return { ok: false, error: `下伏层 ${belowIds[0]} 深度不可推：${d.error}` };
    bottom = d.top;
  }

  return { ok: true, top, bottom };
}

/** 遗迹深度：实测优先，否则取开口层位的层底（开口于该层下） */
function featureDepth(feature: VersionedRecord, local: Records): { ok: true; depth: number } | { ok: false; error: string } {
  const z = fnum(feature, "localZ");
  if (z !== null) return { ok: true, depth: z };
  const layerId = fstr(feature, "layerId");
  if (!layerId) return { ok: false, error: "未实测深度且未填开口层位" };
  const d = deriveLayerDepth(layerId, local);
  if (!d.ok) return { ok: false, error: `开口层位 ${layerId} 深度未闭合：${d.error}` };
  return { ok: true, depth: d.bottom };
}

/** 出土物深度：实测优先，其次随所属遗迹，再其次取所在层位层顶 */
function artifactDepth(art: VersionedRecord, local: Records): { ok: true; depth: number } | { ok: false; error: string } {
  const z = fnum(art, "localZ");
  if (z !== null) return { ok: true, depth: z };
  const featureId = fstr(art, "featureId");
  if (featureId && local[featureId]) return featureDepth(local[featureId], local);
  const layerId = fstr(art, "layerId");
  if (layerId) {
    const d = deriveLayerDepth(layerId, local);
    if (!d.ok) return { ok: false, error: `所在层位 ${layerId} 深度未闭合：${d.error}` };
    return { ok: true, depth: d.top };
  }
  return { ok: false, error: "未实测深度且无遗迹/层位可参照" };
}

/** 当前依赖版本指纹 */
export function currentDeps(rec: VersionedRecord, local: Records): CoordDeps {
  return {
    self: rec.rev,
    datum: local["datum"]?.rev ?? 0,
    trench: local[fstr(rec, "trenchId")]?.rev ?? 0,
    layer: local[fstr(rec, "layerId")]?.rev ?? 0,
    feature: local[fstr(rec, "featureId")]?.rev ?? 0,
  };
}

export type ComputeResult =
  | { ok: true; abs: AbsCoord; deps: CoordDeps }
  | { ok: false; error: string };

/** 由探方本地坐标 + 坐标基准换算遗址控制网绝对坐标 */
export function computeAbs(rec: VersionedRecord, local: Records): ComputeResult {
  const datum = local["datum"];
  const originE = fnum(datum, "originE");
  const originN = fnum(datum, "originN");
  const rot = fnum(datum, "rotationDeg");
  const elev = fnum(datum, "elevation0");
  if (originE === null || originN === null || rot === null || elev === null) {
    return { ok: false, error: "坐标基准参数缺失（原点/北偏角/高程基准）" };
  }

  const trenchId = fstr(rec, "trenchId");
  const trench = local[trenchId];
  if (!trench) return { ok: false, error: `探方 ${trenchId || "未填"} 记录缺失` };
  const gE = fnum(trench, "gridE");
  const gN = fnum(trench, "gridN");
  if (gE === null || gN === null) return { ok: false, error: `探方 ${trenchId} 网格原点缺失` };

  const le = fnum(rec, "localE");
  const ln = fnum(rec, "localN");
  if (le === null || ln === null) return { ok: false, error: "本地坐标 E/N 未登记" };

  const depth = rec.kind === "feature" ? featureDepth(rec, local) : artifactDepth(rec, local);
  if (!depth.ok) return { ok: false, error: depth.error };

  const th = (rot * Math.PI) / 180;
  const x = gE + le;
  const y = gN + ln;
  return {
    ok: true,
    abs: {
      e: originE + Math.cos(th) * x - Math.sin(th) * y,
      n: originN + Math.sin(th) * x + Math.cos(th) * y,
      z: elev - depth.depth,
    },
    deps: currentDeps(rec, local),
  };
}
