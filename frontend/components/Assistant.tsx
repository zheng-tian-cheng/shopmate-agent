'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CATEGORIES } from '../lib/categories';
import { AssistantStart, CategoryPicker } from './AssistantStart';
import { MAX_COMPARE } from '../lib/compare';
import { DEMO_PHRASES } from '../lib/demo-phrases';
import { byPageFilters, describePageFilters, projectToPageFilters, samePageFilters } from '../lib/page-sync';
import { getProduct } from '../lib/products';
import { quickOptions } from '../lib/quick-options';
import { entryFromPath } from '../lib/routes';
import type { Message } from '../lib/session';
import { isSnapshotCurrent } from '../lib/session';
import { useChatScroll, useVisibleViewport } from '../lib/use-chat-scroll';
import { CompareTable } from './Compare';
import { ConditionPanel } from './ConditionPanel';
import { Price } from './ProductCard';
import { useShop } from './ShopProvider';
import { BrandMark, ProductArt } from './Visuals';

export function AssistantLauncher() {
  const { session, dispatch } = useShop();
  const pathname = usePathname();
  if (session.assistant.open) return null;
  return <button type="button" className="launcher" onClick={() => dispatch({ type: 'openAssistant', ...entryFromPath(pathname) })}><BrandMark small />问问 ShopMate<span aria-hidden="true">↗</span></button>;
}

// 某一轮回复附带的推荐快照（紧凑横排）。快照里的商品和理由是当时的结果；
// 条件或品类变化后，旧快照标为“之前的推荐”，不再当作当前有效推荐；按当前条件已不符合的商品单独标出。
function RecommendationList({ message }: { message: Message }) {
  const { session, dispatch, docked, matches, evaluations } = useShop();
  const recommendations = message.recommendations ?? [];
  if (!recommendations.length) return null;
  const total = message.matchCount ?? recommendations.length;
  const current = isSnapshotCurrent(message, session.assistant, matches);
  return <div className={`rec-list ${current ? 'current' : 'old'}`} data-match-count={total} data-current={current}>
    <p className="rec-head">{current
      ? `当前推荐 · 符合条件的 ${total} 款${total > recommendations.length ? `，先看 ${recommendations.length} 款` : ''} · 图片为演示示意`
      : `之前的推荐 · 条件已更新，仅供回看（当时符合的 ${total} 款）`}</p>
    {recommendations.map(({ productId, reasons }) => {
      const product = getProduct(productId);
      if (!product) return null;
      const evaluation = evaluations[productId];
      const selected = session.compareIds.includes(productId);
      // 手机和平板上切换到商品页；桌面分屏时助手保持打开，方便对照
      const close = () => { if (!docked) dispatch({ type: 'closeAssistant' }); };
      return <article key={productId} className="rec-item">
        <Link href={`/headphones/${productId}`} className="rec-thumb" onClick={close} aria-label={`查看 ${product.name} 详情`}><ProductArt product={product} /></Link>
        <div className="rec-info">
          <h3><Link href={`/headphones/${productId}`} onClick={close}>{product.name}</Link></h3>
          <Price product={product} />
          <p className="rec-spec">{product.subtitle}</p>
          {reasons.length > 0 && <p className="rec-reasons">{reasons.map(r => `✓ ${r}`).join('　')}</p>}
          {evaluation && !evaluation.eligible
            ? <p className="rec-stale">不符合当前条件</p>
            : evaluation?.notes[0] && <p className="essential-note">{evaluation.notes[0]}</p>}
        </div>
        <button type="button" className={`rec-compare ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={() => dispatch({ type: 'toggleCompare', productId })}>{selected ? '✓ 已选' : '＋ 比较'}</button>
      </article>;
    })}
  </div>;
}

// 消息生成时关联的商品（固定不变）。点击进入同一个商品详情页。
function MessageRefs({ message }: { message: Message }) {
  const { dispatch, docked } = useShop();
  const refs = (message.productRefs ?? []).map(getProduct).filter(p => p !== undefined);
  if (!refs.length || message.recommendations) return null;
  return <p className="message-refs" data-refs={refs.map(p => p.id).join(' ')}>关于 {refs.map((p, i) => <span key={p.id}>{i > 0 && '、'}<Link href={`/headphones/${p.id}`} onClick={() => { if (!docked) dispatch({ type: 'closeAssistant' }); }}>{p.name}</Link></span>)}</p>;
}

// 回答引用的官网资料，编号与正文里的 [S…] 对应；可打开原网页核对
function MessageEvidence({ message }: { message: Message }) {
  if (!message.evidence?.length) return null;
  return <details className="change-log evidence-log"><summary>依据来源 · {message.evidence.length} 条官网资料</summary><ul>{message.evidence.map(e => <li key={e.ref}>[{e.ref}] {getProduct(e.productId)?.name ?? e.productId} · {e.source} · {e.region}{e.url && <> · <a href={e.url} target="_blank" rel="noreferrer">原网页 ↗</a></>}</li>)}</ul></details>;
}

export function AssistantPanel() {
  const { session, dispatch, docked } = useShop();
  const { open, messages, status, state, failNext } = session.assistant;
  const viewed = session.viewedProductId ? getProduct(session.viewedProductId) : undefined;
  const [input, setInput] = useState('');
  const [debug, setDebug] = useState(false);
  const [choosingCategory, setChoosingCategory] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const categoryScroll = useRef(0);
  const loading = status === 'loading';
  const engaged = messages.some(m => m.role === 'user');
  const options = quickOptions(state);
  const hasRecommendations = messages.some(m => m.recommendations !== undefined);
  // 助手里能写回商城的条件（已生效的预算、降噪、佩戴要求）与商城当前筛选不同时，才需要“应用到商城筛选”
  const mallFilters = projectToPageFilters(state).filters;
  const canApply = state.category === 'headphones' && describePageFilters(mallFilters).length > 0 && !samePageFilters(mallFilters, session.pageFilters);
  const home = !engaged && state.category === null;
  const { readingHistory, scrollProps, followLatest } = useChatScroll({ body: bodyRef, log: logRef, header: contextRef }, open && !home && !debug && !choosingCategory);
  useVisibleViewport(panelRef, open && !docked);

  // 输入框随内容增高，到 CSS max-height 后在框内滚动；光标在末尾时保持可见。只改输入框，不滚动聊天记录。
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    const top = field.scrollTop;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
    const atEnd = document.activeElement === field && field.selectionEnd === field.value.length;
    field.scrollTop = atEnd ? field.scrollHeight : top;
  }, [input, home, debug, choosingCategory]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    headingRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // 分屏时页面和助手并行使用：只在焦点位于助手内时响应 Esc，也不把焦点限制在面板里
      const inside = panelRef.current?.contains(document.activeElement) ?? false;
      if (e.key === 'Escape' && (!docked || inside)) { dispatch({ type: 'closeAssistant' }); return; }
      if (e.key !== 'Tab' || docked) return;
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, summary, [tabindex="0"]') ?? []).filter(el => el.getClientRects().length && !el.matches(':disabled'));
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); requestAnimationFrame(() => { const target = previous?.isConnected ? previous : document.querySelector<HTMLElement>('.launcher'); target?.focus({ preventScroll: true }); }); };
  }, [open, dispatch, docked]);
  // 对话页的阅读位置由 useChatScroll 恢复；这里只处理首页和品类选择之间的切换
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (choosingCategory) {
      body.scrollTop = 0;
    } else if (home) {
      body.scrollTop = categoryScroll.current;
    }
  }, [choosingCategory]);
  function browseCategories() {
    categoryScroll.current = bodyRef.current?.scrollTop ?? 0;
    setChoosingCategory(true);
  }
  // 用户主动发起的一轮（发送、快捷选项、重试）总是回到底部
  function send(text: string) { if (!text.trim() || loading) return; followLatest(); dispatch({ type: 'sendText', text }); setInput(''); }
  const composer = <form className="composer" onSubmit={e => { e.preventDefault(); send(input); }}><label className="sr-only" htmlFor="assistant-input">输入购物需求</label><textarea id="assistant-input" ref={inputRef} rows={1} maxLength={200} value={input} disabled={loading} placeholder={engaged ? '继续聊聊，或调整你的需求…' : '想买什么？说说你的需求…'} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); } }} /><button type="submit" className="send-button" aria-label="发送" disabled={!input.trim() || loading}>↑</button></form>;
  return <>
    {open && !docked && <div className="assistant-backdrop" onClick={() => dispatch({ type: 'closeAssistant' })} aria-hidden="true" />}
    <aside ref={panelRef} className={`assistant ${docked ? 'docked' : ''}`} role={docked ? 'complementary' : 'dialog'} aria-modal={docked ? undefined : true} aria-labelledby="assistant-title" hidden={!open}>
      <header className="assistant-head"><button type="button" className="assistant-back" aria-label="关闭 ShopMate，返回购物页面" onClick={() => dispatch({ type: 'closeAssistant' })}>‹ 返回商城</button><BrandMark small /><div className="title"><h2 id="assistant-title" ref={headingRef} tabIndex={-1}>ShopMate</h2><span>你的选购搭子 <span className="prototype-dot">· 开发原型</span></span></div><button className="more-button" aria-label={debug ? '返回对话' : '更多：开始新选购、原型调试'} aria-expanded={debug} onClick={() => { setChoosingCategory(false); setDebug(!debug); }}>{debug ? '完成' : '···'}</button></header>
      <div className="assistant-body" ref={bodyRef} {...scrollProps}>
        {choosingCategory ? <CategoryPicker onBack={() => setChoosingCategory(false)} onSelect={() => { dispatch({ type: 'selectCategory', category: 'headphones' }); setChoosingCategory(false); }} /> : debug ? <section className="debug-panel"><h2>选购</h2><button className="button outline" onClick={() => { dispatch({ type: 'reset' }); setDebug(false); setInput(''); }}>开始新选购</button><p>清空助手里的条件和对话，重新开始；不影响商品列表的筛选。</p><h2>原型调试</h2><p>Gemini 理解自然语言，商品筛选由后端规则执行；商品证据问答检索官网资料（RAG），尚未接入第三方评测。</p><label className="check"><input type="checkbox" checked={failNext} onChange={() => dispatch({ type: 'toggleFailNext' })} />下一条输入模拟失败</label><h3>试试这样问</h3><div className="phrase-list">{DEMO_PHRASES.map(p => <button key={p} disabled={loading} onClick={() => { send(p); setDebug(false); }}>{p} ↗</button>)}</div></section> : <>
          {home ? <AssistantStart composer={composer} onBrowse={browseCategories} onPick={example => {
            // 只填入输入框，不发送、不写入购买条件；用户可以修改后再确认发送
            setInput(example);
            requestAnimationFrame(() => {
              const field = document.getElementById('assistant-input') as HTMLTextAreaElement | null;
              field?.focus();
              field?.setSelectionRange(example.length, example.length);
            });
          }} /> : <>
            <div className="shopping-context" ref={contextRef} role="group" aria-label="当前选购品类"><span><small>正在选购</small>{state.category ? CATEGORIES[state.category].label : '未选品类'}</span>{viewed && <span className="viewing" data-viewed={viewed.id}><small>正在看</small>{viewed.name}</span>}<button onClick={browseCategories}>更换品类</button></div>
            <ConditionPanel key={`${state.category}:${JSON.stringify(state.conditions)}`} />
            <section className="messages" ref={logRef} role="log" aria-label="对话记录">{messages.map(m => <div key={m.id} className={`turn turn-${m.role}`}>
              <div className={`message from-${m.role}`}>{m.text}</div>
              <MessageRefs message={m} />
              <MessageEvidence message={m} />
              <RecommendationList message={m} />
              {m.details && m.details.length > 0 && <details className="change-log"><summary>条件变更详情{m.unhandled ? ` · ${m.unhandled} 项没有处理` : ''}</summary><ul>{m.details.map((d, i) => <li key={i}>{d}</li>)}</ul></details>}
            </div>)}{loading && <div className="loading-line" role="status"><span className="spinner" />正在整理你的选择…</div>}{status === 'error' && <div className="error-line" role="alert">暂时没能完成，条件已保留。<button className="button outline small" onClick={() => { followLatest(); dispatch({ type: 'retry' }); }}>重试</button></div>}</section>
            {session.compareIds.length === 1 && <p className="compare-hint" role="status">已选 1 款，再选 1 款即可比较。</p>}
            {session.notice && <p className="compare-hint" role="status">{session.notice}</p>}
            {session.compareIds.length === MAX_COMPARE && <section className="assistant-section"><h2>两款放在一起看<button className="button ghost small" onClick={() => dispatch({ type: 'clearCompare' })}>清空</button></h2><CompareTable state={state} conditionLabel="助手当前条件" /></section>}
            {canApply && hasRecommendations && !loading && status !== 'error' && <div className="sync-action"><button className="button outline" onClick={() => dispatch({ type: 'applyToList' })}>应用到商城筛选 ↗</button><p>应用后，商城将{byPageFilters(mallFilters)}筛选</p></div>}
          </>}
        </>}
      </div>
      {!debug && !home && !choosingCategory && <footer className="assistant-foot">{readingHistory && engaged && <button className="latest-message" onClick={() => followLatest('smooth')}>回到最新消息 ↓</button>}{options.length > 0 && <div className="quick-options" aria-label="快捷选项">{options.map(o => <button key={o.id} disabled={loading} onClick={() => { followLatest(); dispatch({ type: 'uiChanges', label: o.label, changes: o.changes }); }}>{o.label}</button>)}</div>}{composer}<p className="prototype-caption">Gemini 理解需求 · 价格和参数以商品数据为准，暂无第三方评测</p></footer>}
    </aside>
  </>;
}
