import { CATEGORIES } from './categories.ts';
import type { ShoppingCategory } from './categories.ts';
// 模拟购物会话：商品列表筛选、助手条件、对话与对比栏。
// 异步状态转换调用后端；界面负责派发动作、保存会话与渲染。
// 自由输入调用 Gemini；明确的 UI 操作调用 Python 条件服务。
//
// 三类状态分开保存：
// - viewedProductId：当前浏览的商品（跟随页面路由，首页和列表为 null）
// - assistant.state：用户确认过的购买条件（切换页面、切换商品都不清空）
// - Message.productRefs / recommendations：每条消息生成时关联的商品，之后不随页面变化

import type { ChangeOrigin, ConditionChange, ConditionField, ConditionState, Rejection } from './conditions.ts';
import {
  KIND_LABEL, applyChanges, confirmedConditions, describeCondition, describeValue, emptyState, getCondition, rejectionNotes,
} from './conditions.ts';
import { toggleCompare } from './compare.ts';
import { api } from './api.ts';
import type { PageFilters } from './page-sync.ts';
import { DEFAULT_PAGE_FILTERS, byPageFilters, describePageFilters, projectToPageFilters, samePageFilters, stateFromPageFilters } from './page-sync.ts';
import { catalog, getProduct } from './products.ts';
import { searchProducts } from './search.ts';

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
  // 发送时正在看的商品（随历史一起发给模型）
  viewedProductId?: string | null;
  // 请求失败的回复：不作为对话历史发给模型
  failed?: boolean;
  details?: string[];
  // 本轮没有处理的用户要求数量（聊天回复；说明在 details 里）
  unhandled?: number;
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
  // 这条用户消息的 id；只把它之前的对话作为历史
  messageId: number;
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
  | { type: 'chatResolved'; requestId: number; result: ChatResult }
  | { type: 'chatFailed'; requestId: number; message: string }
  | { type: 'retry' }
  | { type: 'toggleFailNext' }
  | { type: 'uiChanges'; changes: ConditionChange[]; label: string }
  | { type: 'findSimilar'; productId: string }
  | { type: 'applyToList' }
  | { type: 'reset' }
  | { type: 'toggleCompare'; productId: string }
  | { type: 'clearCompare' }
  | { type: 'dismissNotice' };

// POST /api/chat 的成功响应，字段与 src/agent_models.py 的 ChatResponse 一致
export interface ChatResult {
  reply: string;
  state: ConditionState;
  applied: ConditionChange[];
  rejected: Rejection[];
  recommendations: { productId: string; softMatched: ConditionField[] }[] | null;
  matchCount: number | null;
  productRefs: string[];
  compareIds: string[] | null;
  tools: { name: string; status: 'ok' | 'rejected'; message?: string }[];
}

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
  const message: Message = { id, role, text, demo: false, ...extra };
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
  lines.push(...rejectionNotes(result.applied, result.rejected));
  return lines;
}

// 推荐卡片上的理由：满足的必须条件和命中的偏好，最多两条
function recommendationReasons(active: ReturnType<typeof confirmedConditions>, softMatched: readonly string[]): string[] {
  return active
    .filter(c => c.kind === 'hard' || softMatched.includes(c.field))
    .map(c => `${c.kind === 'soft' ? '偏好：' : ''}${describeCondition(c)}`)
    .slice(0, 2);
}

// 条件变更详情（界面上折叠显示）
function changeDetails(result: { applied: ConditionChange[]; rejected: Rejection[] }, before: ConditionState, after: ConditionState, fromChat = false): string[] {
  const details = result.applied.map(change => describeApplied(change, before, after));
  const untouched = confirmedConditions(before).filter(c => !result.applied.some(change => change.field === c.field));
  if (result.applied.length && untouched.length) details.push('其他条件保持不变。');
  details.push(...rejectionNotes(result.applied, result.rejected, fromChat));
  return details;
}

async function applyAndReport(s: ShopSession, changes: ConditionChange[], origin: ChangeOrigin): Promise<ShopSession> {
  const before = s.assistant.state;
  const result = await applyChanges(before, changes, origin);
  const after = result.state;
  const details = changeDetails(result, before, after);

  const lines = conversationalText(result, before);
  const extra: Partial<Message> = { details };
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
        productId: product.id, reasons: recommendationReasons(active, evaluation.softMatched),
      }));
      lines.push(matches.length
        ? '按现在的条件，先看看这几款：'
        : '按现在的条件暂时没有合适的款式。我不会自动放宽条件，可以试着调整预算或要求。');
    }
  }
  if (!lines.length) lines.push('条件没有变化。');
  return say(withAssistant(s, { state: after, status: 'idle' }), 'assistant', lines.join('\n'), extra);
}

// 推荐快照是否仍是“当前有效推荐”：必须是最后一轮推荐，且与按当前条件重新筛选的结果一致
// （符合数量相同，展示的商品都仍然符合；助手可能只挑其中几款展示）。条件或品类变化后，旧快照只作为历史保留。
export function isSnapshotCurrent(message: Message, assistant: AssistantSession, matches: import('./search.ts').Match[]): boolean {
  if (!message.recommendations) return false;
  const latest = [...assistant.messages].reverse().find(m => m.recommendations !== undefined);
  if (latest?.id !== message.id || assistant.state.category === null) return false;
  const ids = new Set(matches.map(m => m.product.id));
  return matches.length === message.matchCount && message.recommendations.every(r => ids.has(r.productId));
}

// 切换选购品类只保留通用预算；场景、专属条件、建议及对比项不跨品类带入。
function selectCategory(s: ShopSession, category: ShoppingCategory): ShopSession {
  if (category && !CATEGORIES[category].enabled) return s;
  if (s.assistant.state.category === category) return s;
  const state = { ...emptyState(category), conditions: s.assistant.state.conditions.filter(c => c.field === 'budget') };
  return { ...withAssistant(s, { state, pendingRequest: null, status: 'idle' }), compareIds: [], notice: null };
}

// 发给模型的历史：这条消息之前的对话，去掉失败的轮次（失败回复和对应的提问）。
// 每条带上当时关联的商品和正在看的商品，之后切换页面不会改变。
function chatHistory(messages: Message[], before: number) {
  const history: Message[] = [];
  for (const m of messages) {
    if (m.id >= before) break;
    if (m.failed) {
      if (history.at(-1)?.role === 'user') history.pop();
      continue;
    }
    history.push(m);
  }
  return history.slice(-30).map(m => ({
    role: m.role, text: m.text, viewedProductId: m.viewedProductId ?? null,
    productRefs: [...new Set([...(m.productRefs ?? []), ...(m.recommendations ?? []).map(r => r.productId)])],
  }));
}

// 发送聊天请求，返回要应用的结果动作（成功或失败）。条件和上下文都用发送时的快照。
export async function requestChat(s: ShopSession, pending: PendingRequest): Promise<ShopAction> {
  if (pending.fail) return { type: 'chatFailed', requestId: pending.id, message: '这次模拟请求失败了。你的条件没有改变，可以点击“重试”。' };
  try {
    const result = await api<ChatResult>('/chat', {
      message: pending.text, state: s.assistant.state, viewedProductId: pending.context.viewedProductId,
      history: chatHistory(s.assistant.messages, pending.messageId),
    });
    return { type: 'chatResolved', requestId: pending.id, result };
  } catch (error) {
    return { type: 'chatFailed', requestId: pending.id, message: error instanceof Error ? error.message : '聊天请求失败，条件未改变，请重试。' };
  }
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
        status: 'loading', pendingRequest: { id, messageId: started.msgSeq + 1, text, fail: started.assistant.failNext, context }, lastFailedText: null, failNext: false,
      });
      return say(next, 'user', text, { viewedProductId: context.viewedProductId });
    }

    // 单独调用 reduce 时直接等待请求；界面里由 session-controller 在队列外请求，再把结果应用到最新状态
    case 'textResolved': {
      const pending = s.assistant.pendingRequest;
      if (!pending || pending.id !== action.requestId) return s;
      return reduce(s, await requestChat(s, pending));
    }

    // 只应用仍在等待的请求；被新的条件操作作废后，迟到的结果不会覆盖新条件
    case 'chatResolved': {
      const pending = s.assistant.pendingRequest;
      if (!pending || pending.id !== action.requestId) return s;
      const { result } = action;
      const before = s.assistant.state;
      const details = changeDetails(result, before, result.state, true);
      if (result.matchCount !== null) details.push(`按已生效的条件，商品库中有 ${result.matchCount} 款符合。`);
      const active = confirmedConditions(result.state).filter(c => c.kind !== 'scene');
      let next = withAssistant(s, { state: result.state, pendingRequest: null, status: 'idle' });
      // 比较两款时放进对比栏，助手面板里显示结构化比较表
      if (result.compareIds) next = { ...next, compareIds: result.compareIds, notice: null };
      const unhandled = rejectionNotes(result.applied, result.rejected, true).length;
      return say(next, 'assistant', result.reply, {
        viewedProductId: pending.context.viewedProductId, productRefs: result.productRefs, details,
        ...(unhandled ? { unhandled } : {}),
        ...(result.recommendations === null ? {} : {
          matchCount: result.matchCount ?? 0,
          recommendations: result.recommendations.map(r => ({ productId: r.productId, reasons: recommendationReasons(active, r.softMatched) })),
        }),
      });
    }

    case 'chatFailed': {
      const pending = s.assistant.pendingRequest;
      if (!pending || pending.id !== action.requestId) return s;
      return say(withAssistant(s, { pendingRequest: null, status: 'error', lastFailedText: pending.text }), 'assistant', action.message,
        { viewedProductId: pending.context.viewedProductId, failed: true });
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

    // 场景 B：用户点“应用到商城筛选”后才写回商城（手动确认同步）。没有可写回的条件、或商城已经一致时不做任何事。
    // 先按这组条件实际筛选一次商城商品：请求失败会抛出，商城筛选不变，也不提示成功（界面显示可重试的错误）。
    // 场景、偏好和建议留在助手里，照常显示在条件栏中，不逐条解释为什么没有写回商城。
    case 'applyToList': {
      if (s.assistant.state.category !== 'headphones') return s;
      const { filters } = projectToPageFilters(s.assistant.state);
      if (!describePageFilters(filters).length || samePageFilters(filters, s.pageFilters)) return s;
      await searchProducts(catalog(), await stateFromPageFilters(filters));
      return say({ ...s, pageFilters: filters }, 'assistant', `商城已${byPageFilters(filters)}筛选商品。`);
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
