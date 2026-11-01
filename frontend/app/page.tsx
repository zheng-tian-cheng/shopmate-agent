'use client';
import Image from 'next/image';
import Link from 'next/link';
import { catalog } from '../lib/products';
import { HomeSearch } from '../components/HomeSearch';
import { ProductArt } from '../components/Visuals';
import { Price } from '../components/ProductCard';
// 生活场景照片（Unsplash License，来源见 assets/lifestyle/README.md），不代表任何商品
import homeListening from '../assets/lifestyle/home-listening.jpg';
import commuteSubway from '../assets/lifestyle/commute-subway.jpg';
import headphonesDesk from '../assets/lifestyle/headphones-desk.jpg';

export default function Home() {
  return <>
    <div className="home-greeting"><div><p className="eyebrow">A LITTLE BETTER, EVERY DAY</p><h1>把日常，选得更喜欢。</h1></div><span aria-hidden="true">✳</span></div>
    <HomeSearch />
    <Link href="/headphones" className="home-feature"><div className="feature-copy"><span className="eyebrow">日常灵感 · 从这里开始</span><h2>从通勤到居家，<br />找到你的喜欢。</h2><p>首期开放蓝牙耳机选购体验</p><span className="feature-cta">去挑一挑 ↗</span></div><Image src={homeListening} alt="在家戴着耳机听音乐的人（生活场景）" className="feature-photo" sizes="(min-width: 700px) 720px, 100vw" priority placeholder="blur" /></Link>
    <nav className="home-categories" aria-label="商品分类">
      <Link href="/headphones" className="category-main"><Image src={headphonesDesk} alt="" className="category-photo" sizes="72px" /><div><strong>数码随身 · 蓝牙耳机</strong><small>{catalog().length} 款真实型号，可体验 ShopMate 选购</small></div><span aria-hidden="true">→</span></Link>
      <p className="category-more">更多品类筹备中：居家好物 · 生活家电 · 户外出行</p>
    </nav>
    <div className="section-title"><div><span className="eyebrow">TAKE A CLOSER LOOK</span><h2>本期可体验 · 蓝牙耳机</h2></div><Link href="/headphones">全部 →</Link></div>
    <div className="home-products">{catalog().map(p => <Link className="home-product" key={p.id} href={`/headphones/${p.id}`}><ProductArt product={p} /><h3>{p.name}</h3><p>{p.subtitle}</p><Price product={p} /></Link>)}</div>
    <Link href="/headphones?q=头戴式" className="listening-feature">
      <div><span className="eyebrow">换一种聆听方式</span><h2>入耳式之外，<br />还有别的选择。</h2><p>看看头戴式耳机 →</p></div>
      <Image src={commuteSubway} alt="地铁站台上戴着头戴式耳机的人（生活场景）" className="listening-photo" sizes="(min-width: 700px) 420px, 45vw" placeholder="blur" />
    </Link>
    <p className="mall-disclaimer">原型体验 · 不提供购买 · 价格与参数来自本站商品数据集 · 部分商品图片为演示示意，非对应型号实拍 · 场景照片来自 Unsplash</p>
  </>;
}
