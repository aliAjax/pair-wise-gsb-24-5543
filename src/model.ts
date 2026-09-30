import type { RecordKind, VersionedRecord } from "./types";

export const KIND_LABEL: Record<RecordKind, string> = {
  datum: "坐标基准",
  trench: "探方",
  layer: "地层",
  feature: "遗迹单位",
  artifact: "出土物",
};

export const FEATURE_TYPES = ["灰坑", "墓葬", "房址", "沟状遗迹", "柱洞", "灶", "其他"];

export const FIELD_LABEL: Record<string, string> = {
  name: "名称",
  trenchId: "所属探方",
  gridE: "网格原点E",
  gridN: "网格原点N",
  size: "边长(m)",
  note: "备注",
  soilColor: "土色",
  depthTop: "层顶深度(m)",
  depthBottom: "层底深度(m)",
  overlies: "叠压于（下伏层）",
  ftype: "遗迹类型",
  layerId: "开口/所在层位",
  localE: "本地E(m)",
  localN: "本地N(m)",
  localZ: "实测深度(m)",
  featureId: "所属遗迹",
  originE: "基准原点E",
  originN: "基准原点N",
  rotationDeg: "北偏角(°)",
  elevation0: "高程基准(m)",
};

/** 逐字段写入，生成带字段版本的记录 */
export function makeRecord(
  id: string,
  kind: RecordKind,
  fields: Record<string, unknown>,
  by: string
): VersionedRecord {
  const rec: VersionedRecord = { id, kind, rev: 0, fields: {} };
  for (const [key, value] of Object.entries(fields)) {
    rec.rev += 1;
    rec.fields[key] = { value, rev: rec.rev, by, at: Date.now() };
  }
  return rec;
}

export function fnum(rec: VersionedRecord | undefined, field: string): number | null {
  const v = rec?.fields[field]?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function fstr(rec: VersionedRecord | undefined, field: string): string {
  const v = rec?.fields[field]?.value;
  return typeof v === "string" ? v : "";
}

export function farr(rec: VersionedRecord | undefined, field: string): string[] {
  const v = rec?.fields[field]?.value;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
