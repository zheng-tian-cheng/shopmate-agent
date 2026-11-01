'use client';
import Link from 'next/link';
import { adapt, loadProduct } from '../lib/api';
import { useRequest } from '../lib/use-request';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Product, RawProduct, SourcedField } from '../lib/products';
import { NOT_LISTED, ancLabel, batteryLines, getProduct, priceLabel, wearingLabel, weightLabel } from '../lib/products';
import { CompareTray } from './Compare';
import { CompareButton, Price } from './ProductCard';
import { ErrorState, LoadingState } from './RequestState';
import { useShop } from './ShopProvider';
import { BrandMark, MockTag, ProductArt } from './Visuals';

// 详情页参数表：完整、易读，只放参数本身。佩戴方式和主动降噪影响选择，没有收录也显示；
// 其他字段没有收录时不占一行。来源与依据折叠在下方，需要核对时再展开。
function specRows(product: Product): [string, ReactNode][] {
  const rows: [string, ReactNode | null][] = [
    ['品牌', product.brand],
    ['型号', product.model],
    ['价格', priceLabel(product)],
    ['佩戴方式', wearingLabel(product)],
    ['主动降噪', ancLabel(product)],
    ['降噪深度', product.ancSpec ? <>{product.ancSpec}<small>厂商或媒体标称值，不代表实际降噪效果</small></> : null],
    ['续航', batteryLines(product).length
      ? <>{batteryLines(product).map(line => <span key={line} className="spec-line-item">{line}</span>)}{product.batteryConditions && <small>{product.batteryConditions}</small>}</>
      : null],
    ['重量', weightLabel(product) === NOT_LISTED ? null : weightLabel(product)],
    ['蓝牙版本', product.bluetooth ? `蓝牙 ${product.bluetooth}` : null],
  ];
  return rows.filter((row): row is [string, ReactNode] => row[1] !== null && row[1] !== undefined);
}

export function ProductDetail({ id, initial = null }: { id: string; initial?: RawProduct | null }) {
  const { dispatch } = useShop();
  // 服务端已取到详情时直接使用；否则（服务端请求失败）在浏览器端重新请求
  const seeded = useMemo(() => (initial && initial.id === id ? adapt(initial) : null), [initial, id]);
  const result = useRequest(seeded ? `seed:${id}` : id, seeded ? async () => seeded : () => loadProduct(id));
  const product = seeded ?? result.value;
  if (!product && result.error) return <ErrorState message={result.error} onRetry={result.retry} retryLabel="重新加载详情" />;
  if (!product) return <LoadingState label="正在加载商品详情…" />;
  return (
    <>
      <nav className="breadcrumb" aria-label="面包屑">
        <Link href="/">首页</Link><span>/</span><Link href="/headphones">蓝牙耳机</Link><span>/</span><span>{product.name}</span>
      </nav>
      <div className="detail">
        <ProductArt product={product} showDemoBadge />
        <div className="detail-info">
          {product.isMock ? <div><MockTag /></div> : <p className="detail-brand">{product.brand}</p>}
          <h1>{product.name}</h1>
          {product.subtitle && <p className="muted">{product.subtitle}</p>}
          <Price product={product} />
          <h2 className="spec-heading">参数</h2>
          <dl className="spec-table">
            {specRows(product).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          {product.isMock
            ? <details className="product-evidence"><summary>数据说明</summary><p className="data-note">来源：本地演示数据 {product.id}。型号、价格与参数均为虚构，仅用于测试交互；演示环境不提供购买。</p></details>
            : <SourceList product={product} />}
          <div className="detail-actions">
            <CompareButton productId={product.id} />
            {product.officialLink && <a href={product.officialLink.url} target="_blank" rel="noreferrer" className="button outline">{product.officialLink.label} ↗</a>}
            <Link href="/headphones" className="button ghost">返回列表</Link>
          </div>

          <section className="sm-card" aria-label="ShopMate 操作">
            <div className="sm-card-head"><BrandMark small /><strong>让 ShopMate 帮你看看</strong></div>
            <div className="sm-card-actions">
              <button type="button" className="button green small" onClick={() => dispatch({ type: 'findSimilar', productId: product.id })}>找相似款</button>
              <button type="button" className="button outline small" onClick={() => dispatch({ type: 'openAssistant', entry: 'detail', productId: product.id })}>问 ShopMate</button>
            </div>
          </section>
          <p className="page-note">演示商城，不提供购买。价格和参数来自本站商品数据集{product.image?.isDemo ? '；商品图片为同类耳机的演示示意，非该型号实拍' : ''}。</p>
        </div>
      </div>
      <CompareTray />
    </>
  );
}

const FIELD_LABEL: Record<SourcedField, string> = {
  price: '价格', anc: '主动降噪', ancSpec: '降噪深度', wearingStyle: '佩戴方式', battery: '续航', weight: '重量', bluetooth: '蓝牙版本', image: '商品照片',
};

// 每个字段的可核查来源，默认折叠；价格依据（来源口径）也放在这里，不打断参数阅读。
function SourceList({ product }: { product: Product }) {
  const entries = Object.entries(product.sources ?? {}) as [SourcedField, NonNullable<Product['sources']>[SourcedField]][];
  return (
    <details className="product-evidence">
      <summary>参数来源</summary>
      <p className="data-note">价格依据：{product.price.conditions}</p>
      <ul className="source-list">
        {entries.map(([field, refs]) => (
          <li key={field}>
            <strong>{FIELD_LABEL[field]}</strong>
            {(refs ?? []).map(ref => (
              <a key={ref.id} href={ref.url} target="_blank" rel="noreferrer">
                {ref.publisher}{ref.kind === 'official' ? '（官方）' : '（媒体报道）'}{ref.publishedAt ? ` · ${ref.publishedAt}` : ''} ↗
              </a>
            ))}
          </li>
        ))}
      </ul>
      <ImageCredit product={product} />
      {product.notes && product.notes.length > 0 && <ul className="source-notes">{product.notes.map(n => <li key={n}>{n}</li>)}</ul>}
    </details>
  );
}

// 图片许可说明：许可图片按许可要求署名，示意图注明不是该型号；参考素材标明未授权；没有图片时给出官方资料链接
function ImageCredit({ product }: { product: Product }) {
  if (product.image) {
    const { author, license, licenseUrl, sourceUrl, modifications, isDemo } = product.image;
    return (
      <p className="data-note">
        {isDemo ? '商品示意图（同类耳机，非该型号实拍）' : '商品照片'}：{author}，<a href={licenseUrl} target="_blank" rel="noreferrer">{license}</a>，
        <a href={sourceUrl} target="_blank" rel="noreferrer">来源 ↗</a>{modifications ? `；${modifications}` : ''}
      </p>
    );
  }
  if (product.referenceImage) return <p className="data-note">商品照片：本地参考素材，未获授权，不会出现在公开展示中。</p>;
  return (
    <p className="data-note">
      商品照片：暂无经授权的准确型号照片，也没有合适的示意图。
      {product.officialLink && <> 可查看<a href={product.officialLink.url} target="_blank" rel="noreferrer">{product.officialLink.label} ↗</a></>}
    </p>
  );
}
