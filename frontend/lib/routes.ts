// 页面路由与助手上下文的对应：只有商品详情页有“当前浏览商品”，首页和列表没有。
import type { Entry } from './session.ts';

export function entryFromPath(pathname: string): { entry: Entry; productId: string | null } {
  const detail = pathname.match(/^\/headphones\/([^/]+)$/);
  if (detail) return { entry: 'detail', productId: decodeURIComponent(detail[1]) };
  return { entry: pathname.startsWith('/headphones') ? 'list' : 'home', productId: null };
}
