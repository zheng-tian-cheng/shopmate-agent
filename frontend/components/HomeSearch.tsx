'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { catalog } from '../lib/products';
import type { SearchIntent } from '../lib/search-intent';
import { classifySearch } from '../lib/search-intent';
import { useShop } from './ShopProvider';

// 首页搜索：耳机相关的搜索进入耳机列表；未开放品类和没有品类线索的需求就地提示，不自动跳到耳机页面。
export function HomeSearch() {
  const router = useRouter();
  const { dispatch } = useShop();
  const [value, setValue] = useState('');
  const [result, setResult] = useState<Extract<SearchIntent, { kind: 'unavailable' | 'unclear' }> | null>(null);

  function submit() {
    const intent = classifySearch(value, catalog());
    if (intent.kind === 'headphones') {
      setResult(null);
      router.push(`/headphones?q=${encodeURIComponent(intent.query)}`);
      return;
    }
    setResult(intent.kind === 'empty' ? null : intent);
  }

  return <>
    <form className="browse-search" role="search" onSubmit={e => { e.preventDefault(); submit(); }}>
      <span aria-hidden="true">⌕</span>
      <label className="sr-only" htmlFor="mall-search">搜索商品</label>
      <input id="mall-search" name="q" type="search" value={value} onChange={e => { setValue(e.target.value); setResult(null); }} placeholder="搜索蓝牙耳机，如“降噪”“头戴式”" />
      <button type="submit">搜索</button>
    </form>
    {result && <div className="search-notice" role="status">
      {result.kind === 'unavailable'
        ? <><strong>「{result.label}」暂未开放</strong><p>首期只开放蓝牙耳机选购，「{result.query}」所在的品类还在准备中，不会跳到耳机商品。</p></>
        : <><strong>想找哪一类商品？</strong><p>没能从「{result.query}」判断品类。首期只开放蓝牙耳机，其他品类还在准备中；搜索暂不支持自由描述的需求。</p></>}
      <div className="search-notice-actions">
        {result.kind === 'unclear' && <Link className="button outline small" href={`/headphones?q=${encodeURIComponent(result.query)}`}>在蓝牙耳机里搜「{result.query}」</Link>}
        <Link className="button outline small" href="/headphones">看看蓝牙耳机</Link>
        <button type="button" className="button ghost small" onClick={() => { setResult(null); setValue(''); }}>返回</button>
        {result.kind === 'unclear' && <button type="button" className="button ghost small" onClick={() => dispatch({ type: 'openAssistant', entry: 'home' })}>问问 ShopMate</button>}
      </div>
    </div>}
  </>;
}
