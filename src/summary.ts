import { AppState, Entity, EntityType } from "./types";
import { COMPUTED_LABEL, ENTITY_LABEL } from "./model";

export interface Stats {
  counts: Record<EntityType, number>;
  drafts: number;
  pendingOutbox: number;
  pendingConflicts: { entity: Entity; key: string }[];
  invalid: Entity[];
  todos: number;
}

export function computeStats(state: AppState): Stats {
  const list = Object.values(state.entities);
  const counts: Record<EntityType, number> = {
    square: 0,
    stratum: 0,
    feature: 0,
    find: 0,
  };
  const pendingConflicts: Stats["pendingConflicts"] = [];
  const invalid: Entity[] = [];
  for (const e of list) {
    counts[e.type] += 1;
    Object.keys(e.conflicts).forEach((key) =>
      pendingConflicts.push({ entity: e, key })
    );
    if (e.invalidated || Object.values(e.computed).some((v) => v == null)) {
      if (Object.keys(e.computed).length > 0) invalid.push(e);
    }
  }
  return {
    counts,
    drafts: list.filter((e) => e.isDraft).length,
    pendingOutbox: state.outbox.length,
    pendingConflicts,
    invalid,
    todos: state.todos.length,
  };
}

function ts(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

/** 导出清单与摘要：标明当前版本、待确认项与失效范围 */
export function buildSummaryMarkdown(state: AppState, stats: Stats): string {
  const lines: string[] = [];
  lines.push("# 探方现场记录摘要");
  lines.push("");
  lines.push(`- 导出时间：${ts(Date.now())}`);
  lines.push(`- 网络状态：${state.online ? "在线" : "离线（改动存于本机发件箱）"}`);
  lines.push(
    `- 最近回连：${state.lastSyncAt ? ts(state.lastSyncAt) : "尚未回连"}`
  );
  lines.push(
    `- 档案规模：探方 ${stats.counts.square} · 地层 ${stats.counts.stratum} · 遗迹 ${stats.counts.feature} · 出土物 ${stats.counts.find}`
  );
  lines.push(
    `- 本机草稿：${stats.drafts}；离线待发：${stats.pendingOutbox}；重算待办：${stats.todos}`
  );
  lines.push("");

  lines.push("## 待确认项（同字段冲突，两版保留）");
  if (stats.pendingConflicts.length === 0) {
    lines.push("无");
  } else {
    for (const { entity, key } of stats.pendingConflicts) {
      const c = entity.conflicts[key];
      lines.push(
        `- ${ENTITY_LABEL[entity.type]} ${entity.code} · ${key}：本机 v${c.localVersion}=「${c.local}」 / 对端 v${c.remoteVersion}=「${c.remote}」 / 原版本 v${c.baseVersion}=「${c.base || "空"}」`
      );
    }
  }
  lines.push("");

  lines.push("## 失效范围（等待重算）");
  if (stats.invalid.length === 0 && stats.todos === 0) {
    lines.push("无，全部坐标为当前版本");
  } else {
    for (const e of stats.invalid) {
      const keys =
        e.invalidated?.keys ??
        Object.entries(e.computed)
          .filter(([, v]) => v == null)
          .map(([k]) => k);
      const todo = state.todos.find((t) => t.entityId === e.id);
      lines.push(
        `- ${ENTITY_LABEL[e.type]} ${e.code} v${e.version}：${keys
          .map((k) => COMPUTED_LABEL[k] ?? k)
          .join("、")}失效` +
          (e.invalidated ? `（原因：${e.invalidated.reason}）` : "") +
          (todo ? `；重算待办：${todo.reason}` : "")
      );
    }
  }
  lines.push("");

  const groups: EntityType[] = ["square", "stratum", "feature", "find"];
  for (const type of groups) {
    lines.push(`## ${ENTITY_LABEL[type]}清单（当前版本）`);
    for (const e of state2List(state, type)) {
      const flags: string[] = [`v${e.version}`];
      if (e.isDraft) flags.push("本机草稿");
      if (Object.keys(e.conflicts).length) flags.push("有冲突");
      if (e.invalidated) flags.push("坐标失效");
      lines.push(`- ${e.code} [${flags.join(" / ")}]`);
      const comp = Object.entries(e.computed)
        .map(([k, v]) => `${COMPUTED_LABEL[k] ?? k}=${v ?? "待重算"}`)
        .join("，");
      if (comp) lines.push(`  - ${comp}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function state2List(state: AppState, type: EntityType): Entity[] {
  return Object.values(state.entities)
    .filter((e) => e.type === type)
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

export function downloadSummary(state: AppState): void {
  const md = buildSummaryMarkdown(state, computeStats(state));
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `现场记录摘要-${ts(Date.now()).replace(/[: ]/g, "-")}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
