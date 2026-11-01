import { notFound } from 'next/navigation';
import { ProductDetail } from '../../../components/ProductDetail';
import { ApiError, api } from '../../../lib/api';
import type { RawProduct } from '../../../lib/products';

// 详情数据在服务端向 FastAPI 请求：商品不存在（含本期不展示的保留型号）时返回 404；
// 后端暂时不可用时交给页面显示可重试的错误。
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let initial: RawProduct | null = null;
  try {
    initial = await api<RawProduct>(`/products/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
  }
  return <ProductDetail id={id} initial={initial} />;
}
