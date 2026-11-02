import { CATEGORIES, supportsField } from './categories.ts';
import type { ShoppingCategory } from './categories.ts';
// ShopMate 购买条件：数据结构与变更规则（PRD V0.8 第 6.2、7.3 节）。
//
// 每个条件有三个互相独立的维度：
//   kind   类别：hard 硬约束 / soft 软偏好 / scene 使用场景
//   status 状态：confirmed 已生效 / suggested 系统建议（未生效）/ pending 用户表达待澄清（未生效）
//   source 来源：user 用户 / page 商品列表筛选 / system 系统推导
//
// 只有 confirmed 的条件参与筛选。系统建议只能由用户在界面上执行 confirm 才生效，
// 解释器（现在是固定话术，第 3 阶段是 LLM）只能提出变更，不能替用户采纳建议。
//
// 这里只有纯函数和可 JSON 序列化的数据。第 2 阶段迁移到 FastAPI 时按同一结构实现，
// 两边都必须通过 contracts/condition-cases.json 中的用例。

export const SCHEMA_VERSION = 1 as const;
export const BUDGET_LIMIT = 100000;

export type ConditionField = 'budget' | 'anc' | 'wearingStyle' | 'scene';
export type ConditionKind = 'hard' | 'soft' | 'scene';
export type ConditionStatus = 'confirmed' | 'suggested' | 'pending';
export type ConditionSource = 'user' | 'page' | 'system';
export type WearingStyle = '入耳式' | '半入耳式' | '头戴式';

export const FIELDS: readonly ConditionField[] = ['budget', 'anc', 'wearingStyle', 'scene'];
export const WEARING_STYLES: readonly WearingStyle[] = ['入耳式', '半入耳式', '头戴式'];

// budget：人民币元；anc：是否支持主动降噪；wearingStyle：排除的佩戴方式；scene：使用场景
export type ConditionValue = number | boolean | { exclude: WearingStyle[] } | string;

export interface ActiveCondition {
  field: ConditionField;
  status: 'confirmed' | 'suggested';
  kind: ConditionKind;
  source: ConditionSource;
  value: ConditionValue;
  reason?: string;
}

export interface ConditionOption {
  label: string;
  kind: ConditionKind;
  value: ConditionValue;
}

export interface PendingCondition {
  field: ConditionField;
  status: 'pending';
  kind: null;
  source: 'user';
  question: string;
  rawText: string;
  options: ConditionOption[];
}

export type Condition = ActiveCondition | PendingCondition;

export interface ConditionState {
  schemaVersion: typeof SCHEMA_VERSION;
  category: ShoppingCategory;
  conditions: Condition[];
  dismissed: ConditionField[];
}

export type ConditionChange =
  | { op: 'set'; field: ConditionField; kind: ConditionKind; value: ConditionValue }
  | { op: 'update'; field: ConditionField; value: ConditionValue }
  | { op: 'remove'; field: ConditionField }
  | { op: 'suggest'; field: ConditionField; kind: ConditionKind; value: ConditionValue; reason: string }
  | { op: 'ask'; field: ConditionField; question: string; rawText: string; options: ConditionOption[] }
  | { op: 'confirm'; field: ConditionField; kind?: ConditionKind }
  | { op: 'dismiss'; field: ConditionField }
  | { op: 'resolve'; field: ConditionField; option: number };

export type ChangeOp = ConditionChange['op'];

// interpreter：解析用户文字（固定话术 / LLM）；ui：用户在界面上的点击；
// page：商品列表筛选；system：系统推导（例如“找相似款”）。
export type ChangeOrigin = 'interpreter' | 'ui' | 'page' | 'system';

export const ALLOWED_OPS: Readonly<Record<ChangeOrigin, readonly ChangeOp[]>> = {
  interpreter: ['set', 'update', 'remove', 'suggest', 'ask'],
  ui: ['set', 'update', 'remove', 'confirm', 'dismiss', 'resolve'],
  page: ['set'],
  system: ['suggest'],
};

// 后端拒绝一项操作时的说明（src/conditions.py）。code：invalid 调用方式不对 / rule 业务规则不允许；旧接口没有 code，按 rule 处理
export interface Rejection {
  change: ConditionChange;
  reason: string;
  code?: 'invalid' | 'rule';
}

export interface ApplyResult {
  state: ConditionState;
  applied: ConditionChange[];
  rejected: Rejection[];
}

export const KIND_LABEL: Record<ConditionKind, string> = { hard: '必须满足', soft: '偏好', scene: '使用场景' };
export const STATUS_LABEL: Record<ConditionStatus, string> = {
  confirmed: '已生效',
  suggested: '系统建议 · 未生效',
  pending: '待你确认 · 未生效',
};
export const SOURCE_LABEL: Record<ConditionSource, string> = { user: '你设置的', page: '来自商品列表', system: '系统建议' };
const ORIGIN_LABEL: Record<ChangeOrigin, string> = { interpreter: '文字解析', ui: '界面操作', page: '商品列表', system: '系统推导' };

export function emptyState(category: ShoppingCategory = 'headphones'): ConditionState {
  return { schemaVersion: SCHEMA_VERSION, category, conditions: [], dismissed: [] };
}

export function getCondition(state: ConditionState, field: ConditionField): Condition | undefined {
  return state.conditions.find(c => c.field === field);
}

// 已生效或系统建议的值；待确认项还没有值。
export function activeValue(state: ConditionState, field: ConditionField): ConditionValue | undefined {
  const condition = getCondition(state, field);
  return condition && condition.status !== 'pending' ? condition.value : undefined;
}

export function confirmedConditions(state: ConditionState): ActiveCondition[] {
  return state.conditions.filter((c): c is ActiveCondition => c.status === 'confirmed');
}

export function isKindAllowed(field: ConditionField, kind: unknown): boolean {
  return field === 'scene' ? kind === 'scene' : kind === 'hard' || kind === 'soft';
}

export function valueError(field: ConditionField, value: unknown): string | null {
  switch (field) {
    case 'budget':
      return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= BUDGET_LIMIT
        ? null
        : `预算需大于 0 且不超过 ${BUDGET_LIMIT} 元`;
    case 'anc':
      return typeof value === 'boolean' ? null : '主动降噪条件只能是“要”或“不要”';
    case 'wearingStyle': {
      if (typeof value !== 'object' || value === null || !Array.isArray((value as { exclude?: unknown }).exclude)) {
        return '佩戴方式条件格式不正确';
      }
      const exclude = (value as { exclude: unknown[] }).exclude;
      if (exclude.some(s => !WEARING_STYLES.includes(s as WearingStyle)) || new Set(exclude).size !== exclude.length) {
        return '佩戴方式不在支持范围内';
      }
      if (exclude.length === 0 || exclude.length >= WEARING_STYLES.length) return '至少排除一种佩戴方式，且不能全部排除';
      return null;
    }
    case 'scene':
      return typeof value === 'string' && value.trim().length > 0 && value.length <= 30 ? null : '使用场景需为 1–30 个字';
    default:
      return '不支持的条件字段';
  }
}

// Python is the only production transition executor.
export async function applyChanges(state: ConditionState, changes: ConditionChange[], origin: ChangeOrigin): Promise<ApplyResult> {
  const { api } = await import('./api.ts');
  return api<ApplyResult>('/conditions/apply', { state, changes, origin });
}

// 检查状态是否满足全部不变量；返回空数组表示合法。后端用 Pydantic 校验同样的规则。
export function validateState(state: ConditionState): string[] {
  const errors: string[] = [];
  if (state.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion 不匹配');
  if (state.category !== null && !CATEGORIES[state.category]?.enabled) errors.push('当前品类尚未开放');
  const seen = new Set<ConditionField>();
  for (const c of state.conditions) {
    if (!FIELDS.includes(c.field)) {
      errors.push(`未知字段 ${String(c.field)}`);
      continue;
    }
    if (!supportsField(state.category, c.field)) errors.push(`${c.field} 不适用于当前品类`);
    if (seen.has(c.field)) errors.push(`${c.field} 出现了多个条件`);
    seen.add(c.field);
    if (c.status === 'pending') {
      // 数据可能来自后端或 JSON，运行时再检查一次类型上已约束的字段
      const loose = c as unknown as { kind: unknown; source: unknown };
      if (loose.kind !== null) errors.push(`${c.field} 待确认项不能预先归类`);
      if (loose.source !== 'user') errors.push(`${c.field} 待确认项只能来自用户表达`);
      if (!Array.isArray(c.options) || c.options.length < 2) errors.push(`${c.field} 待确认项至少需要两个选项`);
      else for (const o of c.options) {
        if (!isKindAllowed(c.field, o.kind) || valueError(c.field, o.value)) errors.push(`${c.field} 待确认项的选项不合法`);
      }
    } else if (c.status === 'confirmed' || c.status === 'suggested') {
      if (!isKindAllowed(c.field, c.kind)) errors.push(`${c.field} 类别不合法`);
      const error = valueError(c.field, c.value);
      if (error) errors.push(`${c.field}：${error}`);
      if (!['user', 'page', 'system'].includes(c.source)) errors.push(`${c.field} 来源不合法`);
      if (c.status === 'suggested' && c.source !== 'system') errors.push(`${c.field} 建议只能来自系统`);
      if (c.status === 'suggested' && !c.reason?.trim()) errors.push(`${c.field} 建议缺少理由`);
    } else {
      errors.push(`${String((c as Condition).field)} 状态不合法`);
    }
  }
  if (new Set(state.dismissed).size !== state.dismissed.length || state.dismissed.some(f => !FIELDS.includes(f))) {
    errors.push('dismissed 列表不合法');
  }
  return errors;
}

export function formatYuan(amount: number): string {
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

export function describeValue(field: ConditionField, kind: ConditionKind, value: ConditionValue): string {
  switch (field) {
    case 'budget':
      return kind === 'hard' ? `预算 ≤ ${formatYuan(value as number)}` : `预算 ${formatYuan(value as number)} 左右`;
    case 'anc':
      if (kind === 'hard') return value ? '必须支持主动降噪' : '不要主动降噪';
      return value ? '最好有主动降噪' : '最好不带主动降噪';
    case 'wearingStyle': {
      const styles = (value as { exclude: WearingStyle[] }).exclude.join('、');
      return kind === 'hard' ? `排除${styles}` : `尽量避开${styles}`;
    }
    case 'scene':
      return `场景：${value as string}`;
  }
}

// 被拒绝的一项说的是什么，用来告诉用户哪项没有处理；认不出时返回 null
function rejectedItem(change: ConditionChange): string | null {
  const value = (change as { value?: unknown }).value;
  if (change.field === 'scene' && typeof value === 'string' && value.trim()) return value.trim();
  if (change.field === 'budget' && typeof value === 'number' && Number.isFinite(value)) return `预算 ${formatYuan(value)}`;
  if (change.field === 'anc' && typeof value === 'boolean') return value ? '主动降噪' : '不要主动降噪';
  const exclude = (value as { exclude?: unknown } | null)?.exclude;
  if (change.field === 'wearingStyle' && Array.isArray(exclude) && exclude.length && exclude.every(x => typeof x === 'string')) return `排除${exclude.join('、')}`;
  return null;
}

const RECORD_OPS = new Set<ChangeOp>(['set', 'update']);

// 没有处理的要求，用普通用户能懂的话说明；技术原因只留在接口响应和服务端日志里。
// invalid（调用方式不对）：本轮已用同样的值改正记下的不再提；没改正的只说哪项没记下，不展示技术原因。
// rule（业务规则不允许）：原因本身是写给用户看的，照常说明。
// fromChat：聊天回复里，建议和待确认问题是助手自己发起的，被拒绝时用户不需要知道；界面操作（如找相似款）照常说明。
export function rejectionNotes(applied: readonly ConditionChange[], rejected: readonly Rejection[], fromChat = false): string[] {
  const valueOf = (c: ConditionChange) => JSON.stringify((c as { value?: unknown }).value);
  const notes = rejected
    .filter(r => !fromChat || (r.change.op !== 'suggest' && r.change.op !== 'ask'))
    .filter(r => r.code !== 'invalid' || !applied.some(a => a.field === r.change.field && valueOf(a) === valueOf(r.change)))
    .map(r => {
      const item = rejectedItem(r.change);
      const recording = RECORD_OPS.has(r.change.op);
      if (r.change.op === 'suggest') return `建议${item ? `「${item}」` : ''}没有加上${r.code === 'invalid' ? '' : `：${r.reason}`}。`;
      const what = item ? `「${item}」` : recording ? '有一项要求' : '有一项操作';
      const verb = recording ? '没有记下' : '没有执行';
      return r.code === 'invalid' ? `${what}${verb}。` : `${what}${verb}：${r.reason}。`;
    });
  return [...new Set(notes)];
}

export function describeCondition(condition: Condition): string {
  if (condition.status === 'pending') return condition.question;
  return describeValue(condition.field, condition.kind, condition.value);
}
