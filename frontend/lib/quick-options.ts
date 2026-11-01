import { supportsField } from './categories.ts';
// 快捷选项：点击后直接生成条件变更，不经过文字解析（PRD V0.8 第 5.2、7.5 节）。
// 每轮最多 4 个；已经有条件（含建议和待确认）的字段不再重复提供。

import type { ConditionChange, ConditionField, ConditionState } from './conditions.ts';
import { getCondition } from './conditions.ts';

export interface QuickOption {
  id: string;
  label: string;
  field: ConditionField;
  changes: ConditionChange[];
}

const CANDIDATES: QuickOption[] = [
  { id: 'budget-200', label: '200 元以内', field: 'budget', changes: [{ op: 'set', field: 'budget', kind: 'hard', value: 200 }] },
  { id: 'budget-300', label: '300 元以内', field: 'budget', changes: [{ op: 'set', field: 'budget', kind: 'hard', value: 300 }] },
  { id: 'anc-hard', label: '必须主动降噪', field: 'anc', changes: [{ op: 'set', field: 'anc', kind: 'hard', value: true }] },
  { id: 'anc-soft', label: '最好有降噪', field: 'anc', changes: [{ op: 'set', field: 'anc', kind: 'soft', value: true }] },
  { id: 'no-in-ear', label: '不要入耳式', field: 'wearingStyle', changes: [{ op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } }] },
  { id: 'scene-commute', label: '地铁通勤', field: 'scene', changes: [{ op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' }] },
];

export const MAX_QUICK_OPTIONS = 4;

export function quickOptions(state: ConditionState): QuickOption[] {
  return CANDIDATES.filter(option => supportsField(state.category, option.field) && !getCondition(state, option.field)).slice(0, MAX_QUICK_OPTIONS);
}
