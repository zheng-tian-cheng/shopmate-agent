'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: '首页' },
  { href: '/headphones', label: '逛一逛' },
];

export function MallHeader() {
  const pathname = usePathname();
  return (
    <header className="mall-header">
      <div className="mall-header-inner">
        <Link href="/" className="mall-logo"><span className="mall-logo-dot" aria-hidden="true" />好物日常<span className="mall-wordmark">DAILY FINDS</span></Link>
        <nav className="mall-nav" aria-label="主导航">
          {NAV.map(item => (
            <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}>{item.label}</Link>
          ))}
        </nav>
        <span className="mock-tag">Mock 原型</span>
      </div>
    </header>
  );
}
