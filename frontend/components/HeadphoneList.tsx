'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { valueError } from '../lib/conditions';
import type { PageFilters } from '../lib/page-sync';
import { DEFAULT_PAGE_FILTERS, stateFromPageFilters } from '../lib/page-sync';
import { catalog } from '../lib/products';
import { search } from '../lib/api';
import { useRequest } from '../lib/use-request';
import { classifySearch, describeHeadphoneQuery, parseHeadphoneQuery } from '../lib/search-intent';
import { CompareTable, CompareTray } from './Compare';
import { ProductCard } from './ProductCard';
import { ErrorState, LoadingState } from './RequestState';
import { useShop } from './ShopProvider';

// 普通筛选：只有预算上限、必须主动降噪、排除入耳式三项，同时作为 H0 对照方案。
function FilterForm({ filters, onApply }: { filters: PageFilters; onApply: (f: PageFilters) => void }) {
  const [budget, setBudget] = useState(filters.budgetMax?.toString() ?? '');
  const [anc, setAnc] = useState(filters.ancRequired);
  const [inEar, setInEar] = useState(filters.excludeInEar);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const amount = budget.trim() === '' ? null : Number(budget);
    const problem = amount === null ? null : valueError('budget', amount);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    onApply({ budgetMax: amount, ancRequired: anc, excludeInEar: inEar });
  }

  return (
    <form className="filter-panel" onSubmit={e => { e.preventDefault(); submit(); }} aria-label="商品筛选">
      <h2>筛选</h2>
      <label className="field">预算上限（元）
        <input type="number" min="0.01" max="100000" step="0.01" placeholder="不限" value={budget} onChange={e => setBudget(e.target.value)} />
      </label>
      <label className="check"><input type="checkbox" checked={anc} onChange={e => setAnc(e.target.checked)} /> 必须支持主动降噪</label>
      <label className="check"><input type="checkbox" checked={inEar} onChange={e => setInEar(e.target.checked)} /> 排除入耳式</label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="filter-actions">
        <button type="submit" className="button dark small">筛选</button>
        <button type="button" className="button ghost small" onClick={() => { setError(null); onApply({ ...DEFAULT_PAGE_FILTERS }); }}>清除</button>
      </div>
      
    </form>
  );
}

export function HeadphoneList() {
  const { session, dispatch } = useShop();
  const filters = session.pageFilters;

  const query = useSearchParams().get('q')?.trim() ?? '';
  const intent = query ? classifySearch(query, catalog()) : null;
  // 搜索词只在已设的筛选条件之内进一步缩小范围；没有结果时不放宽
  const parsed = parseHeadphoneQuery(query);
  const understood = query ? describeHeadphoneQuery(parsed) : [];
  const result = useRequest(JSON.stringify({ filters, parsed }), async () => {
    const state = await stateFromPageFilters(filters);
    return { state, ...await search(state, parsed) };
  });
  const pageState = result.value?.state;
  const matches = result.value?.matches ?? [];

  return (
    <>
      <nav className="breadcrumb" aria-label="面包屑"><Link href="/">首页</Link><span>/</span><span>蓝牙耳机</span></nav>
      <div className="page-title">
        <h1>蓝牙耳机</h1>
        <span className="mock-tag">部分商品图片为演示示意</span>
      </div>
      <div className="list-layout">
        <details className="list-filters"><summary>筛选条件 <span>{filters.budgetMax ? `≤ ¥${filters.budgetMax}` : '预算不限'}{filters.ancRequired ? ' · 主动降噪' : ''}{filters.excludeInEar ? ' · 非入耳式' : ''} <b>⌄</b></span></summary><FilterForm key={JSON.stringify(filters)} filters={filters} onApply={f => dispatch({ type: 'setPageFilters', filters: f })} /></details>
        <div>
          {intent?.kind === 'unavailable' ? (
            <div className="state-panel search-unavailable">
              <h2>「{intent.label}」暂未开放</h2>
              <p>首期只开放蓝牙耳机选购，「{query}」所在的品类还在准备中。</p>
              <p><Link href="/headphones" className="text-link">查看全部蓝牙耳机</Link>　<Link href="/" className="text-link">返回首页</Link></p>
            </div>
          ) : <>
          <div className="result-bar">
            <span>{query ? `搜索“${query}”：` : ''}{result.value ? `${matches.length} 款符合筛选` : '正在筛选…'}</span>
            {query && <Link href="/headphones" className="text-link">清除搜索</Link>}
            <span className="muted">{parsed.budgetNear !== null ? `按接近 ${parsed.budgetNear} 元排序` : '按价格从低到高'}</span>
          </div>
          {understood.length > 0 && <p className="search-understood">按搜索词筛选：{understood.join(' · ')}</p>}
          {result.error ? (
            <ErrorState message={result.error} onRetry={result.retry} retryLabel="重新筛选" />
          ) : !result.value ? (
            <LoadingState label="正在筛选商品…" />
          ) : matches.length === 0 ? (
            <div className="state-panel">
              <h2>没有符合筛选条件的商品</h2>
              <p>列表不会自动放宽条件。可以调整筛选，或让 ShopMate 帮你梳理需求。</p>
            </div>
          ) : (
            <div className="product-grid">
              {matches.map(m => <ProductCard key={m.product.id} product={m.product} evaluation={m.evaluation} />)}
            </div>
          )}
          </>}
          <section id="compare" className="compare-section" aria-label="商品对比">
            {pageState && <CompareTable state={pageState} conditionLabel="当前列表筛选" />}
          </section>
          <CompareTray />
        </div>
      </div>
    </>
  );
}
