import { AppState, Entity, EntityType } from "./types";
import { COMPUTED_KEYS } from "./model";

const NOW = Date.UTC(2026, 8, 30, 2, 0, 0);

let seq = 0;
function makeEntity(
  type: EntityType,
  code: string,
  parentId: string | null,
  fields: Record<string, string>,
  offsetMin = 0
): Entity {
  seq += 1;
  const t = NOW + offsetMin * 60000;
  return {
    id: `e${String(seq).padStart(3, "0")}`,
    type,
    code,
    parentId,
    fields: { code, ...fields },
    computed: Object.fromEntries(
      COMPUTED_KEYS[type].map((k) => [k, null])
    ),
    version: 1,
    baseVersion: 1,
    origin: "local",
    isDraft: false,
    conflicts: {},
    invalidated: null,
    updatedAt: t,
    updatedBy: "发掘队员",
  };
}

/** 初始档案：探方 T0203 / T0204，地层—遗迹—出土物依赖链 */
export function buildSeed(): { state: AppState } {
  const t1 = makeEntity("square", "T0203", null, {
    datumName: "BM07",
    datumX: "100",
    datumY: "200",
    datumZ: "45.2",
    note: "遗址南区",
  });
  const t2 = makeEntity("square", "T0204", null, {
    datumName: "BM07",
    datumX: "105",
    datumY: "205",
    datumZ: "45.0",
    note: "与T0203相邻",
  }, 1);

  const s1 = makeEntity("stratum", "第3层", t1.id, {
    order: "3",
    thickness: "0.35",
    soilColor: "灰褐土",
    relation: "叠压",
    note: "陶片较多",
  }, 2);
  const s2 = makeEntity("stratum", "第4层", t1.id, {
    order: "4",
    thickness: "0.4",
    soilColor: "黄褐土",
    relation: "叠压",
    note: "",
  }, 3);
  const s3 = makeEntity("stratum", "第2层", t2.id, {
    order: "2",
    thickness: "0.3",
    soilColor: "黑褐土",
    relation: "叠压",
    note: "夹炭屑，见动物骨",
  }, 4);

  const f1 = makeEntity("feature", "H12灰坑", s1.id, {
    kind: "灰坑",
    openDepth: "0.9",
    offsetX: "2.5",
    offsetY: "3.1",
    soilColor: "黑褐填土",
    note: "",
  }, 5);
  const f2 = makeEntity("feature", "F2房址", s3.id, {
    kind: "房址",
    openDepth: "0.6",
    offsetX: "1.2",
    offsetY: "0.8",
    soilColor: "夯土面",
    note: "柱洞关系需复核",
  }, 6);

  const p1 = makeEntity("find", "陶片12", f1.id, {
    name: "夹砂陶片",
    relX: "0.4",
    relY: "-0.2",
    depth: "1.1",
    note: "12件",
  }, 7);
  const p2 = makeEntity("find", "兽骨03", f1.id, {
    name: "动物骨骼",
    relX: "-0.1",
    relY: "0.3",
    depth: "1.25",
    note: "",
  }, 8);
  const p3 = makeEntity("find", "柱洞01", f2.id, {
    name: "柱洞记录",
    relX: "0.9",
    relY: "0.6",
    depth: "0.7",
    note: "位置待复核",
  }, 9);

  const list = [t1, t2, s1, s2, s3, f1, f2, p1, p2, p3];
  const entities: Record<string, Entity> = {};
  for (const e of list) entities[e.id] = e;

  const state: AppState = {
    online: true,
    entities,
    remote: JSON.parse(JSON.stringify(entities)),
    outbox: [],
    todos: [],
    logs: [
      { time: NOW, kind: "system", text: "档案建立：2个探方、3条地层、2处遗迹、3件出土物，坐标已重算" },
    ],
    lastSyncAt: NOW,
    notice: null,
  };
  return { state };
}
