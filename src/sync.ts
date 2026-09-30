import { Entity, FieldConflict, OutboxChange } from "./types";

// ---------------------------------------------------------------------------
// 回连合并（纯前端模拟服务端/对端）：
// 离线改动带原版本 baseFields；对每个字段做三方合并 ——
//   · 只有一方改：取改动方
//   · 两边改了不同字段：按字段自动合并
//   · 同字段两边都改且不一致：两版都保留，字段进入待确认冲突
// 后到的坐标不会再无声盖掉对方补录的地层关系。
// ---------------------------------------------------------------------------

export interface MergedRecord {
  id: string;
  changedKeys: string[];
}

export interface MergeSummary {
  merged: MergedRecord[];
  conflicts: string[];
  imported: string[];
  pushed: string[];
}

export function mergeOnReconnect(params: {
  entities: Record<string, Entity>;
  remote: Record<string, Entity>;
  outbox: OutboxChange[];
  at: number;
}): MergeSummary {
  const { entities, remote, outbox, at } = params;
  const outboxById = new Map(outbox.map((o) => [o.entityId, o]));
  const summary: MergeSummary = { merged: [], conflicts: [], imported: [], pushed: [] };

  const ids = new Set([...Object.keys(entities), ...Object.keys(remote)]);

  for (const id of ids) {
    const local = entities[id];
    const rem = remote[id];

    // 本机离线新建：推送为对端的新版本
    if (local && !rem) {
      const pushed: Entity = {
        ...JSON.parse(JSON.stringify(local)),
        origin: "merged",
        isDraft: false,
      };
      remote[id] = pushed;
      local.origin = "merged";
      local.isDraft = false;
      summary.pushed.push(id);
      continue;
    }

    // 对端新建：导入本机并标记失效（坐标关系需要在本机重算核对）
    if (!local && rem) {
      const imported: Entity = JSON.parse(JSON.stringify(rem));
      imported.origin = "remote";
      if (imported.type !== "square") {
        const keys = imported.invalidated?.keys ?? [];
        imported.invalidated = {
          keys,
          reason: `对端新登记${imported.code}，坐标关系待重算核对`,
          sinceVersion: at,
        };
      }
      entities[id] = imported;
      summary.imported.push(id);
      continue;
    }
    if (!local || !rem) continue;

    const change = outboxById.get(id);
    const mergedEntity = mergeEntity(local, rem, change, at);
    if (mergedEntity.touched) {
      summary.merged.push({ id, changedKeys: mergedEntity.changedKeys });
    }
    if (Object.keys(local.conflicts).length > 0 || mergedEntity.hadConflict) {
      summary.conflicts.push(id);
    }

    // 合并结果同时写回本机与对端，两端重新收敛到同一版本
    const converged: Entity = JSON.parse(JSON.stringify(local));
    remote[id] = converged;
  }

  return summary;
}

function mergeEntity(
  local: Entity,
  remote: Entity,
  change: OutboxChange | undefined,
  at: number
): { touched: boolean; hadConflict: boolean; changedKeys: string[] } {
  let touched = false;
  let hadConflict = false;
  const changedKeys: string[] = [];
  const keys = new Set([
    ...Object.keys(local.fields),
    ...Object.keys(remote.fields),
    ...Object.keys(change?.changes ?? {}),
  ]);

  for (const key of keys) {
    const base = change?.baseFields[key] ?? local.fields[key] ?? "";
    const lv = local.fields[key] ?? "";
    const rv = remote.fields[key] ?? "";
    const localChanged = lv !== base;
    const remoteChanged = rv !== base;
    const existing = local.conflicts[key];

    if (localChanged && remoteChanged && lv !== rv) {
      // 同字段两边都改：保留两版，不互相覆盖
      if (!existing) {
        const conflict: FieldConflict = {
          key,
          base,
          local: lv,
          remote: rv,
          baseVersion: change?.baseVersion ?? local.baseVersion,
          localVersion: local.version,
          remoteVersion: remote.version,
        };
        local.conflicts[key] = conflict;
        // 确认前字段暂取原版本（共同祖先），两版在冲突面板中并列
        local.fields[key] = base;
        hadConflict = true;
        touched = true;
        changedKeys.push(key);
      }
      continue;
    }

    if (existing) {
      // 已有的待确认冲突：若某一方在新版本中撤回/与另一方趋同则自动消解，
      // 否则继续保留两版等待人工确认
      if (lv === rv) {
        delete local.conflicts[key];
        local.fields[key] = lv;
        touched = true;
        changedKeys.push(key);
      } else {
        existing.local = lv;
        existing.remote = rv;
        existing.localVersion = local.version;
        existing.remoteVersion = remote.version;
      }
      continue;
    }

    if (remoteChanged && !localChanged) {
      local.fields[key] = rv;
      touched = true;
      changedKeys.push(key);
    }
    // 本机改、对端未改 → 保留本机值（lv 已在本地）
  }

  if (touched) {
    local.version += 1;
    local.baseVersion = local.version;
    local.updatedAt = at;
    local.updatedBy = "同步合并";
    local.origin = "merged";
  }
  return { touched, hadConflict, changedKeys };
}
