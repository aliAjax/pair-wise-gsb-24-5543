import { computeAbs } from "./coord";
import { makeRecord } from "./model";
import type { CoordState, StoreState, VersionedRecord } from "./types";

/** 初始档案：探方、地层（含叠压关系）、遗迹单位、出土物与坐标基准 */
export function seedState(): StoreState {
  const by = "初始建档";
  const records: VersionedRecord[] = [
    makeRecord("datum", "datum", {
      name: "HXWL-10 遗址控制网",
      originE: 500000,
      originN: 300000,
      rotationDeg: 12,
      elevation0: 103.5,
    }, by),

    makeRecord("T0203", "trench", { name: "T0203", gridE: 20, gridN: 30, size: 5, note: "" }, by),
    makeRecord("T0204", "trench", { name: "T0204", gridE: 20, gridN: 35, size: 5, note: "" }, by),
    makeRecord("T0301", "trench", { name: "T0301", gridE: 25, gridN: 40, size: 5, note: "" }, by),

    makeRecord("L101", "layer", {
      trenchId: "T0203", name: "第1层（表土）", soilColor: "黄褐土",
      depthTop: 0, depthBottom: 0.3, overlies: ["L102"], note: "",
    }, by),
    makeRecord("L102", "layer", {
      trenchId: "T0203", name: "第2层（扰土）", soilColor: "灰黄土",
      depthTop: 0.3, depthBottom: 0.7, overlies: ["L103"], note: "",
    }, by),
    makeRecord("L103", "layer", {
      trenchId: "T0203", name: "第3层", soilColor: "灰褐土",
      depthTop: 0.7, depthBottom: 1.2, overlies: [], note: "下伏关系待定",
    }, by),
    makeRecord("L201", "layer", {
      trenchId: "T0204", name: "第1层（表土）", soilColor: "黄褐土",
      depthTop: 0, depthBottom: 0.4, overlies: ["L202"], note: "",
    }, by),
    makeRecord("L202", "layer", {
      trenchId: "T0204", name: "第2层", soilColor: "灰褐土",
      depthTop: 0.4, depthBottom: 1.0, overlies: [], note: "",
    }, by),
    makeRecord("L301", "layer", {
      trenchId: "T0301", name: "第1层（夯土）", soilColor: "夯土",
      depthTop: 0.2, depthBottom: 0.9, overlies: [], note: "",
    }, by),

    makeRecord("H12", "feature", {
      trenchId: "T0203", ftype: "灰坑", name: "H12 灰坑", layerId: "L103",
      localE: 2.1, localN: 3.4, localZ: null, note: "",
    }, by),
    makeRecord("F2", "feature", {
      trenchId: "T0301", ftype: "房址", name: "F2 房址", layerId: "L301",
      localE: 1.2, localN: 1.8, localZ: null, note: "柱洞关系需复核",
    }, by),
    makeRecord("M5", "feature", {
      trenchId: "T0204", ftype: "墓葬", name: "M5 墓葬", layerId: "L202",
      localE: 3.0, localN: 2.2, localZ: 1.1, note: "",
    }, by),

    makeRecord("A001", "artifact", {
      trenchId: "T0203", name: "陶片 12 件", featureId: "H12", layerId: "L103",
      localE: 2.3, localN: 3.1, localZ: null, note: "",
    }, by),
    makeRecord("A002", "artifact", {
      trenchId: "T0203", name: "兽骨", featureId: "", layerId: "L103",
      localE: 1.8, localN: 2.6, localZ: 0.95, note: "",
    }, by),
    makeRecord("A003", "artifact", {
      trenchId: "T0301", name: "石柱础", featureId: "F2", layerId: "L301",
      localE: 1.35, localN: 1.95, localZ: null, note: "",
    }, by),
  ];

  const local: Record<string, VersionedRecord> = {};
  const syncedFields: StoreState["syncedFields"] = {};
  for (const r of records) {
    local[r.id] = r;
    syncedFields[r.id] = {};
    for (const [field, fv] of Object.entries(r.fields)) syncedFields[r.id][field] = fv.rev;
  }

  const coords: Record<string, CoordState> = {};
  for (const r of records) {
    if (r.kind !== "feature" && r.kind !== "artifact") continue;
    const res = computeAbs(r, local);
    coords[r.id] = res.ok
      ? { status: "valid", abs: res.abs, deps: res.deps, reason: null, updatedAt: Date.now() }
      : { status: "pending", abs: null, deps: null, reason: res.error, updatedAt: Date.now() };
  }

  return {
    online: true,
    localSeq: 0,
    serverSeq: 0,
    syncSeq: 0,
    idSeq: 100,
    local,
    server: structuredClone(local),
    syncedFields,
    outbox: [],
    conflicts: [],
    coords,
    tasks: [],
    log: [{
      at: Date.now(),
      tone: "info",
      text: "初始建档：探方 3、地层 6、遗迹单位 3、出土物 3；坐标基准 HXWL-10 遗址控制网",
    }],
  };
}
