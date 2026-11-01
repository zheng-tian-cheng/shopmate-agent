// 两款商品的同维度比较（PRD V0.8 第 5.4 节）。数据集中没有的项显示“暂未收录”，不补猜。

import type { Product } from './products.ts';
import { NOT_LISTED, ancLabel, batteryLabel, bluetoothLabel, priceLabel, wearingLabel, weightLabel } from './products.ts';

export const MAX_COMPARE = 2;

export interface CompareRow {
  label: string;
  values: [string, string];
  differs: boolean;
}

export function compareProducts(a: Product, b: Product): CompareRow[] {
  const rows: [string, (p: Product) => string][] = [
    ['价格', priceLabel],
    ['佩戴方式', wearingLabel],
    ['主动降噪', ancLabel],
    ['降噪深度（标称）', p => p.ancSpec ?? NOT_LISTED],
    ['续航', batteryLabel],
    ['重量', weightLabel],
    ['蓝牙版本', bluetoothLabel],
  ];
  return rows.map(([label, read]) => {
    const values: [string, string] = [read(a), read(b)];
    return { label, values, differs: values[0] !== values[1] };
  });
}

export function toggleCompare(ids: readonly string[], id: string): { ids: string[]; error: string | null } {
  if (ids.includes(id)) return { ids: ids.filter(x => x !== id), error: null };
  if (ids.length >= MAX_COMPARE) return { ids: [...ids], error: `最多同时比较 ${MAX_COMPARE} 款，请先移除一款。` };
  return { ids: [...ids, id], error: null };
}
