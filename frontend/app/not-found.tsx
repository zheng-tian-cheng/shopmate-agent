import Link from 'next/link';

// 商品不存在（包括本期不展示的保留型号）或地址错误
export default function NotFound() {
  return (
    <div className="state-panel not-found">
      <h1>没有找到这个页面</h1>
      <p>商品可能不在本期展示范围内，或链接有误。</p>
      <p><Link href="/headphones" className="text-link">查看全部蓝牙耳机</Link>　<Link href="/" className="text-link">返回首页</Link></p>
    </div>
  );
}
