import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AssistantLauncher, AssistantPanel } from '../components/Assistant';
import { MallHeader } from '../components/MallHeader';
import { ShopProvider } from '../components/ShopProvider';
import type { RawCatalog } from '../lib/api';
import { fetchRawCatalog } from '../lib/api';
import './globals.css';

// 商品数据每次请求都从 FastAPI 读取（后端是唯一数据与规则来源），不在构建时固化
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ShopMate 原型 · 演示商城',
  description: '内嵌在模拟购物页面中的 ShopMate 选购助手原型。商品来自固定演示数据集，固定话术演示，未接入 LLM 和 RAG。',
};

export default async function Layout({ children }: { children: ReactNode }) {
  // 服务端预取商品数据，首屏直接渲染；后端不可用时为 null，由浏览器端显示可重试的错误
  const initialCatalog: RawCatalog | null = await fetchRawCatalog().catch(() => null);
  return (
    <html lang="zh-CN">
      <body>
        <ShopProvider initialCatalog={initialCatalog}>
          <MallHeader />
          <main className="mall-main" id="main">{children}</main>
          <AssistantLauncher />
          <AssistantPanel />
        </ShopProvider>
      </body>
    </html>
  );
}
