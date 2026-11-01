import './reference/mock-api.ts';
// 逐条运行 contracts/condition-cases.json。第 2 阶段的 FastAPI 实现用同一份文件测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChangeOrigin, Condition, ConditionChange, ConditionField, ConditionState, WearingStyle } from './reference/conditions.ts';
import { SCHEMA_VERSION, applyChanges, emptyState, validateState } from './reference/conditions.ts';
import { searchProducts } from './reference/search.ts';

interface ApplyCase {
  name: string;
  steps: { origin: ChangeOrigin; changes: ConditionChange[] }[];
  expect: { conditions: Condition[]; dismissed: ConditionField[]; rejectedOps: string[] };
}
interface SearchCase {
  name: string;
  products: { id: string; price: number | null; anc: boolean | 'unknown'; wearingStyle: WearingStyle | 'unknown' }[];
  conditions: Condition[];
  expectIds: string[];
}

const contract = JSON.parse(readFileSync(new URL('../../contracts/condition-cases.json', import.meta.url), 'utf8')) as {
  schemaVersion: number;
  applyCases: ApplyCase[];
  searchCases: SearchCase[];
};

test('契约版本与前端数据结构一致', async () => {
  assert.equal(contract.schemaVersion, SCHEMA_VERSION);
  assert.ok(contract.applyCases.length > 0 && contract.searchCases.length > 0);
});

for (const c of contract.applyCases) {
  test(`条件变更：${c.name}`, async () => {
    let state = emptyState();
    const rejectedOps: string[] = [];
    for (const step of c.steps) {
      const result = applyChanges(state, step.changes, step.origin);
      rejectedOps.push(...result.rejected.map(r => r.change.op));
      state = result.state;
      assert.deepEqual(validateState(state), []);
    }
    assert.deepEqual(state.conditions, c.expect.conditions);
    assert.deepEqual(state.dismissed, c.expect.dismissed);
    assert.deepEqual(rejectedOps, c.expect.rejectedOps);
  });
}

for (const c of contract.searchCases) {
  test(`筛选：${c.name}`, async () => {
    const state: ConditionState = { ...emptyState(), conditions: c.conditions };
    assert.deepEqual(validateState(state), []);
    const products = c.products.map(p => ({ id: p.id, anc: p.anc, wearingStyle: p.wearingStyle, price: { amount: p.price, conditions: '', verifiedAt: null } }));
    assert.deepEqual(searchProducts(products, state).map(m => m.product.id), c.expectIds);
  });
}
