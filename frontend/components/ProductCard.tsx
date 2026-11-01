'use client';
import Link from 'next/link';
import type { Product } from '../lib/products';
import { ancLabel, batteryBrief, priceLabel, wearingLabel } from '../lib/products';
import type { Evaluation } from '../lib/search';
import { useShop } from './ShopProvider';
import { ProductArt } from './Visuals';

export function Price({ product }: { product: Product }) {
  return product.price.amount === null
    ? <p className="price unknown">价格待核验</p>
    : <p className="price">{priceLabel(product)}{product.isMock && <small>模拟价格</small>}</p>;
}

export function SpecLine({ product }: { product: Product }) {
  return (
    <div className="spec-line">
      <span>{wearingLabel(product)}</span>
      <span>主动降噪：{ancLabel(product)}</span>
      <span>续航：{batteryBrief(product)}</span>
    </div>
  );
}

export function CompareButton({ productId, small = false }: { productId: string; small?: boolean }) {
  const { session, dispatch } = useShop();
  const selected = session.compareIds.includes(productId);
  return (
    <button
      type="button"
      className={`button outline ${small ? 'small' : ''} ${selected ? 'selected' : ''}`}
      aria-pressed={selected}
      onClick={() => dispatch({ type: 'toggleCompare', productId })}
    >
      {selected ? '✓ 已选' : '＋ 比较'}
    </button>
  );
}

// 商城列表中的商品卡片
export function ProductCard({ product }: { product: Product; evaluation?: Evaluation }) {
  return (
    <article className="product-card">
      <Link href={`/headphones/${product.id}`} aria-label={`查看 ${product.name} 详情`}><ProductArt product={product} /></Link>
      <h3><Link href={`/headphones/${product.id}`}>{product.name}</Link></h3>
      <Price product={product} />
      {product.subtitle && <div className="product-key-spec">{product.subtitle}</div>}
      <div className="card-actions">
        <CompareButton productId={product.id} small />
        <Link href={`/headphones/${product.id}`} className="button ghost small">详情</Link>
      </div>
    </article>
  );
}
