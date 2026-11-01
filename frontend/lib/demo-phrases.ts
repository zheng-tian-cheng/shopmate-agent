// 固定话术：第 1 阶段用来代替文字理解的演示规则，不是 LLM，也不是自然语言理解。
// 只认下面列出的句子（忽略标点和空格），其他输入一律不改变条件。
// 输出的是条件变更（与第 3 阶段 LLM 的输出格式相同），由 applyChanges 统一校验和应用。

import type { ConditionChange, ConditionOption } from './conditions.ts';

export const DEMO_NOTICE = '固定话术演示：只识别下列表达，未接入 LLM，回复不是 AI 生成的。';

export const INSPIRATION_EXAMPLE = '300 元以内的地铁通勤耳机';

const COMMUTE_ANC_SUGGESTION: ConditionChange = {
  op: 'suggest', field: 'anc', kind: 'hard', value: true, reason: '地铁环境噪音较大，通勤场景通常会考虑主动降噪',
};

const BUDGET_300_OPTIONS: ConditionOption[] = [
  { label: '300 元以内（上限）', kind: 'hard', value: 300 },
  { label: '300 元左右（参考）', kind: 'soft', value: 300 },
];

const RULES: { text: string; changes: ConditionChange[] }[] = [
  {
    text: '300 元以内，地铁通勤，需要主动降噪',
    changes: [
      { op: 'set', field: 'budget', kind: 'hard', value: 300 },
      { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' },
      { op: 'set', field: 'anc', kind: 'hard', value: true },
    ],
  },
  { text: '预算降到 200 元，其他不变', changes: [{ op: 'update', field: 'budget', value: 200 }] },
  { text: '不要入耳式，其他不变', changes: [{ op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } }] },
  { text: '取消主动降噪要求', changes: [{ op: 'remove', field: 'anc' }] },
  { text: '预算改为 400 元', changes: [{ op: 'update', field: 'budget', value: 400 }] },
  { text: '预算改为 100 元', changes: [{ op: 'update', field: 'budget', value: 100 }] },
  {
    text: '地铁通勤用，300 以内',
    changes: [
      { op: 'set', field: 'budget', kind: 'hard', value: 300 },
      { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' },
      COMMUTE_ANC_SUGGESTION,
    ],
  },
  {
    // “猜你喜欢”卡片填入输入框的示例需求；用户确认发送后才生效
    text: INSPIRATION_EXAMPLE,
    changes: [
      { op: 'set', field: 'budget', kind: 'hard', value: 300 },
      { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' },
      COMMUTE_ANC_SUGGESTION,
    ],
  },
  {
    text: '我每天坐地铁通勤',
    changes: [{ op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' }, COMMUTE_ANC_SUGGESTION],
  },
  {
    text: '地铁通勤用，三百块钱',
    changes: [
      { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' },
      { op: 'ask', field: 'budget', question: '300 元是预算上限，还是大概的参考？', rawText: '三百块钱', options: BUDGET_300_OPTIONS },
      COMMUTE_ANC_SUGGESTION,
    ],
  },
  {
    text: '300 元左右，最好有降噪',
    changes: [
      { op: 'set', field: 'budget', kind: 'soft', value: 300 },
      { op: 'set', field: 'anc', kind: 'soft', value: true },
    ],
  },
];

const UNSUPPORTED: { text: string; category: string }[] = [{ text: '我想买沙发', category: '沙发' }];

export const DEMO_PHRASES: readonly string[] = [...RULES.map(r => r.text), ...UNSUPPORTED.map(u => u.text)];

export type DemoResult =
  | { type: 'changes'; changes: ConditionChange[] }
  | { type: 'unsupported-category'; category: string };

function normalize(text: string): string {
  return text.trim().replace(/[，,。！!？?\s]/g, '');
}

export function interpretDemo(text: string): DemoResult | null {
  const input = normalize(text);
  const rule = RULES.find(r => normalize(r.text) === input);
  if (rule) return { type: 'changes', changes: structuredClone(rule.changes) };
  const unsupported = UNSUPPORTED.find(u => normalize(u.text) === input);
  if (unsupported) return { type: 'unsupported-category', category: unsupported.category };
  return null;
}
