// 品类目录只声明入口和可用字段；未开放品类不具备筛选或推荐能力。
import type { ConditionField } from './conditions.ts';

export const COMMON_FIELDS: readonly ConditionField[] = ['budget', 'scene'];
export const CATEGORIES = {
  headphones: { label: '蓝牙耳机', enabled: true, fields: ['anc', 'wearingStyle'], scenes: ['地铁通勤', '日常学习', '运动'] },
  sofa: { label: '家居沙发', enabled: false, fields: [], scenes: [] },
  appliances: { label: '生活家电', enabled: false, fields: [], scenes: [] },
  outdoors: { label: '户外出行', enabled: false, fields: [], scenes: [] },
} as const;
export type CategoryId = keyof typeof CATEGORIES;
export type ShoppingCategory = CategoryId | null;
export function supportsField(category: ShoppingCategory, field: ConditionField): boolean {
  return COMMON_FIELDS.includes(field) || Boolean(category && (CATEGORIES[category].fields as readonly string[]).includes(field));
}
