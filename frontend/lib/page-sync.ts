// 商品列表筛选与助手条件之间的映射（PRD V0.8 第 5.3 节，场景 A、B）。
// 列表筛选本身也转换成 ConditionState，再交给同一个 searchProducts，避免两套筛选规则。

import type { ActiveCondition, Condition, ConditionChange, ConditionState } from './conditions.ts';
import { applyChanges, emptyState, formatYuan, getCondition } from './conditions.ts';

export interface PageFilters {
  budgetMax: number | null;
  ancRequired: boolean;
  excludeInEar: boolean;
}

export const DEFAULT_PAGE_FILTERS: PageFilters = { budgetMax: null, ancRequired: false, excludeInEar: false };

export function pageFiltersToChanges(filters: PageFilters): ConditionChange[] {
  const changes: ConditionChange[] = [];
  if (filters.budgetMax !== null) changes.push({ op: 'set', field: 'budget', kind: 'hard', value: filters.budgetMax });
  if (filters.ancRequired) changes.push({ op: 'set', field: 'anc', kind: 'hard', value: true });
  if (filters.excludeInEar) changes.push({ op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } });
  return changes;
}

// 场景 A：从列表打开助手时继承列表的筛选，来源标记为 page。
export async function stateFromPageFilters(filters: PageFilters): Promise<ConditionState> {
  return (await applyChanges(emptyState(), pageFiltersToChanges(filters), 'page')).state;
}

function isMapped(condition: Condition): condition is ActiveCondition {
  if (condition.status !== 'confirmed' || condition.kind !== 'hard') return false;
  if (condition.field === 'budget') return true;
  if (condition.field === 'anc') return condition.value === true;
  if (condition.field === 'wearingStyle') {
    const exclude = (condition.value as { exclude: string[] }).exclude;
    return exclude.length === 1 && exclude[0] === '入耳式';
  }
  return false;
}

// 场景 B：用户点击“应用到商城筛选”时，把能映射的已生效硬约束写回列表；
// 列表筛选完全以助手的已生效硬约束为准，其余条件（场景、偏好、建议、待确认）留在助手里，不写回列表。
export function projectToPageFilters(state: ConditionState): { filters: PageFilters; unmapped: Condition[] } {
  const budget = getCondition(state, 'budget');
  const anc = getCondition(state, 'anc');
  const wearing = getCondition(state, 'wearingStyle');
  const filters: PageFilters = {
    budgetMax: budget && isMapped(budget) ? (budget.value as number) : null,
    ancRequired: Boolean(anc && isMapped(anc)),
    excludeInEar: Boolean(wearing && isMapped(wearing)),
  };
  return { filters, unmapped: state.conditions.filter(c => !isMapped(c)) };
}

// 给用户看的商城筛选说明，如 ["¥200 以内", "支持主动降噪"]；没有可用于商城的条件时为空
export function describePageFilters(filters: PageFilters): string[] {
  const parts: string[] = [];
  if (filters.budgetMax !== null) parts.push(`${formatYuan(filters.budgetMax)} 以内`);
  if (filters.ancRequired) parts.push('支持主动降噪');
  if (filters.excludeInEar) parts.push('非入耳式');
  return parts;
}

// “按 ¥200 以内、支持主动降噪”：金额前留空格，文字直接相连
export function byPageFilters(filters: PageFilters): string {
  const text = describePageFilters(filters).join('、');
  return `按${text.startsWith('¥') ? ' ' : ''}${text}`;
}

export function samePageFilters(a: PageFilters, b: PageFilters): boolean {
  return a.budgetMax === b.budgetMax && a.ancRequired === b.ancRequired && a.excludeInEar === b.excludeInEar;
}
