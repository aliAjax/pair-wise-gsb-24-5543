import { Fragment, useState, useSyncExternalStore } from "react";
import "./styles.css";
import { deriveLayerDepth } from "./coord";
import { FEATURE_TYPES, FIELD_LABEL, KIND_LABEL, farr, fstr } from "./model";
import { sameValue, store } from "./store";
import type { CoordState, StoreState, VersionedRecord } from "./types";

const fv = (rec: VersionedRecord, field: string) => rec.fields[field]?.value ?? null;

const fmtVal = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join("、") : "—";
  return String(v);
};

const fmtNum = (v: unknown): string => (typeof v === "number" ? v.toFixed(2) : "—");

const fmtTime = (at: number) => new Date(at).toLocaleString("zh-CN", { hour12: false });

const recName = (rec: VersionedRecord | undefined) =>
  rec ? String(fv(rec, "name") || rec.id) : "—";

/* ---------- 通用小件 ---------- */

function CoordCell({ coord }: { coord: CoordState | undefined }) {
  if (!coord) return <span className="dim">未计算</span>;
  const abs = coord.abs ? (
    <span className="mono">
      E {coord.abs.e.toFixed(2)} · N {coord.abs.n.toFixed(2)} · Z {coord.abs.z.toFixed(2)}
    </span>
  ) : (
    <span className="dim">无坐标草稿</span>
  );
  if (coord.status === "valid") {
    return (
      <div className="coord-cell">
        {abs} <span className="badge badge-ok">有效</span>
      </div>
    );
  }
  return (
    <div className="coord-cell">
      <div className="dim">{coord.abs ? <>草稿 {abs}</> : abs}</div>
      {coord.status === "stale" ? (
        <span className="badge badge-warn">已失效·待重算</span>
      ) : (
        <span className="badge badge-bad">重算待办</span>
      )}
      {coord.reason && <div className="stale-text">{coord.reason}</div>}
    </div>
  );
}

function RowBadges({ rec, state }: { rec: VersionedRecord; state: StoreState }) {
  const pending = state.outbox.filter((o) => o.recordId === rec.id).length;
  const conflicts = state.conflicts.filter((c) => c.recordId === rec.id);
  return (
    <div className="chip-row">
      <span className="badge badge-muted">v{rec.rev}</span>
      {pending > 0 && <span className="badge badge-warn">待同步 {pending}</span>}
      {conflicts.length > 0 && <span className="badge badge-conflict">待确认 {conflicts.length}</span>}
      {conflicts.map((c) => (
        <div key={c.id} className="conflict-inline">
          ⚠ {FIELD_LABEL[c.field] ?? c.field}：本机「{fmtVal(c.local.value)}」↔ 对方「
          {fmtVal(c.remote.value)}」
        </div>
      ))}
    </div>
  );
}

/* ---------- 编辑表单 ---------- */

type FieldType = "text" | "number" | "trench" | "layer" | "feature" | "ftype" | "overlies";
interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
}

const FIELD_DEFS: Record<string, FieldDef[]> = {
  datum: [
    { key: "name", label: "基准名称", type: "text" },
    { key: "originE", label: "原点E (m)", type: "number" },
    { key: "originN", label: "原点N (m)", type: "number" },
    { key: "rotationDeg", label: "北偏角 (°)", type: "number" },
    { key: "elevation0", label: "高程基准 (m)", type: "number" },
  ],
  trench: [
    { key: "name", label: "探方号", type: "text" },
    { key: "gridE", label: "网格原点E", type: "number" },
    { key: "gridN", label: "网格原点N", type: "number" },
    { key: "size", label: "边长 (m)", type: "number" },
    { key: "note", label: "备注", type: "text" },
  ],
  layer: [
    { key: "name", label: "层位名称", type: "text" },
    { key: "trenchId", label: "所属探方", type: "trench" },
    { key: "soilColor", label: "土色", type: "text" },
    { key: "depthTop", label: "层顶深度 (m)", type: "number" },
    { key: "depthBottom", label: "层底深度 (m)", type: "number" },
    { key: "overlies", label: "叠压于（下伏层）", type: "overlies" },
    { key: "note", label: "备注", type: "text" },
  ],
  feature: [
    { key: "name", label: "遗迹名称", type: "text" },
    { key: "ftype", label: "遗迹类型", type: "ftype" },
    { key: "trenchId", label: "所属探方", type: "trench" },
    { key: "layerId", label: "开口层位（开口于该层下）", type: "layer" },
    { key: "localE", label: "本地E (m)", type: "number" },
    { key: "localN", label: "本地N (m)", type: "number" },
    { key: "localZ", label: "实测深度 (m，可空)", type: "number" },
    { key: "note", label: "备注", type: "text" },
  ],
  artifact: [
    { key: "name", label: "出土物", type: "text" },
    { key: "trenchId", label: "所属探方", type: "trench" },
    { key: "featureId", label: "所属遗迹（可空）", type: "feature" },
    { key: "layerId", label: "所在层位", type: "layer" },
    { key: "localE", label: "本地E (m)", type: "number" },
    { key: "localN", label: "本地N (m)", type: "number" },
    { key: "localZ", label: "实测深度 (m，可空)", type: "number" },
    { key: "note", label: "备注", type: "text" },
  ],
};

function EditForm({
  rec,
  state,
  onClose,
}: {
  rec: VersionedRecord;
  state: StoreState;
  onClose: () => void;
}) {
  const defs = FIELD_DEFS[rec.kind] ?? [];
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(defs.map((d) => [d.key, fv(rec, d.key)]))
  );
  const set = (k: string, v: unknown) => setDraft((prev) => ({ ...prev, [k]: v }));

  const records = Object.values(state.local);
  const trenches = records.filter((r) => r.kind === "trench");
  const layers = records.filter((r) => r.kind === "layer");
  const features = records.filter((r) => r.kind === "feature");
  const draftTrench = String(draft.trenchId ?? "");
  const layerOpts = layers.filter(
    (l) => l.id === draft.layerId || fstr(l, "trenchId") === draftTrench
  );
  const featureOpts = features.filter(
    (f) => f.id === draft.featureId || fstr(f, "trenchId") === draftTrench
  );
  const overliesOpts = layers.filter(
    (l) => l.id !== rec.id && fstr(l, "trenchId") === draftTrench
  );

  const save = () => {
    for (const d of defs) {
      const raw = draft[d.key];
      const val = d.type === "overlies" ? (Array.isArray(raw) ? raw : []) : raw ?? null;
      if (!sameValue(val, fv(rec, d.key))) store.edit(rec.id, d.key, val);
    }
    onClose();
  };

  const renderInput = (d: FieldDef) => {
    const v = draft[d.key];
    switch (d.type) {
      case "number":
        return (
          <input
            type="number"
            step="any"
            value={v === null || v === undefined ? "" : String(v)}
            onChange={(e) => set(d.key, e.target.value === "" ? null : Number(e.target.value))}
          />
        );
      case "text":
        return <input value={String(v ?? "")} onChange={(e) => set(d.key, e.target.value)} />;
      case "trench":
        return (
          <select value={String(v ?? "")} onChange={(e) => set(d.key, e.target.value)}>
            {trenches.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id}
              </option>
            ))}
          </select>
        );
      case "layer":
        return (
          <select value={String(v ?? "")} onChange={(e) => set(d.key, e.target.value)}>
            <option value="">（无）</option>
            {layerOpts.map((l) => (
              <option key={l.id} value={l.id}>
                {recName(l)}（{l.id}）
              </option>
            ))}
          </select>
        );
      case "feature":
        return (
          <select value={String(v ?? "")} onChange={(e) => set(d.key, e.target.value)}>
            <option value="">（无）</option>
            {featureOpts.map((f) => (
              <option key={f.id} value={f.id}>
                {recName(f)}（{f.id}）
              </option>
            ))}
          </select>
        );
      case "ftype":
        return (
          <select value={String(v ?? "灰坑")} onChange={(e) => set(d.key, e.target.value)}>
            {FEATURE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        );
      case "overlies": {
        const arr = Array.isArray(v) ? (v as string[]) : [];
        return (
          <div className="chips">
            {overliesOpts.length === 0 && <span className="dim">同探方暂无其他层位</span>}
            {overliesOpts.map((l) => {
              const checked = arr.includes(l.id);
              return (
                <label key={l.id} className="check-chip">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      set(d.key, checked ? arr.filter((x) => x !== l.id) : [...arr, l.id])
                    }
                  />
                  {l.id} {fstr(l, "name")}
                </label>
              );
            })}
          </div>
        );
      }
    }
  };

  return (
    <div className="edit-form">
      <div className="edit-grid">
        {defs.map((d) => (
          <label key={d.key}>
            <span>{d.label}</span>
            {renderInput(d)}
          </label>
        ))}
      </div>
      <p className="dim form-hint">
        当前基于 v{rec.rev} 编辑；保存后改动带原版本进入待同步清单。地层关系、层位或坐标基准变更会使依赖坐标失效并重算。
      </p>
      <div className="chip-row">
        <button className="primary-action" onClick={save}>
          保存登记
        </button>
        <button onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

/* ---------- 各清单页 ---------- */

interface TabProps {
  state: StoreState;
  editing: string | null;
  setEditing: (id: string | null) => void;
}

function EditRow({
  rec,
  state,
  colSpan,
  onClose,
}: {
  rec: VersionedRecord;
  state: StoreState;
  colSpan: number;
  onClose: () => void;
}) {
  return (
    <tr className="editing-row">
      <td colSpan={colSpan}>
        <EditForm rec={rec} state={state} onClose={onClose} />
      </td>
    </tr>
  );
}

function TrenchTab({ state, editing, setEditing }: TabProps) {
  const datum = state.local["datum"];
  const trenches = Object.values(state.local).filter((r) => r.kind === "trench");
  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p>坐标基准（改动将使全部依赖坐标失效并重算）</p>
            <h2>
              {fmtVal(fv(datum, "name"))} <span className="badge badge-muted">v{datum.rev}</span>
            </h2>
          </div>
          <button onClick={() => setEditing(editing === "datum" ? null : "datum")}>
            {editing === "datum" ? "收起" : "编辑基准"}
          </button>
        </div>
        <p className="mono">
          原点 E {fmtNum(fv(datum, "originE"))} · N {fmtNum(fv(datum, "originN"))} · 北偏角{" "}
          {fmtVal(fv(datum, "rotationDeg"))}° · 高程基准 {fmtNum(fv(datum, "elevation0"))} m
        </p>
        <RowBadges rec={datum} state={state} />
        {editing === "datum" && (
          <EditForm rec={datum} state={state} onClose={() => setEditing(null)} />
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>探方清单（网格原点变更会使本探方坐标失效）</p>
            <h2>探方</h2>
          </div>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>探方</th>
              <th>网格原点</th>
              <th>边长</th>
              <th>备注</th>
              <th>版本 / 状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {trenches.map((rec) => (
              <Fragment key={rec.id}>
                <tr>
                  <td>
                    <b>{rec.id}</b>
                  </td>
                  <td className="mono">
                    E {fmtNum(fv(rec, "gridE"))} · N {fmtNum(fv(rec, "gridN"))}
                  </td>
                  <td>{fmtVal(fv(rec, "size"))} m</td>
                  <td>{fmtVal(fv(rec, "note"))}</td>
                  <td>
                    <RowBadges rec={rec} state={state} />
                  </td>
                  <td>
                    <button onClick={() => setEditing(editing === rec.id ? null : rec.id)}>
                      编辑
                    </button>
                  </td>
                </tr>
                {editing === rec.id && (
                  <EditRow rec={rec} state={state} colSpan={6} onClose={() => setEditing(null)} />
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function LayerTab({ state, editing, setEditing }: TabProps) {
  const layers = Object.values(state.local).filter((r) => r.kind === "layer");
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>地层清单（深度可实测，也可由叠压关系推导）</p>
          <h2>地层</h2>
        </div>
        <button
          className="primary-action"
          onClick={() => setEditing(store.create("layer"))}
        >
          新增地层
        </button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>层位</th>
            <th>探方</th>
            <th>土色</th>
            <th>深度区间</th>
            <th>叠压于</th>
            <th>版本 / 状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {layers.map((rec) => {
            const d = deriveLayerDepth(rec.id, state.local);
            return (
              <Fragment key={rec.id}>
                <tr>
                  <td>
                    <b>{rec.id}</b> {fstr(rec, "name")}
                  </td>
                  <td>{fstr(rec, "trenchId")}</td>
                  <td>{fmtVal(fv(rec, "soilColor"))}</td>
                  <td className="mono">
                    {d.ok ? (
                      `${d.top.toFixed(2)}–${d.bottom.toFixed(2)} m`
                    ) : (
                      <span className="stale-text">未闭合</span>
                    )}
                  </td>
                  <td>{farr(rec, "overlies").join("、") || "—"}</td>
                  <td>
                    <RowBadges rec={rec} state={state} />
                  </td>
                  <td>
                    <button onClick={() => setEditing(editing === rec.id ? null : rec.id)}>
                      编辑
                    </button>
                  </td>
                </tr>
                {editing === rec.id && (
                  <EditRow rec={rec} state={state} colSpan={7} onClose={() => setEditing(null)} />
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function FeatureTab({ state, editing, setEditing }: TabProps) {
  const features = Object.values(state.local).filter((r) => r.kind === "feature");
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>遗迹单位清单（开口层位或基准变更，坐标自动失效）</p>
          <h2>遗迹单位</h2>
        </div>
        <button className="primary-action" onClick={() => setEditing(store.create("feature"))}>
          新增遗迹
        </button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>遗迹</th>
            <th>探方</th>
            <th>开口层位</th>
            <th>本地坐标</th>
            <th>绝对坐标（遗址控制网）</th>
            <th>版本 / 状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {features.map((rec) => (
            <Fragment key={rec.id}>
              <tr>
                <td>
                  <b>{rec.id}</b> {fstr(rec, "name")}
                  <div className="dim">{fstr(rec, "ftype")}</div>
                </td>
                <td>{fstr(rec, "trenchId")}</td>
                <td>{fstr(rec, "layerId") || "—"}</td>
                <td className="mono">
                  E {fmtNum(fv(rec, "localE"))} · N {fmtNum(fv(rec, "localN"))} · Z{" "}
                  {fv(rec, "localZ") === null ? "随层位" : fmtNum(fv(rec, "localZ"))}
                </td>
                <td>
                  <CoordCell coord={state.coords[rec.id]} />
                </td>
                <td>
                  <RowBadges rec={rec} state={state} />
                </td>
                <td>
                  <button onClick={() => setEditing(editing === rec.id ? null : rec.id)}>编辑</button>
                </td>
              </tr>
              {editing === rec.id && (
                <EditRow rec={rec} state={state} colSpan={7} onClose={() => setEditing(null)} />
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ArtifactTab({ state, editing, setEditing }: TabProps) {
  const artifacts = Object.values(state.local).filter((r) => r.kind === "artifact");
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>出土物清单（深度可实测、随所属遗迹或所在层位）</p>
          <h2>出土物</h2>
        </div>
        <button className="primary-action" onClick={() => setEditing(store.create("artifact"))}>
          新增出土物
        </button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>出土物</th>
            <th>探方</th>
            <th>所属遗迹</th>
            <th>所在层位</th>
            <th>本地坐标</th>
            <th>绝对坐标（遗址控制网）</th>
            <th>版本 / 状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((rec) => (
            <Fragment key={rec.id}>
              <tr>
                <td>
                  <b>{rec.id}</b> {fstr(rec, "name")}
                </td>
                <td>{fstr(rec, "trenchId")}</td>
                <td>{fstr(rec, "featureId") || "—"}</td>
                <td>{fstr(rec, "layerId") || "—"}</td>
                <td className="mono">
                  E {fmtNum(fv(rec, "localE"))} · N {fmtNum(fv(rec, "localN"))} · Z{" "}
                  {fv(rec, "localZ") === null ? "随遗迹/层位" : fmtNum(fv(rec, "localZ"))}
                </td>
                <td>
                  <CoordCell coord={state.coords[rec.id]} />
                </td>
                <td>
                  <RowBadges rec={rec} state={state} />
                </td>
                <td>
                  <button onClick={() => setEditing(editing === rec.id ? null : rec.id)}>编辑</button>
                </td>
              </tr>
              {editing === rec.id && (
                <EditRow rec={rec} state={state} colSpan={8} onClose={() => setEditing(null)} />
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ConflictTab({ state }: { state: StoreState }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>同字段冲突：两版都保留，确认一版后写入双方</p>
          <h2>待确认（{state.conflicts.length}）</h2>
        </div>
      </div>
      {state.conflicts.length === 0 && (
        <p className="dim">无待确认冲突。回连合并时若双方改了同一字段，两版会保留在这里。</p>
      )}
      {state.conflicts.map((c) => {
        const rec = state.local[c.recordId];
        return (
          <article key={c.id} className="conflict-card">
            <header>
              <b>
                {KIND_LABEL[c.kind]} {recName(rec)}（{c.recordId}）· {FIELD_LABEL[c.field] ?? c.field}
              </b>
              <span className="badge badge-conflict">待确认</span>
            </header>
            <div className="conflict-versions">
              <div>
                <p className="dim">
                  本机版本 v{c.local.rev} · {c.local.by} · {fmtTime(c.local.at)}
                </p>
                <p className="conflict-value">{fmtVal(c.local.value)}</p>
                <button
                  className="primary-action"
                  disabled={!state.online}
                  onClick={() => store.resolveConflict(c.id, "local")}
                >
                  采用本机
                </button>
              </div>
              <div>
                <p className="dim">
                  对方版本 v{c.remote.rev} · {c.remote.by} · {fmtTime(c.remote.at)}
                </p>
                <p className="conflict-value">{fmtVal(c.remote.value)}</p>
                <button
                  disabled={!state.online}
                  onClick={() => store.resolveConflict(c.id, "remote")}
                >
                  采用对方
                </button>
              </div>
            </div>
            {!state.online && <p className="dim">离线中：回连后才能确认。</p>}
          </article>
        );
      })}
    </section>
  );
}

function TaskTab({ state }: { state: StoreState }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>坐标重算待办：失败保留草稿，下次打开自动继续</p>
          <h2>重算待办（{state.tasks.length}）</h2>
        </div>
        <button onClick={() => store.retryTasks()} disabled={state.tasks.length === 0}>
          立即重试
        </button>
      </div>
      {state.tasks.length === 0 && <p className="dim">无待办：所有依赖坐标均为最新。</p>}
      {state.tasks.map((t) => {
        const rec = state.local[t.recordId];
        return (
          <article key={t.recordId} className="task-card">
            <header>
              <b>
                {recName(rec)}（{t.recordId}）· {KIND_LABEL[t.kind]}
              </b>
              <span className="badge badge-bad">待重算</span>
            </header>
            <p>起因：{t.cause}</p>
            <p>最近失败：{t.lastError ?? "—"}</p>
            <p className="dim">
              已尝试 {t.attempts} 次 · 登记于 {fmtTime(t.enqueuedAt)} · 草稿与待办已保存，下次打开自动继续
            </p>
          </article>
        );
      })}
    </section>
  );
}

function LogTab({ state }: { state: StoreState }) {
  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p>离线改动带原版本，回连时按字段合并</p>
            <h2>待同步改动（{state.outbox.length}）</h2>
          </div>
        </div>
        {state.outbox.length === 0 ? (
          <p className="dim">无待同步改动。</p>
        ) : (
          <ul className="outbox-list">
            {state.outbox.map((o, i) => (
              <li key={`${o.recordId}-${o.field}-${i}`}>
                <b>
                  {o.recordId}.{FIELD_LABEL[o.field] ?? o.field}
                </b>{" "}
                → {fmtVal(o.value)}{" "}
                <span className="dim">
                  基于 v{o.baseRev}（字段 v{o.baseFieldRev}）· {o.by} · {fmtTime(o.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p>合并、失效与重算留痕</p>
            <h2>同步日志</h2>
          </div>
        </div>
        <div className="log-list">
          {state.log.map((entry, i) => (
            <div key={`${entry.at}-${i}`} className={`log-item ${entry.tone}`}>
              <span className="dim">{fmtTime(entry.at)}</span> {entry.text}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/* ---------- 主界面 ---------- */

type TabId = "feature" | "artifact" | "layer" | "trench" | "conflict" | "task" | "log";

function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [tab, setTab] = useState<TabId>("feature");
  const [editing, setEditing] = useState<string | null>(null);

  const records = Object.values(state.local);
  const count = (kind: VersionedRecord["kind"]) => records.filter((r) => r.kind === kind).length;
  const invalidList = Object.entries(state.coords)
    .filter(([, c]) => c.status !== "valid")
    .map(([id, c]) => ({ id, name: recName(state.local[id]), reason: c.reason ?? "" }));

  const metrics: { label: string; value: number; tone: string }[] = [
    { label: "探方", value: count("trench"), tone: "status-ok" },
    { label: "地层", value: count("layer"), tone: "status-ok" },
    { label: "遗迹单位", value: count("feature"), tone: "status-watch" },
    { label: "出土物", value: count("artifact"), tone: "status-watch" },
    { label: "待确认冲突", value: state.conflicts.length, tone: "status-danger" },
    { label: "失效坐标", value: invalidList.length, tone: "status-danger" },
  ];

  const tabs: { id: TabId; label: string }[] = [
    { id: "feature", label: "遗迹单位" },
    { id: "artifact", label: "出土物" },
    { id: "layer", label: "地层" },
    { id: "trench", label: "探方与坐标基准" },
    { id: "conflict", label: `待确认 ${state.conflicts.length}` },
    { id: "task", label: `重算待办 ${state.tasks.length}` },
    { id: "log", label: "同步日志" },
  ];

  const tabProps: TabProps = { state, editing, setEditing };

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-10 · 可续作现场记录</p>
          <h1>考古探方记录</h1>
          <p className="subtitle">
            断网登记带原版本，回连按字段合并；同字段冲突保留两版待确认。地层关系或坐标基准一变，
            依赖它的遗迹与出土物坐标即失效并重算；重算失败保留草稿与待办，下次打开继续。
          </p>
          <div className="toolbar">
            <span className={`conn ${state.online ? "online" : "offline"}`}>
              {state.online ? "● 在线" : "● 离线（断网登记中）"}
            </span>
            {state.online ? (
              <button onClick={() => store.setOnline(false)}>模拟断网</button>
            ) : (
              <button className="primary-action" onClick={() => store.setOnline(true)}>
                回连并按字段合并
              </button>
            )}
            <button onClick={() => store.syncNow()} disabled={!state.online}>
              立即同步
            </button>
            <button
              onClick={() => {
                if (window.confirm("清空本机与对方副本，恢复初始演示数据？")) store.reset();
              }}
            >
              重置演示数据
            </button>
          </div>
        </div>
        <div className="stack-card">
          <span>演示流程：模拟断网 → 断网登记 → 对方补录 → 回连合并</span>
          <div className="peer-actions">
            <button onClick={() => store.demoLocal()}>断网登记（H12 复测＋陶纺轮）</button>
          </div>
          <span>对方操作模拟（领队端）</span>
          <div className="peer-actions">
            <button onClick={() => store.peerStrata()}>补录地层关系 L104</button>
            <button onClick={() => store.peerFeature()}>改动 H12 层位/坐标</button>
            <button onClick={() => store.peerDatum()}>调整坐标基准</button>
          </div>
        </div>
      </section>

      <section className="metrics-grid">
        {metrics.map((m) => (
          <article key={m.label} className="metric-card">
            <span>{m.label}</span>
            <strong>{m.value}</strong>
            <i className={m.tone} />
          </article>
        ))}
      </section>

      <section className="summary-grid">
        <article>
          <h3>当前版本</h3>
          <p className="mono">
            本机 v{state.localSeq} · 对方 v{state.serverSeq}
          </p>
          <p className="dim">
            已合并 {state.syncSeq} 轮 · 待同步 {state.outbox.length} 条
            {state.online ? "" : " · 离线中"}
          </p>
        </article>
        <article>
          <h3>待确认项</h3>
          <p className="mono">
            字段冲突 {state.conflicts.length} · 重算待办 {state.tasks.length}
          </p>
          <p className="dim">
            {state.conflicts.length + state.tasks.length === 0
              ? "无待确认事项"
              : "请在「待确认 / 重算待办」页处理"}
          </p>
        </article>
        <article>
          <h3>失效范围</h3>
          {invalidList.length === 0 ? (
            <p className="dim">无失效坐标</p>
          ) : (
            <ul className="invalid-list">
              {invalidList.slice(0, 4).map((x) => (
                <li key={x.id}>
                  {x.name}（{x.id}）：{x.reason}
                </li>
              ))}
              {invalidList.length > 4 && <li>…共 {invalidList.length} 条</li>}
            </ul>
          )}
        </article>
      </section>

      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => {
              setTab(t.id);
              setEditing(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "trench" && <TrenchTab {...tabProps} />}
      {tab === "layer" && <LayerTab {...tabProps} />}
      {tab === "feature" && <FeatureTab {...tabProps} />}
      {tab === "artifact" && <ArtifactTab {...tabProps} />}
      {tab === "conflict" && <ConflictTab state={state} />}
      {tab === "task" && <TaskTab state={state} />}
      {tab === "log" && <LogTab state={state} />}
    </main>
  );
}

export default App;
