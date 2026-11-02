import type { ApplyResult, ConditionState } from './conditions.ts';
import type { CatalogFile, Product, RawProduct, RawSource } from './products.ts';
import { IMAGE_FILE, currentImageMode, toProduct, installCatalog } from './products.ts';
import type { Evaluation, Match } from './search.ts';
import type { HeadphoneQuery } from './search-intent.ts';

// 前端访问 FastAPI 的唯一入口。浏览器经 Next 的 /api 重写转发，服务端直接请求 SHOPMATE_API_URL。
// 错误带上 HTTP 状态码（网络不可达为 0），页面据此区分“商品不存在”和“服务暂时不可用”。
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const base = typeof window === 'undefined' ? (process.env.SHOPMATE_API_URL ?? 'http://127.0.0.1:8000') + '/api' : '/api';
  let response: Response;
  try {
    response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(path === '/chat' ? 50000 : 15000), cache: 'no-store' });
  } catch { throw new ApiError('无法连接商品服务，请确认后端已启动后重试。', 0); }
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiError(typeof error?.error?.message === 'string' ? error.error.message : typeof error?.detail === 'string' ? error.detail : `请求失败（${response.status}），请稍后重试。`, response.status);
  }
  return response.json() as Promise<T>;
}
let sources: Record<string, RawSource> = {};
export function adapt(raw: RawProduct): Product {
  return toProduct(raw, sources, IMAGE_FILE.images[raw.id], currentImageMode(), IMAGE_FILE.demoImages);
}
export type RawCatalog = Pick<CatalogFile, 'products' | 'sources'>;
export function fetchRawCatalog(): Promise<RawCatalog> {
  return api<RawCatalog>('/products');
}
// 安装后端返回的商品数据：列表、详情、推荐和比较都读这一份
export function hydrateCatalog(data: RawCatalog): Product[] {
  sources = data.sources;
  const products = data.products.map(adapt);
  installCatalog(products);
  return products;
}
export async function loadCatalog(): Promise<Product[]> {
  return hydrateCatalog(await fetchRawCatalog());
}
export async function loadProduct(id: string): Promise<Product> {
  return adapt(await api<RawProduct>(`/products/${encodeURIComponent(id)}`));
}
export async function search(state: ConditionState, query?: HeadphoneQuery): Promise<{ matches: Match[]; evaluations: Record<string, Evaluation> }> {
  const result = await api<{ matches: { product: RawProduct; evaluation: Evaluation }[]; evaluations: Record<string, Evaluation> }>('/products/search', { state, query });
  return { ...result, matches: result.matches.map(m => ({ ...m, product: adapt(m.product) })) };
}
export async function compare(ids: string[]): Promise<Product[]> {
  return (await api<{ products: RawProduct[] }>('/products/compare', { product_ids: ids })).products.map(adapt);
}
