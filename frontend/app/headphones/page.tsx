import type { Metadata } from 'next';
import { Suspense } from 'react';
import { HeadphoneList } from '../../components/HeadphoneList';

export const metadata: Metadata = { title: '蓝牙耳机 · 演示商城' };

export default function HeadphonesPage() {
  return <Suspense fallback={<p className="muted">正在加载商品…</p>}><HeadphoneList /></Suspense>;
}
