'use client';
import { useState } from 'react';
import type { ActiveCondition, ConditionChange, PendingCondition } from '../lib/conditions';
import { describeCondition } from '../lib/conditions';
import type { ConditionFormValues } from '../lib/condition-form';
import { formFromState, formToChanges } from '../lib/condition-form';
import { CATEGORIES, supportsField } from '../lib/categories';
import { useShop } from './ShopProvider';

const KIND_TAG = { hard: '必须', soft: '偏好', scene: '场景' } as const;

function sourceTag(c: ActiveCondition): string {
  if (c.source === 'page') return '来自商品列表';
  if (c.source === 'system') return '系统建议 · 你已采纳';
  return '你设置的';
}

export function ConditionPanel() {
  const { session, dispatch } = useShop();
  const { state, status } = session.assistant;
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState<ConditionFormValues>(() => formFromState(state));
  const [error, setError] = useState<string | null>(null);

  const confirmed = state.conditions.filter((c): c is ActiveCondition => c.status === 'confirmed');
  const suggested = state.conditions.filter((c): c is ActiveCondition => c.status === 'suggested');
  const pending = state.conditions.filter((c): c is PendingCondition => c.status === 'pending');
  const act = (label: string, changes: ConditionChange[]) => dispatch({ type: 'uiChanges', label, changes });

  function startEdit() {
    setForm(formFromState(state));
    setError(null);
    setExpanded(true);
  }

  function save() {
    const result = formToChanges(form, state);
    if (result.error) {
      setError(result.error);
      return;
    }
    setExpanded(false);
    if (result.changes.length) act('修改条件', result.changes);
  }

  return (
    <section className="conditions assistant-section" aria-labelledby="conditions-title">
      <div className="condition-summary" id="conditions-title">
        <button className="condition-toggle" type="button" aria-expanded={expanded} onClick={expanded ? () => setExpanded(false) : startEdit}>
          <span>当前需求 · {state.category ? CATEGORIES[state.category].label : '未选品类'}</span><span>{expanded ? '收起 −' : '调整 ＋'}</span>
        </button>
        {!expanded && <div className="condition-tags">
          {confirmed.map(c => <button key={c.field} onClick={startEdit} title={sourceTag(c)}>{c.kind === 'scene' ? describeCondition(c) : `${KIND_TAG[c.kind]} · ${describeCondition(c)}`}</button>)}
          {suggested.length > 0 && <button className="suggested-tag" onClick={startEdit}>建议 {suggested.length} 项 · 未生效</button>}
          {pending.length > 0 && <button className="pending-tag" onClick={startEdit}>待确认 {pending.length} 项</button>}
          {state.conditions.length === 0 && <span className="muted">还没有设置条件</span>}
        </div>}
      </div>
      {expanded && <div className="condition-expanded">
      {suggested.map(c => (
        <div key={c.field} className="status-card suggested">
          <span className="status">系统建议 · 未生效</span>
          <span>{describeCondition(c)}</span>
          {c.reason && <span className="reason">理由：{c.reason}</span>}
          <div className="actions">
            {c.field === 'scene' ? (
              <button type="button" className="button green small" onClick={() => act(`采纳建议：${describeCondition(c)}`, [{ op: 'confirm', field: c.field }])}>采纳</button>
            ) : (
              <>
                <button type="button" className="button green small" onClick={() => act('采纳建议，设为必须条件', [{ op: 'confirm', field: c.field, kind: 'hard' }])}>设为必须</button>
                <button type="button" className="button outline small" onClick={() => act('采纳建议，作为偏好', [{ op: 'confirm', field: c.field, kind: 'soft' }])}>作为偏好</button>
              </>
            )}
            <button type="button" className="button ghost small" onClick={() => act(`不需要：${describeCondition(c)}`, [{ op: 'dismiss', field: c.field }])}>不需要</button>
          </div>
        </div>
      ))}

      {pending.map(c => (
        <div key={c.field} className="status-card pending">
          <span className="status">需要你确认 · 未生效</span>
          <span>{c.question}</span>
          <span className="reason">你说的是“{c.rawText}”</span>
          <div className="actions">
            {c.options.map((o, i) => (
              <button key={o.label} type="button" className="button outline small" onClick={() => act(o.label, [{ op: 'resolve', field: c.field, option: i }])}>{o.label}</button>
            ))}
          </div>
        </div>
      ))}

        <form className="condition-form" onSubmit={e => { e.preventDefault(); save(); }}>
          <h3 className="condition-group-title">通用条件</h3>
          <div className="row">
            <label className="field">预算（元）
              <input type="number" min="0.01" max="100000" step="0.01" placeholder="留空表示不限" value={form.budget} onChange={e => setForm({ ...form, budget: e.target.value })} />
            </label>
            <label className="field">预算类型
              <select value={form.budgetKind} onChange={e => setForm({ ...form, budgetKind: e.target.value as ConditionFormValues['budgetKind'] })}>
                <option value="hard">上限（必须）</option>
                <option value="soft">参考（偏好）</option>
              </select>
            </label>
            <label className="field">使用场景
              <select value={form.scene} onChange={e => setForm({ ...form, scene: e.target.value })}>
                <option value="">不限</option>
                {(state.category ? CATEGORIES[state.category].scenes : []).map(s => <option key={s}>{s}</option>)}
              </select>
            </label>
          </div>
          {supportsField(state.category, 'anc') && <>
          <h3 className="condition-group-title">{state.category && CATEGORIES[state.category].label}专属条件</h3>
            <label className="field">主动降噪
              <select value={form.anc} onChange={e => setForm({ ...form, anc: e.target.value as ConditionFormValues['anc'] })}>
                <option value="any">不限</option>
                <option value="hard">必须支持</option>
                <option value="soft">最好有</option>
              </select>
            </label>
          <label className="check">
            <input type="checkbox" checked={form.excludeInEar} onChange={e => setForm({ ...form, excludeInEar: e.target.checked })} /> 排除入耳式（必须）
          </label></>}
          <p className="muted">使用场景只用于展示，不参与筛选。</p>
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="foot-row">
            <span className="spacer" />
            <button type="button" className="button ghost small" onClick={() => setExpanded(false)}>取消</button>
            <button type="submit" className="button green small">保存</button>
          </div>
        </form>
      </div>}
    </section>
  );
}
