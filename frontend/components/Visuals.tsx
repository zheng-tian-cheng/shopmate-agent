// 原型中的品牌标识和商品示意图，继续沿用；头戴式另画一个示意图。
import type { Product } from '../lib/products';

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M9 11v-1a7 7 0 0 1 14 0v1M6 11h20l-2 16H8L6 11Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="m12 18 3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

// 与 mock ID 一一对应的示意外观，不代表真实产品照片。
const LOOKS: Record<string, { color: string; round: number; width: number; stem: boolean }> = {
  'mock-01': { color: '#fdfcf7', round: 26, width: 110, stem: true },
  'mock-02': { color: '#363e47', round: 30, width: 98, stem: false },
  'mock-03': { color: '#aab6c9', round: 18, width: 116, stem: true },
  'mock-04': { color: '#cbb897', round: 12, width: 122, stem: false },
  'mock-06': { color: '#758580', round: 22, width: 105, stem: true },
  'mock-07': { color: '#d8b5b6', round: 33, width: 90, stem: true },
};
function Earbuds({ product }: { product: Product }) {
  const look = LOOKS[product.id] ?? LOOKS['mock-01'];
  return <svg viewBox="0 0 260 150" fill="none">
    <ellipse cx="130" cy="132" rx="62" ry="7" fill="#263531" opacity=".12" />
    <rect x={130 - look.width / 2} y="73" width={look.width} height="56" rx={look.round} fill={look.color} />
    <path d={`M${134 - look.width / 2} 91h${look.width - 8}`} stroke="#455754" opacity=".25" />
    <rect x="125" y="106" width="10" height="3" rx="2" fill="#718b78" />
    {[92, 168].map((x, i) => <g key={x} transform={`rotate(${i ? 23 : -23} ${x} 40)`}>
      {look.stem && <rect x={x - 6} y="29" width="13" height={product.wearingStyle === '半入耳式' ? 40 : 32} rx="6" fill={look.color} />}
      <ellipse cx={x} cy="30" rx={look.stem ? 19 : 22} ry={look.stem ? 15 : 21} fill={look.color} />
      <ellipse cx={x + (i ? 10 : -10)} cy="29" rx="5" ry="7" fill="#45524e" />
      {product.wearingStyle === '入耳式' && <rect x={x + (i ? 13 : -23)} y="24" width="10" height="12" rx="5" fill="#69736a" />}
      <path d={`M${x - 4} 18l7 2`} stroke="#ffffff" opacity=".5" strokeWidth="3" strokeLinecap="round" />
    </g>)}
  </svg>;
}

function Headphones() {
  return (
    <svg viewBox="0 0 260 150" fill="none">
      <ellipse cx="130" cy="136" rx="66" ry="6" fill="#173d2e" opacity=".08" />
      <path d="M80 98V72a50 50 0 0 1 100 0v26" stroke="white" strokeWidth="11" strokeLinecap="round" />
      <path d="M80 98V72a50 50 0 0 1 100 0v26" stroke="#d8ddd6" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="62" y="84" width="34" height="48" rx="14" fill="white" />
      <rect x="164" y="84" width="34" height="48" rx="14" fill="white" />
      <rect x="70" y="93" width="12" height="30" rx="6" fill="#617068" opacity=".35" />
      <rect x="178" y="93" width="12" height="30" rx="6" fill="#617068" opacity=".35" />
    </svg>
  );
}

// 真实商品：准确型号照片直接显示；示意图（同类耳机的授权照片）在详情大图上标注，
// 列表、首页和推荐卡片用页面级说明“部分商品图片为演示示意”；都没有时显示中性占位。虚构商品（仅测试数据）沿用插画。
export function ProductArt({ product, showDemoBadge = false }: { product: Product; showDemoBadge?: boolean }) {
  if (!product.isMock) {
    if (product.image) {
      return (
        <div className={`product-art product-photo ${product.image.isDemo ? 'demo' : ''}`}>
          <img src={product.image.src} alt={product.image.alt} loading="lazy" />
          {product.image.isDemo && showDemoBadge && <span className="demo-badge">演示示意图 · 非该型号实拍</span>}
        </div>
      );
    }
    if (product.referenceImage) {
      // 仅本地开发模式：未授权的参考素材，明确标注，不进入公开展示
      return (
        <div className="product-art product-photo reference">
          <img src={product.referenceImage} alt="" loading="lazy" />
          <span className="reference-badge">本地参考图 · 未授权</span>
        </div>
      );
    }
    return (
      <div className="product-art product-placeholder" aria-hidden="true">
        <svg viewBox="0 0 48 48" fill="none"><path d="M12 30v-6a12 12 0 0 1 24 0v6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /><rect x="9" y="28" width="7" height="11" rx="3" stroke="currentColor" strokeWidth="2.2" /><rect x="32" y="28" width="7" height="11" rx="3" stroke="currentColor" strokeWidth="2.2" /></svg>
        <span>暂无经授权的商品图</span>
      </div>
    );
  }
  return (
    <div className={`product-art ${product.tone}`} aria-hidden="true">
      {product.wearingStyle === '头戴式' ? <Headphones /> : <Earbuds product={product} />}
      <span>示意图 · 非真实商品</span>
    </div>
  );
}

export function MockTag({ children = '演示商品' }: { children?: string }) {
  return <span className="mock-tag">{children}</span>;
}
