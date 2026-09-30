import { useMemo, useState } from "react";
import "./styles.css";
import { useActions, useStore } from "./store";
import { Entity, EntityType } from "./types";
import {
  COMPUTED_KEYS,
  ENTITY_LABEL,
  FIELDS,
  fieldLabel,
} from "./model";
import { computeStats, downloadSummary } from "./summary";
import {
  ComputedRow,
  ConflictPanel,
  EntityForm,
  Modal,
  NewEntityForm,
  VersionLine,
} from "./ui/components";

type FilterType = EntityType | "all";

function fmtTime(t: number | null): string {
  if (!t) return "尚未回连";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

function App() {
  const state = useStore();
  const actions = useActions();
  const stats = useMemo(() => computeStats(state), [state]);

  const [filter, setFilter] = useState<FilterType>("all");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [editing, setEditing] = useState<Entity | null>(null);
  const [creating, setCreating] = useState<{
    type: EntityType;
    parentId: string | null;
  } | null>(null);

  const list = useMemo(() => {
    const needsAttention = (e: Entity) =>
      Object.keys(e.conflicts).length > 0 ||
      e.isDraft ||
      e.invalidated !== null ||
      (COMPUTED_KEYS[e.type].length > 0 &&
        Object.values(e.computed).some((v) => v == null));
    return Object.values(state.entities)
      .filter((e) => (filter === "all" ? true : e.type === filter))
      .filter((e) => (onlyAttention ? needsAttention(e) : true))
      .sort(
        (a, b) =>
          typeOrder(a.type) - typeOrder(b.type) ||
          a.code.localeCompare(b.code, "zh")
      );
  }, [state.entities, filter, onlyAttention]);

  const parentChoices = useMemo(() => {
    const allowed: Record<string, EntityType[]> = {
      stratum: ["square"],
      feature: ["stratum"],
      find: ["feature", "stratum"],
      square: [],
    };
    const type = creating?.type ?? "find";
    return Object.values(state.entities)
      .filter((e) => allowed[type].includes(e.type))
      .map((e) => ({
        id: e.id,
        label: `${ENTITY_LABEL[e.type]} · ${e.code}`,
      }));
  }, [state.entities, creating]);

  return (
    <main className="app-shell app-v2">
      {/* 顶部：档案头 + 连接状态 */}
      <section className="topbar panel">
        <div>
          <p className="eyebrow">hxwl-10 · 可续作的现场记录</p>
          <h1>考古探方记录</h1>
          <p className="subtitle">
            断网可继续登记，改动锁定原版本；回连按字段合并，同字段冲突两版都保留；
            地层关系或坐标基准一变，依赖的遗迹与出土物坐标自动失效并重算。
          </p>
        </div>
        <div className="conn-card">
          <div className={`conn-dot ${state.online ? "on" : "off"}`} />
          <div>
            <strong>{state.online ? "在线" : "断网中"}</strong>
            <span>最近回连 {fmtTime(state.lastSyncAt)}</span>
          </div>
          <button
            className={state.online ? "" : "primary-action"}
            onClick={() => actions.toggleOnline()}
          >
            {state.online ? "模拟断网" : "回连同步"}
          </button>
          {state.online && (
            <button onClick={() => actions.sync()}>立即同步</button>
          )}
        </div>
      </section>

      {state.notice && (
        <section className="notice-bar panel">
          <span>{state.notice}</span>
          <button onClick={() => actions.dismissNotice()}>知道了</button>
        </section>
      )}

      {/* 当前版本 / 待确认 / 失效范围 概览 */}
      <section className="metrics-grid v2">
        <Metric
          label="档案规模（当前版本）"
          value={`${stats.counts.square}/${stats.counts.stratum}/${stats.counts.feature}/${stats.counts.find}`}
          hint="探方 / 地层 / 遗迹 / 出土物"
          tone="ok"
        />
        <Metric
          label="待确认项"
          value={String(stats.pendingConflicts.length)}
          hint={`本机草稿 ${stats.drafts} · 离线待发 ${stats.pendingOutbox}`}
          tone={stats.pendingConflicts.length ? "danger" : "ok"}
        />
        <Metric
          label="失效范围"
          value={String(stats.invalid.length)}
          hint="坐标/高程等待重算"
          tone={stats.invalid.length ? "warn" : "ok"}
        />
        <Metric
          label="重算待办"
          value={String(stats.todos)}
          hint="重算失败已保留，下次打开继续"
          tone={stats.todos ? "danger" : "ok"}
        />
      </section>

      {/* 操作行 */}
      <section className="toolbar panel">
        <div className="chips">
          {(["all", "square", "stratum", "feature", "find"] as FilterType[]).map(
            (t) => (
              <button
                key={t}
                className={filter === t ? "chip-active" : ""}
                onClick={() => setFilter(t)}
              >
                {t === "all" ? "全部" : ENTITY_LABEL[t]}
              </button>
            )
          )}
          <button
            className={onlyAttention ? "chip-active" : ""}
            onClick={() => setOnlyAttention((v) => !v)}
          >
            只看待处理
          </button>
        </div>
        <div className="toolbar-actions">
          <button onClick={() => actions.stageDivergence()}>
            布置离线分歧示例
          </button>
          <button onClick={() => downloadSummary(state)}>导出摘要</button>
          <button onClick={() => actions.resetDemo()}>重置示例</button>
          <NewButtons onPick={(type, parentId) => setCreating({ type, parentId })} />
        </div>
      </section>

      {/* 待确认项 + 待办 + 失效范围 */}
      {(stats.pendingConflicts.length > 0 ||
        stats.todos > 0 ||
        stats.invalid.length > 0) && (
        <section className="attention-grid">
          {stats.pendingConflicts.length > 0 && (
            <div className="panel attention-panel">
              <h2>待确认项（同字段冲突，两版保留）</h2>
              <ul>
                {stats.pendingConflicts.map(({ entity, key }) => (
                  <li key={entity.id + key}>
                    <strong>
                      {ENTITY_LABEL[entity.type]} {entity.code}
                    </strong>
                    <span>
                      {fieldLabel(entity.type, key)}：本机「
                      {entity.conflicts[key].local}」 / 对端「
                      {entity.conflicts[key].remote}」 / 原版本「
                      {entity.conflicts[key].base || "空"}」
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {stats.todos > 0 && (
            <div className="panel attention-panel">
              <h2>重算待办（草稿已保留）</h2>
              <ul>
                {state.todos.map((todo) => {
                  const e = state.entities[todo.entityId];
                  return (
                    <li key={todo.entityId}>
                      <strong>
                        {e ? `${ENTITY_LABEL[e.type]} ${e.code}` : todo.entityId}
                      </strong>
                      <span>{todo.reason}</span>
                    </li>
                  );
                })}
              </ul>
              <button className="primary-action" onClick={() => actions.retryRecompute()}>
                立即继续重算
              </button>
            </div>
          )}
          {stats.invalid.length > 0 && (
            <div className="panel attention-panel">
              <h2>失效范围</h2>
              <ul>
                {stats.invalid.map((e) => (
                  <li key={e.id}>
                    <strong>
                      {ENTITY_LABEL[e.type]} {e.code} v{e.version}
                    </strong>
                    <span>
                      {(e.invalidated?.keys ??
                        Object.keys(e.computed).filter(
                          (k) => e.computed[k] == null
                        ))
                        .map((k) => fieldLabel(e.type, k))
                        .join("、")}
                      {e.invalidated ? `（${e.invalidated.reason}）` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* 记录清单 */}
      <section className="record-list v2">
        {list.map((e) => (
          <EntityCard
            key={e.id}
            e={e}
            parentName={
              e.parentId
                ? parentLabel(state.entities[e.parentId])
                : null
            }
            onEdit={() => setEditing(e)}
            onResolve={(id, key, value) => actions.resolveConflict(id, key, value)}
          />
        ))}
        {list.length === 0 && (
          <div className="panel empty-hint">没有符合筛选条件的记录</div>
        )}
      </section>

      {/* 同步日志 */}
      <section className="panel log-panel">
        <h2>操作与同步日志</h2>
        <ul>
          {state.logs.slice(0, 18).map((log, i) => (
            <li key={i} className={`log-${log.kind}`}>
              <time>{fmtTime(log.time)}</time>
              <span>{log.text}</span>
            </li>
          ))}
        </ul>
      </section>

      {editing && (
        <Modal
          title={`编辑 ${ENTITY_LABEL[editing.type]} · ${editing.code}`}
          onClose={() => setEditing(null)}
        >
          <VersionLine e={editing} />
          <ConflictPanel
            e={editing}
            onResolve={(id, key, value) => {
              actions.resolveConflict(id, key, value);
              setEditing(null);
            }}
          />
          <EntityForm
            e={editing}
            onSave={(patch) => {
              actions.editEntity(editing.id, patch);
              setEditing(null);
            }}
          />
        </Modal>
      )}

      {creating && (
        <Modal
          title={`新增${ENTITY_LABEL[creating.type]}`}
          onClose={() => setCreating(null)}
        >
          <NewEntityForm
            type={creating.type}
            parentId={creating.parentId}
            parentChoices={parentChoices}
            onSave={(pid, fields) => {
              actions.addEntity(creating.type, pid, fields);
              setCreating(null);
            }}
          />
        </Modal>
      )}
    </main>
  );
}

function parentLabel(e?: Entity): string {
  return e ? `${ENTITY_LABEL[e.type]} ${e.code}` : "（上级缺失）";
}

function typeOrder(t: EntityType): number {
  return { square: 0, stratum: 1, feature: 2, find: 3 }[t];
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "ok" | "warn" | "danger";
}) {
  return (
    <article className={`metric-card v2 metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{hint}</p>
      <i className={`status-${tone === "ok" ? "ok" : tone === "warn" ? "watch" : "danger"}`} />
    </article>
  );
}

function NewButtons({
  onPick,
}: {
  onPick: (type: EntityType, parentId: string | null) => void;
}) {
  return (
    <>
      <button className="primary-action" onClick={() => onPick("square", null)}>
        新增探方
      </button>
      <button onClick={() => onPick("stratum", null)}>新增地层</button>
      <button onClick={() => onPick("feature", null)}>新增遗迹</button>
      <button onClick={() => onPick("find", null)}>新增出土物</button>
    </>
  );
}

function EntityCard({
  e,
  parentName,
  onEdit,
  onResolve,
}: {
  e: Entity;
  parentName: string | null;
  onEdit: () => void;
  onResolve: (id: string, key: string, value: string) => void;
}) {
  const todo = useTodoHint(e.id);
  const shownFields = FIELDS[e.type].filter((d) => d.key !== "code");
  return (
    <article
      className={`panel entity-card ${
        Object.keys(e.conflicts).length ? "has-conflict" : ""
      } ${e.invalidated ? "has-invalid" : ""}`}
    >
      <header>
        <div>
          <p className="eyebrow">
            {ENTITY_LABEL[e.type]}
            {parentName ? ` · 隶属 ${parentName}` : ""}
          </p>
          <h3>{e.code}</h3>
        </div>
        <button onClick={onEdit}>登记/编辑</button>
      </header>

      <VersionLine e={e} />

      <div className="field-readout">
        {shownFields.map((d) => {
          const conflict = e.conflicts[d.key];
          return (
            <div key={d.key} className={conflict ? "field-conflict" : ""}>
              <span>{d.label}</span>
              {conflict ? (
                <strong>
                  待确认：本机「{conflict.local}」/ 对端「{conflict.remote}」
                </strong>
              ) : (
                <strong>{e.fields[d.key] || "—"}</strong>
              )}
            </div>
          );
        })}
      </div>

      <ComputedRow e={e} />
      {e.invalidated?.reason && (
        <p className="invalid-reason">失效原因：{e.invalidated.reason}</p>
      )}
      {todo && <p className="todo-reason">重算待办：{todo}</p>}
      <ConflictPanel e={e} onResolve={onResolve} />
    </article>
  );
}

function useTodoHint(id: string): string | null {
  const state = useStore();
  return state.todos.find((t) => t.entityId === id)?.reason ?? null;
}

export default App;
