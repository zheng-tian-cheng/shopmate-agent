import { supportsField } from './categories.ts';
// “修改条件”表单与条件变更之间的转换。表单只读写已生效的条件，
// 提交时只为有变化的字段生成变更，没改的字段（以及未生效的建议、待确认项）保持不变。

import type { ActiveCondition, ConditionChange, ConditionField, ConditionState } from './conditions.ts';
import { getCondition, valueError } from './conditions.ts';

export interface ConditionFormValues {
  budget: string;
  budgetKind: 'hard' | 'soft';
  anc: 'any' | 'hard' | 'soft';
  excludeInEar: boolean;
  scene: string;
}


function confirmed(state: ConditionState, field: ConditionField): ActiveCondition | undefined {
  const c = getCondition(state, field);
  return c?.status === 'confirmed' ? c : undefined;
}

export function formFromState(state: ConditionState): ConditionFormValues {
  const budget = confirmed(state, 'budget');
  const anc = confirmed(state, 'anc');
  const wearing = confirmed(state, 'wearingStyle');
  const scene = confirmed(state, 'scene');
  return {
    budget: budget ? String(budget.value) : '',
    budgetKind: budget?.kind === 'soft' ? 'soft' : 'hard',
    anc: anc && anc.value === true ? (anc.kind === 'soft' ? 'soft' : 'hard') : 'any',
    excludeInEar: Boolean(wearing && wearing.kind === 'hard' && (wearing.value as { exclude: string[] }).exclude.includes('入耳式')),
    scene: scene ? String(scene.value) : '',
  };
}

export function formToChanges(values: ConditionFormValues, state: ConditionState): { changes: ConditionChange[]; error: string | null } {
  const before = formFromState(state);
  const changes: ConditionChange[] = [];

  const budgetText = values.budget.trim();
  if (budgetText !== before.budget || (budgetText && values.budgetKind !== before.budgetKind)) {
    if (budgetText === '') {
      if (confirmed(state, 'budget')) changes.push({ op: 'remove', field: 'budget' });
    } else {
      const amount = Number(budgetText);
      const error = valueError('budget', amount);
      if (error) return { changes: [], error };
      changes.push({ op: 'set', field: 'budget', kind: values.budgetKind, value: amount });
    }
  }

  if (values.anc !== before.anc) {
    if (values.anc === 'any') {
      if (confirmed(state, 'anc')) changes.push({ op: 'remove', field: 'anc' });
    } else {
      changes.push({ op: 'set', field: 'anc', kind: values.anc, value: true });
    }
  }

  if (values.excludeInEar !== before.excludeInEar) {
    if (values.excludeInEar) changes.push({ op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } });
    else if (confirmed(state, 'wearingStyle')) changes.push({ op: 'remove', field: 'wearingStyle' });
  }

  if (values.scene !== before.scene) {
    if (values.scene === '') {
      if (confirmed(state, 'scene')) changes.push({ op: 'remove', field: 'scene' });
    } else {
      changes.push({ op: 'set', field: 'scene', kind: 'scene', value: values.scene });
    }
  }

  return { changes: changes.filter(c => supportsField(state.category, c.field)), error: null };
}
