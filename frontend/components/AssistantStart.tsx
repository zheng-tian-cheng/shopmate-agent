'use client';
import type { ReactNode } from 'react';
import Image from 'next/image';
import { CATEGORIES } from '../lib/categories';
import { INSPIRATION_EXAMPLE } from '../lib/demo-phrases';
// 生活场景照片（Unsplash License，来源见 assets/lifestyle/README.md），不代表任何商品
import commuteSubway from '../assets/lifestyle/commute-subway.jpg';
import livingRoom from '../assets/lifestyle/living-room.jpg';
import outdoorTent from '../assets/lifestyle/outdoor-tent.jpg';

export function AssistantStart({ composer, onBrowse, onPick }: {
  composer: ReactNode;
  onBrowse: () => void;
  onPick: (example: string) => void;
}) {
  return <section className="assistant-start">
    <header><span className="eyebrow">SHOPMATE · 购物灵感与选择</span><h1>今天想买点什么？</h1><p>告诉我你的需求，一起找到合适的商品。</p></header>
    {composer}
    <p className="prototype-caption">Gemini 购物助手 · 先聊需求，再一起挑选</p>
    <section className="inspiration" aria-labelledby="inspiration-title">
      <div className="inspiration-heading"><h2 id="inspiration-title">猜你喜欢</h2><span>编辑精选 · 非个性化</span></div>
      <div className="inspiration-cards">
        <button type="button" className="inspiration-card" onClick={() => onPick(INSPIRATION_EXAMPLE)} aria-label={`把示例需求“${INSPIRATION_EXAMPLE}”填入输入框`}>
          <Image src={commuteSubway} alt="" className="inspiration-photo" sizes="94px" />
          <span><strong>给通勤留一点安静</strong><small>通勤数码 · 可体验</small><em>填入示例需求，可修改后发送 →</em></span>
        </button>
        <article className="inspiration-card unavailable">
          <Image src={livingRoom} alt="" className="inspiration-photo" sizes="94px" />
          <div><strong>让客厅多一点松弛</strong><small>家居生活 · 尚未开放</small><em>购物灵感示意</em></div>
        </article>
        <article className="inspiration-card unavailable">
          <Image src={outdoorTent} alt="" className="inspiration-photo" sizes="94px" />
          <div><strong>周末去山里走走</strong><small>户外出行 · 尚未开放</small><em>购物灵感示意</em></div>
        </article>
      </div>
    </section>
    <button className="browse-categories" onClick={onBrowse}>浏览商品分类 <span>查看支持范围 →</span></button>
  </section>;
}

export function CategoryPicker({ onSelect, onBack }: { onSelect: () => void; onBack: () => void }) {
  return <section className="category-picker" aria-labelledby="category-picker-title">
    <button className="button ghost small" onClick={onBack}>← 返回助手</button>
    <h2 id="category-picker-title">浏览商品分类</h2>
    <p>目前开放耳机选购，其他品类还在准备中。</p>
    <div className="category-options">
      {Object.entries(CATEGORIES).map(([id, category]) => <button key={id} disabled={!category.enabled} onClick={onSelect}>
        <span>{category.label}</span><small>{category.enabled ? '可体验 →' : '尚未开放'}</small>
      </button>)}
    </div>
    <p className="muted">更换选购品类不会删除聊天记录。未开放品类不会生成推荐。</p>
  </section>;
}
