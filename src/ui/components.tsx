import { ReactNode, useState } from "react";
import { Entity } from "../types";
import {
  COMPUTED_KEYS,
  COMPUTED_LABEL,
  ENTITY_LABEL,
  FIELDS,
  fieldLabel,
} from "../model";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "danger" | "accent";
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function VersionLine({ e }: { e: Entity }) {
  return (
    <div className="version-line">
      <Badge tone="accent">当前版本 v{e.version}</Badge>
      {e.version !== e.baseVersion && (
        <Badge tone="warn">离线原版本 v{e.baseVersion}</Badge>
      )}
      {e.isDraft && <Badge tone="warn">本机草稿·待上传</Badge>}
      {Object.keys(e.conflicts).length > 0 && (
        <Badge tone="danger">{Object.keys(e.conflicts).length} 字段待确认</Badge>
      )}
      {e.invalidated && <Badge tone="danger">坐标失效</Badge>}
    </div>
  );
}

export function ComputedRow({ e }: { e: Entity }) {
  const keys = COMPUTED_KEYS[e.type];
  if (keys.length === 0) return null;
  return (
    <div className="computed-row">
      {keys.map((k) => {
        const v = e.computed[k];
        const isInvalid = e.invalidated?.keys.includes(k) || v == null;
        return (
          <div
            key={k}
            className={`computed-chip ${isInvalid ? "is-invalid" : "is-ok"}`}
            title={isInvalid ? (e.invalidated?.reason ?? "等待重算") : "已重算"}
          >
            <span>{COMPUTED_LABEL[k]}</span>
            <strong>{v ?? "失效待算"}</strong>
          </div>
        );
      })}
    </div>
  );
}

/** 冲突三版对照：原版本 / 本机版 / 对端版，逐条选择 */
export function ConflictPanel({
  e,
  onResolve,
}: {
  e: Entity;
  onResolve: (id: string, key: string, value: string) => void;
}) {
  const conflicts = Object.values(e.conflicts);
  if (conflicts.length === 0) return null;
  return (
    <div className="conflict-panel">
      <h4>同字段冲突 · 两版保留，确认后才生效</h4>
      {conflicts.map((c) => (
        <div key={c.key} className="conflict-item">
          <p className="conflict-title">{fieldLabel(e.type, c.key)}</p>
          <div className="conflict-options">
            <ConflictChoice
              tag={`原版本 v${c.baseVersion}`}
              value={c.base}
              tone="neutral"
              onPick={() => onResolve(e.id, c.key, c.base)}
            />
            <ConflictChoice
              tag={`本机 v${c.localVersion}`}
              value={c.local}
              tone="accent"
              onPick={() => onResolve(e.id, c.key, c.local)}
            />
            <ConflictChoice
              tag={`对端 v${c.remoteVersion}`}
              value={c.remote}
              tone="ok"
              onPick={() => onResolve(e.id, c.key, c.remote)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ConflictChoice({
  tag,
  value,
  tone,
  onPick,
}: {
  tag: string;
  value: string;
  tone: "neutral" | "accent" | "ok";
  onPick: () => void;
}) {
  return (
    <button className={`conflict-choice tone-${tone}`} onClick={onPick}>
      <span>{tag}</span>
      <strong>{value === "" ? "（空）" : value}</strong>
      <em>采用此版</em>
    </button>
  );
}

/** 实体编辑表单：冲突字段锁定，必须先在冲突面板确认 */
export function EntityForm({
  e,
  onSave,
}: {
  e: Entity;
  onSave: (patch: Record<string, string>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({ ...e.fields });
  const defs = FIELDS[e.type];
  return (
    <form
      className="entity-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSave(draft);
      }}
    >
      <div className="form-grid">
        {defs.map((def) => {
          const locked = def.key in e.conflicts;
          return (
            <label key={def.key} className={locked ? "field-locked" : ""}>
              <span>
                {def.label}
                {locked && <em className="lock-hint">（冲突待确认，已锁定）</em>}
              </span>
              {def.kind === "select" ? (
                <select
                  value={draft[def.key] ?? ""}
                  disabled={locked}
                  onChange={(ev) =>
                    setDraft((d) => ({ ...d, [def.key]: ev.target.value }))
                  }
                >
                  {def.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={def.kind === "number" ? "number" : "text"}
                  step="0.001"
                  value={draft[def.key] ?? ""}
                  placeholder={def.placeholder}
                  disabled={locked}
                  onChange={(ev) =>
                    setDraft((d) => ({ ...d, [def.key]: ev.target.value }))
                  }
                />
              )}
            </label>
          );
        })}
      </div>
      <div className="modal-foot">
        <button type="submit" className="primary-action">
          保存登记（{ENTITY_LABEL[e.type]}）
        </button>
      </div>
    </form>
  );
}

/** 新建表单 */
export function NewEntityForm({
  type,
  parentId,
  parentChoices,
  onSave,
}: {
  type: Entity["type"];
  parentId: string | null;
  parentChoices: { id: string; label: string }[];
  onSave: (parentId: string | null, fields: Record<string, string>) => void;
}) {
  const blank = Object.fromEntries(
    FIELDS[type].map((d) => [d.key, d.key === "code" ? "" : ""])
  );
  const [fields, setFields] = useState<Record<string, string>>(blank);
  const [pid, setPid] = useState<string>(parentId ?? "");
  return (
    <form
      className="entity-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSave(pid || null, { ...fields, code: fields.code || "未命名" });
      }}
    >
      <div className="form-grid">
        {FIELDS[type].map((def) => (
          <label key={def.key}>
            <span>{def.label}</span>
            {def.kind === "select" ? (
              <select
                value={fields[def.key] ?? ""}
                onChange={(ev) =>
                  setFields((f) => ({ ...f, [def.key]: ev.target.value }))
                }
              >
                {def.options?.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={def.kind === "number" ? "number" : "text"}
                step="0.001"
                value={fields[def.key] ?? ""}
                placeholder={def.placeholder}
                onChange={(ev) =>
                  setFields((f) => ({ ...f, [def.key]: ev.target.value }))
                }
              />
            )}
          </label>
        ))}
      </div>
      <label className="parent-pick">
        <span>上级单位</span>
        <select value={pid} onChange={(ev) => setPid(ev.target.value)}>
          <option value="">{type === "square" ? "（无，独立探方）" : "（未指定）"}</option>
          {parentChoices.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="modal-foot">
        <button type="submit" className="primary-action">
          新增{ENTITY_LABEL[type]}
        </button>
      </div>
    </form>
  );
}
