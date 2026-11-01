'use client';
import Link from 'next/link';
import { compareProducts, MAX_COMPARE } from '../lib/compare';
import type { ConditionState } from '../lib/conditions';
import { getProduct } from '../lib/products';
import type { Product } from '../lib/products';
import { compare, search } from '../lib/api';
import { useRequest } from '../lib/use-request';
import { ErrorState, LoadingState } from './RequestState';
import { useShop } from './ShopProvider';
import { ProductArt } from './Visuals';

function selectedProducts(ids: string[]): Product[] {
  return ids.map(id => getProduct(id)).filter((p): p is Product => Boolean(p));
}

// 两款商品同维度比较。对照“当前条件”检查，已不满足的商品标记出来，而不是悄悄移除（PRD 5.4 结果更新）。
export function CompareTable({ state, conditionLabel }: { state: ConditionState; conditionLabel: string }) {
  const { session } = useShop();
  const result = useRequest(JSON.stringify({ ids: session.compareIds, state }), async () => {
    if (session.compareIds.length !== 2) return null;
    const [products, found] = await Promise.all([compare(session.compareIds), search(state)]);
    return { products, evaluations: found.evaluations };
  });
  if (session.compareIds.length !== 2) return null;
  if (result.error) return <ErrorState message={result.error} onRetry={result.retry} retryLabel="重试比较" />;
  if (!result.value) return <LoadingState label="正在加载比较…" />;
  const products = result.value.products;
  if (products.length < MAX_COMPARE) return null;
  const [a, b] = products;
  const rows = compareProducts(a, b);
  const stale = products.map(p => !result.value!.evaluations[p.id]?.eligible);
  return (
    <div>
      <div className="compare-table-wrap">
        <table className="compare-table">
          <caption className="sr-only">两款商品的参数对比</caption>
          <thead>
            <tr>
              <th scope="col">对比项</th>
              {products.map((p, i) => (
                <th scope="col" key={p.id}>
                  <Link href={`/headphones/${p.id}`} className="compare-thumb" aria-hidden="true" tabIndex={-1}><ProductArt product={p} /></Link>
                  <Link href={`/headphones/${p.id}`}>{p.name}</Link>
                  {stale[i] && <span className="stale">不符合{conditionLabel}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.label} className={row.differs ? 'differs' : ''}>
                <th scope="row">{row.label}</th>
                <td>{row.values[0]}</td>
                <td>{row.values[1]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted compare-legend">浅黄底色表示两款不同的项目。“暂未收录”表示商品数据集中没有这一项，不代表不支持；降噪深度为标称值。</p>
    </div>
  );
}

// 商城页底部的对比栏
export function CompareTray() {
  const { session, dispatch } = useShop();
  const products = selectedProducts(session.compareIds);
  if (!products.length && !session.notice) return null;
  return (
    <div className="compare-tray" role="region" aria-label="对比栏">
      <span>对比（{products.length}/{MAX_COMPARE}）</span>
      {products.map(p => (
        <span className="chip" key={p.id}>
          {p.name}
          <button type="button" aria-label={`从对比中移除 ${p.name}`} onClick={() => dispatch({ type: 'toggleCompare', productId: p.id })}>×</button>
        </span>
      ))}
      {session.notice && <span role="status">{session.notice}</span>}
      <span className="spacer" />
      {products.length === MAX_COMPARE && <Link className="button green small" href="/headphones#compare">查看对比</Link>}
      {products.length < MAX_COMPARE && products.length > 0 && <span>再选 1 款即可比较</span>}
      <button type="button" className="button ghost small" onClick={() => dispatch({ type: 'clearCompare' })}>清空</button>
    </div>
  );
}
