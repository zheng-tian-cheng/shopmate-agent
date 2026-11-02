import { CATEGORIES } from '../../lib/categories.ts';
import type { ShoppingCategory } from '../../lib/categories.ts';
// 模拟购物会话：商品列表筛选、助手条件、对话与对比栏。
// 用纯函数 reducer 表达全部交互，界面组件只负责派发动作和渲染，便于自动化测试整条模拟流程。
// 第 1 阶段：文字输入经固定话术解释（非 LLM），等待时间是模拟的；助手回复是模板文字，标记为 demo。
//
// 三类状态分开保存：
// - viewedProductId：当前浏览的商品（跟随页面路由，首页和列表为 null）
// - assistant.state：用户确认过的购买条件（切换页面、切换商品都不清空）
// - Message.productRefs / recommendations：每条消息生成时关联的商品，之后不随页面变化

import type { ChangeOrigin, ConditionChange, ConditionState } from './conditions.ts';
import {
  KIND_LABEL, applyChanges, confirmedConditions, describeCondition, describeValue, emptyState, getCondition,
} from './conditions.ts';
import { toggleCompare } from '../../lib/compare.ts';
import { interpretDemo } from '../../lib/demo-phrases.ts';
import type { PageFilters } from './page-sync.ts';
import { DEFAULT_PAGE_FILTERS, describePageFilters, projectToPageFilters, stateFromPageFilters } from './page-sync.ts';
import { answerProductQuestion } from '../../lib/product-context.ts';
import { catalog, getProduct } from '../../lib/products.ts';
import { searchProducts } from './search.ts';

export const MOCK_LATENCY_MS = 600;

export type Entry = 'home' | 'list' | 'detail';

export const RECOMMEND_LIMIT = 3;

// 某一轮回复时的推荐快照：之后条件再变，这一轮展示过的商品和理由仍保留在聊天记录里。
export interface Recommendation {
  productId: string;
  reasons: string[];
}

export interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  demo: boolean;
  // 测试替身专用：本轮实际执行和拒绝的变更，供 mock-api 按 /api/chat 的格式返回
  applied?: ConditionChange[];
  rejected?: { change: ConditionChange; reason: string }[];
  details?: string[];
  recommendations?: Recommendation[];
  matchCount?: number;
  // 这条消息讨论的商品，生成时确定，之后切换页面也不改变
  productRefs?: string[];
}

// 每次请求带给助手的上下文快照（第 2 阶段由前端发给后端）。发送时确定，等待期间切换页面不影响这次回答。
export interface RequestContext {
  viewedProductId: string | null;
  category: ShoppingCategory;
  confirmedConditions: ReturnType<typeof confirmedConditions>;
}

export interface PendingRequest {
  id: number;
  text: string;
  fail: boolean;
  context: RequestContext;
}

export interface AssistantSession {
  open: boolean;
  started: boolean;
  entry: Entry | null;
  state: ConditionState;
  messages: Message[];
  status: 'idle' | 'loading' | 'error';
  pendingRequest: PendingRequest | null;
  lastFailedText: string | null;
  failNext: boolean;
}

export interface ShopSession {
  pageFilters: PageFilters;
  // 当前浏览的商品：由页面路由决定，不由助手决定
  viewedProductId: string | null;
  assistant: AssistantSession;
  compareIds: string[];
  seq: number;
  msgSeq: number;
  notice: string | null;
}

export type ShopAction =
  | { type: 'setPageFilters'; filters: PageFilters }
  | { type: 'viewPage'; productId: string | null }
  | { type: 'openAssistant'; entry: Entry; productId?: string | null }
  | { type: 'closeAssistant' }
  | { type: 'selectCategory'; category: ShoppingCategory }
  | { type: 'sendText'; text: string }
  | { type: 'textResolved'; requestId: number }
  | { type: 'retry' }
  | { type: 'toggleFailNext' }
  | { type: 'uiChanges'; changes: ConditionChange[]; label: string }
  | { type: 'findSimilar'; productId: string }
  | { type: 'applyToList' }
  | { type: 'reset' }
  | { type: 'toggleCompare'; productId: string }
  | { type: 'clearCompare' }
  | { type: 'dismissNotice' };

function initialAssistant(): AssistantSession {
  return {
    open: false, started: false, entry: null, state: emptyState(null), messages: [],
    status: 'idle', pendingRequest: null, lastFailedText: null, failNext: false,
  };
}

export function initialSession(): ShopSession {
  return { pageFilters: { ...DEFAULT_PAGE_FILTERS }, viewedProductId: null, assistant: initialAssistant(), compareIds: [], seq: 0, msgSeq: 0, notice: null };
}

export function buildRequestContext(s: ShopSession): RequestContext {
  return {
    viewedProductId: s.viewedProductId,
    category: s.assistant.state.category,
    confirmedConditions: confirmedConditions(s.assistant.state),
  };
}

function withAssistant(s: ShopSession, patch: Partial<AssistantSession>): ShopSession {
  return { ...s, assistant: { ...s.assistant, ...patch } };
}

function say(s: ShopSession, role: Message['role'], text: string, extra: Partial<Message> = {}): ShopSession {
  const id = s.msgSeq + 1;
  const message: Message = { ...extra, id, role, text, demo: role === 'assistant' };
  return { ...withAssistant(s, { messages: [...s.assistant.messages, message] }), msgSeq: id };
}

function openingText(s: ShopSession, entry: Entry, productId: string | null, state: ConditionState): string {
  if (entry === 'list') {
    const inherited = state.conditions.map(describeCondition);
    return inherited.length
      ? `已沿用商品列表的筛选条件：${inherited.join('、')}。你可以继续说出需求，或点击下方的快捷选项。`
      : '商品列表目前没有设置筛选条件。说说你的需求，或点击下方的快捷选项。';
  }
  const product = entry === 'detail' && productId ? getProduct(productId) : undefined;
  if (product) return `你正在查看「${product.name}」。可以找相似款、把它加入对比，或直接说说你的需求。`;
  return '嗨，我是 ShopMate。今天想买点什么？目前可以完整体验蓝牙耳机选购，其他品类还在准备中。';
}

// 第一次打开时按入口建立会话：从列表打开继承列表筛选（场景 A）。
// 已有会话时只重新显示，不用列表条件覆盖助手条件（场景 C 的 P0 行为）。
// 只有从详情页打开才带入商品；首页和列表入口不绑定任何商品。
async function open(s: ShopSession, entry: Entry, productId: string | null): Promise<ShopSession> {
  const viewed = entry === 'detail' ? productId ?? s.viewedProductId : null;
  s = { ...s, viewedProductId: viewed };
  if (s.assistant.started) {
    if (entry !== 'home' && s.assistant.state.category === null) s = selectCategory(s, 'headphones');
    return withAssistant(s, { open: true, entry });
  }
  const state = entry === 'list' ? await stateFromPageFilters(s.pageFilters) : emptyState(entry === 'home' ? null : 'headphones');
  const next = withAssistant(s, { open: true, started: true, entry, state });
  return say(next, 'assistant', openingText(s, entry, viewed, state), viewed ? { productRefs: [viewed] } : {});
}

// 还没开始对话时，按当前页面建立会话：在详情页就带入该商品，否则不绑定商品
async function ensureStarted(s: ShopSession): Promise<ShopSession> {
  if (s.assistant.started) return s;
  return s.viewedProductId ? open(s, 'detail', s.viewedProductId) : open(s, 'home', null);
}

// 新的界面操作会让还在等待的文字请求作废，迟到的结果不会覆盖新条件（规则七）。
function supersedePending(s: ShopSession): ShopSession {
  const next = { ...s, seq: s.seq + 1 };
  if (!s.assistant.pendingRequest) return next;
  return say(withAssistant(next, { pendingRequest: null, status: 'idle' }), 'assistant', '上一条文字输入在你修改条件后已作废，没有应用。');
}

function describeApplied(change: ConditionChange, before: ConditionState, after: ConditionState): string {
  const now = getCondition(after, change.field);
  const was = getCondition(before, change.field);
  const label = (c: typeof now) => (c ? describeCondition(c) : change.field);
  switch (change.op) {
    case 'set': return `已设置：${label(now)}（${KIND_LABEL[change.kind]}）。`;
    case 'update': return `已修改：${label(now)}。`;
    case 'remove': return `已取消：${label(was)}。`;
    case 'suggest': return `建议：${label(now)}（未生效，${change.reason}），需要你确认。`;
    case 'ask': return `需要你确认：${change.question}`;
    case 'confirm': return `已采纳建议：${label(now)}（${now && now.kind ? KIND_LABEL[now.kind] : ''}）。`;
    case 'dismiss': return `已忽略建议：${label(was)}。`;
    case 'resolve': return `已确认：${label(now)}。`;
  }
}

// 会改变筛选结果的操作。只新增建议、待确认项或使用场景时，推荐不变，不重复展示。
const RESULT_OPS = new Set<ConditionChange['op']>(['set', 'update', 'remove', 'confirm', 'resolve']);
const affectsResults = (change: ConditionChange) => RESULT_OPS.has(change.op) && change.field !== 'scene';

// 面向用户的简短回复。技术性的变更记录放进 details，界面上折叠显示。
function conversationalText(result: Awaited<ReturnType<typeof applyChanges>>, before: ConditionState): string[] {
  const after = result.state;
  const now = (change: ConditionChange) => {
    const c = getCondition(after, change.field);
    return c ? describeCondition(c) : '';
  };
  const was = (change: ConditionChange) => {
    const c = getCondition(before, change.field);
    return c ? describeCondition(c) : '';
  };
  const lines: string[] = [];
  const noted = result.applied.filter(c => c.op === 'set' || c.op === 'resolve').map(now);
  if (noted.length) lines.push(`记下了：${noted.join('、')}。`);
  for (const change of result.applied) {
    if (change.op === 'update') lines.push(`好的，改为${now(change)}。`);
    if (change.op === 'remove') lines.push(`已去掉「${was(change)}」。`);
    if (change.op === 'confirm') {
      const c = getCondition(after, change.field);
      lines.push(`好的，「${now(change)}」已作为${c?.kind === 'soft' ? '偏好' : '必须条件'}加入。`);
    }
    if (change.op === 'dismiss') lines.push(`好的，不加「${was(change)}」这条。`);
  }
  const untouched = confirmedConditions(before).filter(c => !result.applied.some(change => change.field === c.field));
  if (result.applied.some(affectsResults) && untouched.length) lines.push('其他条件不变。');
  for (const change of result.applied) {
    if (change.op === 'suggest') {
      lines.push(`${change.reason}，要不要把「${describeValue(change.field, change.kind, change.value)}」加进条件？在上方的建议里点一下就能确认。`);
    }
    if (change.op === 'ask') lines.push(`${change.question}在上方选一下就好。`);
  }
  if (result.rejected.length) lines.push(`有 ${result.rejected.length} 项没有执行：${result.rejected.map(r => r.reason).join('；')}。`);
  return lines;
}

async function applyAndReport(s: ShopSession, changes: ConditionChange[], origin: ChangeOrigin): Promise<ShopSession> {
  const before = s.assistant.state;
  const result = await applyChanges(before, changes, origin);
  const after = result.state;

  const details = result.applied.map(change => describeApplied(change, before, after));
  const untouched = confirmedConditions(before).filter(c => !result.applied.some(change => change.field === c.field));
  if (result.applied.length && untouched.length) details.push('其他条件保持不变。');
  for (const { reason } of result.rejected) details.push(`未执行：${reason}。`);

  const lines = conversationalText(result, before);
  const extra: Partial<Message> = { details, applied: result.applied, rejected: result.rejected };
  const active = confirmedConditions(after).filter(c => c.kind !== 'scene');
  if (after.category === null) {
    lines.push('先选一个品类，再一起挑商品。目前可体验蓝牙耳机。');
  } else if (result.applied.some(affectsResults)) {
    if (!active.length) {
      lines.push('现在没有用来筛选的条件了，说说预算或必须的功能吧。');
    } else {
      const matches = await searchProducts(catalog(), after);
      details.push(`按已生效的条件，商品库中有 ${matches.length} 款符合。`);
      extra.matchCount = matches.length;
      extra.recommendations = matches.slice(0, RECOMMEND_LIMIT).map(({ product, evaluation }) => ({
        productId: product.id,
        reasons: active
          .filter(c => c.kind === 'hard' || evaluation.softMatched.includes(c.field))
          .map(c => `${c.kind === 'soft' ? '偏好：' : ''}${describeCondition(c)}`)
          .slice(0, 2),
      }));
      lines.push(matches.length
        ? '按现在的条件，先看看这几款：'
        : '按现在的条件暂时没有合适的款式。我不会自动放宽条件，可以试着调整预算或要求。');
    }
  }
  if (!lines.length) lines.push('条件没有变化。');
  return say(withAssistant(s, { state: after, status: 'idle' }), 'assistant', lines.join('\n'), extra);
}

// 推荐快照是否仍是“当前有效推荐”：必须是最后一轮推荐，且与按当前条件重新筛选的结果一致。
// 条件或品类变化后，旧快照只作为历史保留。
export function isSnapshotCurrent(message: Message, assistant: AssistantSession, matches: import('./search.ts').Match[]): boolean {
  if (!message.recommendations) return false;
  const latest = [...assistant.messages].reverse().find(m => m.recommendations !== undefined);
  if (latest?.id !== message.id || assistant.state.category === null) return false;
  return matches.length === message.matchCount
    && matches.slice(0, RECOMMEND_LIMIT).every((m, i) => m.product.id === message.recommendations![i]?.productId);
}

// 切换选购品类只保留通用预算；场景、专属条件、建议及对比项不跨品类带入。
function selectCategory(s: ShopSession, category: ShoppingCategory): ShopSession {
  if (category && !CATEGORIES[category].enabled) return s;
  if (s.assistant.state.category === category) return s;
  const state = { ...emptyState(category), conditions: s.assistant.state.conditions.filter(c => c.field === 'budget') };
  return { ...withAssistant(s, { state, pendingRequest: null, status: 'idle' }), compareIds: [], notice: null };
}

export async function reduce(s: ShopSession, action: ShopAction): Promise<ShopSession> {
  switch (action.type) {
    case 'setPageFilters':
      return { ...s, pageFilters: { ...action.filters } };

    // 页面切换：只更新当前浏览商品，不动对话、条件和历史消息的商品关联
    case 'viewPage':
      return s.viewedProductId === action.productId ? s : { ...s, viewedProductId: action.productId };

    case 'openAssistant':
      return open(s, action.entry, action.productId ?? null);

    case 'selectCategory': {
      const next = selectCategory(s, action.category);
      if (next === s || !action.category) return next;
      const budget = getCondition(next.assistant.state, 'budget');
      const kept = budget ? `已保留你的预算：${describeCondition(budget)}。` : '';
      return say(next, 'assistant', `好的，我们来挑${CATEGORIES[action.category].label}。${kept}说说使用场景和必须的功能，或点下方的快捷选项。`);
    }

    case 'closeAssistant':
      return withAssistant(s, { open: false });

    case 'sendText': {
      const text = action.text.trim();
      if (!text || s.assistant.pendingRequest) return s;
      const started = await ensureStarted(s);
      const id = started.seq + 1;
      const context = buildRequestContext(started);
      const next = withAssistant({ ...started, seq: id }, {
        status: 'loading', pendingRequest: { id, text, fail: started.assistant.failNext, context }, lastFailedText: null, failNext: false,
      });
      return say(next, 'user', text);
    }

    case 'textResolved': {
      const pending = s.assistant.pendingRequest;
      if (!pending || pending.id !== action.requestId) return s;
      let next = withAssistant(s, { pendingRequest: null, status: 'idle' });
      if (pending.fail) {
        return say(withAssistant(next, { status: 'error', lastFailedText: pending.text }), 'assistant',
          '这次模拟请求失败了。你的条件没有改变，可以点击“重试”。');
      }
      const result = interpretDemo(pending.text);
      if (!result) {
        // 关于某款商品参数的提问：按发送时的浏览商品理解“它”，用户明确提到的型号优先
        const answer = answerProductQuestion(pending.text, pending.context.viewedProductId, catalog());
        if (answer) return say(next, 'assistant', answer.text, { productRefs: answer.productRefs, details: answer.details });
        return say(next, 'assistant', '这句话不在固定话术范围内，条件没有改变。当前原型尚未接入 LLM，像“400 以内”这样的自由说法要等接入后才能理解。现在可以点下方的快捷选项，或在右上角「···」里选一句可识别的表达。');
      }
      if (result.type === 'unsupported-category') {
        return say(next, 'assistant', `当前只支持蓝牙耳机，${result.category}属于后续品类。耳机的条件不会用于其他品类，也没有改变。`);
      }
      if (next.assistant.state.category === null && result.changes.some(c => c.field === 'anc' || c.field === 'wearingStyle')) next = selectCategory(next, 'headphones');
      return applyAndReport(next, result.changes, 'interpreter');
    }

    case 'retry':
      if (!s.assistant.lastFailedText || s.assistant.pendingRequest) return s;
      return reduce(withAssistant(s, { failNext: false }), { type: 'sendText', text: s.assistant.lastFailedText });

    case 'toggleFailNext':
      return withAssistant(s, { failNext: !s.assistant.failNext });

    case 'uiChanges': {
      const started = await ensureStarted(s);
      return applyAndReport(say(supersedePending(started), 'user', action.label), action.changes, 'ui');
    }

    case 'findSimilar': {
      const product = getProduct(action.productId);
      if (!product) return s;
      const opened = await open(s, 'detail', product.id);
      const changes: ConditionChange[] = [];
      if (product.price.amount !== null) {
        changes.push({ op: 'suggest', field: 'budget', kind: 'soft', value: product.price.amount, reason: `与「${product.name}」价格接近` });
      }
      if (product.anc === true) {
        changes.push({ op: 'suggest', field: 'anc', kind: 'hard', value: true, reason: `「${product.name}」支持主动降噪` });
      }
      return applyAndReport(say(supersedePending(opened), 'user', `找和「${product.name}」相似的款式`, { productRefs: [product.id] }), changes, 'system');
    }

    case 'applyToList': {
      if (s.assistant.state.category !== 'headphones') return s;
      const { filters, unmapped } = projectToPageFilters(s.assistant.state);
      const applied = describePageFilters(filters);
      const lines = [`已同步到商品列表：${applied.length ? applied.join('、') : '无筛选条件（列表显示全部商品）'}。`];
      if (unmapped.length) lines.push(`以下条件无法应用到列表筛选，我会继续在这里帮你考虑：${unmapped.map(describeCondition).join('、')}。`);
      return say({ ...s, pageFilters: filters }, 'assistant', lines.join('\n'));
    }

    case 'reset': {
      const { entry, open: isOpen } = s.assistant;
      const cleared: ShopSession = { ...s, seq: s.seq + 1, assistant: initialAssistant() };
      const noted = say(cleared, 'assistant', '已开始新的选购：助手的条件和对话已清空，商品列表的筛选没有改变。');
      return withAssistant(await open(noted, entry ?? 'home', s.viewedProductId), { open: isOpen });
    }

    case 'toggleCompare': {
      const result = toggleCompare(s.compareIds, action.productId);
      return { ...s, compareIds: result.ids, notice: result.error };
    }

    case 'clearCompare':
      return { ...s, compareIds: [], notice: null };

    case 'dismissNotice':
      return { ...s, notice: null };
  }
}
