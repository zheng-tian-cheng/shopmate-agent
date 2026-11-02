'use client';
import { createContext, use, useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import type { Dispatch, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { RawCatalog } from '../lib/api';
import { hydrateCatalog, loadCatalog, search } from '../lib/api';
import { useRequest } from '../lib/use-request';
import type { Match, Evaluation } from '../lib/search';
import { getProduct } from '../lib/products';
import { entryFromPath } from '../lib/routes';
import type { ShopAction, ShopSession } from '../lib/session';
import { initialSession } from '../lib/session';
import { createSessionController } from '../lib/session-controller';
import { ServiceState } from './RequestState';

const ShopContext = createContext<{ session: ShopSession; dispatch: Dispatch<ShopAction>; docked: boolean; matches: Match[]; evaluations: Record<string, Evaluation> } | null>(null);

// 桌面宽屏（≥1024px）：助手是页面右侧的非模态面板，商品页同时可读、可点、可滚动；
// 更窄的屏幕：助手全屏（手机）或浮层（平板），打开时锁定背景，关闭后恢复浏览位置。
export const DOCK_QUERY = '(min-width: 1024px)';
function subscribeDock(onChange: () => void) {
  const query = window.matchMedia(DOCK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
function useDockedLayout(): boolean {
  return useSyncExternalStore(subscribeDock, () => window.matchMedia(DOCK_QUERY).matches, () => false);
}

// 超过 delay 毫秒仍在进行的请求才显示提示，避免每次操作都闪一下
function useDelayed(active: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return shown;
}

// initialCatalog：根布局在服务端从 FastAPI 预取的商品数据，首屏直接渲染；预取失败时在浏览器端重新请求
export function ShopProvider({ children, initialCatalog = null }: { children: ReactNode; initialCatalog?: RawCatalog | null }) {
  const [initialProducts] = useState(() => (initialCatalog ? hydrateCatalog(initialCatalog) : null));
  const [session, setSession] = useState(initialSession);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalogRequest = useRequest(initialProducts ? 'catalog:server' : 'catalog', initialProducts ? async () => initialProducts : loadCatalog);
  const products = initialProducts ?? catalogRequest.value;
  const assistantSearch = useRequest(JSON.stringify(session.assistant.state), () => search(session.assistant.state));
  const [controller] = useState(() => createSessionController(setSession, (active, message) => {
    setBusy(active);
    if (message) setError(message);
  }));
  const dispatch = useCallback((action: ShopAction) => {
    setError(null);
    void controller.dispatch(action);
  }, [controller]);
  const pending = session.assistant.pendingRequest;
  const open = session.assistant.open;
  const docked = useDockedLayout();
  const pathname = usePathname();

  // 当前浏览商品跟随路由更新；不清空对话和购买条件
  useEffect(() => {
    const { productId } = entryFromPath(pathname);
    dispatch({ type: 'viewPage', productId: productId && getProduct(productId) ? productId : null });
  }, [pathname, products, dispatch]);

  // 发起聊天请求（在队列外等待，见 session-controller）；新的条件操作使旧结果失效。
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => dispatch({ type: 'textResolved', requestId: pending.id }), 0);
    return () => clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    if (!open) return;
    const body = document.body;
    if (docked) {
      // 分屏：不遮罩、不锁定背景，主内容让出面板宽度
      body.classList.add('assistant-docked');
      return () => body.classList.remove('assistant-docked');
    }
    const scrollY = window.scrollY;
    const previous = { position: body.style.position, top: body.style.top, width: body.style.width };
    const background = document.querySelectorAll<HTMLElement>('.mall-header, .mall-main');
    background.forEach(el => { el.inert = true; });
    body.classList.add('assistant-open');
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    return () => {
      background.forEach(el => { el.inert = false; });
      body.classList.remove('assistant-open');
      Object.assign(body.style, previous);
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    };
  }, [open, docked]);

  const showBusy = useDelayed(busy, 300);
  // 助手的后台筛选失败只在用过助手后提示；页面自己的请求失败由页面就地显示，避免同一错误出现两次
  const message = error ?? (session.assistant.started ? assistantSearch.error : undefined);
  return <ShopContext value={{ session, dispatch, docked, matches: assistantSearch.value?.matches ?? [], evaluations: assistantSearch.value?.evaluations ?? {} }}>
    {products ? children : <ServiceState error={catalogRequest.error} onRetry={catalogRequest.retry} />}
    {products && showBusy && <p className="busy-pill" role="status"><span className="spinner" aria-hidden="true" />正在更新…</p>}
    {products && message && <div className="request-toast" role="alert">
      <span>{error ? `${error}（条件未改变，可以再操作一次）` : message}</span>
      {!error && <button type="button" onClick={() => assistantSearch.retry()}>重试</button>}
      <button type="button" aria-label="关闭提示" onClick={() => setError(null)}>×</button>
    </div>}
  </ShopContext>;
}

export function useShop() {
  const value = use(ShopContext);
  if (!value) throw new Error('useShop 必须在 ShopProvider 内使用');
  return value;
}
