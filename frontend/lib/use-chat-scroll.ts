'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { followAfterScroll, followTarget, visibleArea } from './chat-scroll.ts';

// 滚轮、触摸、键盘、拖动滚动条之后这么久内的滚动算用户主动滚动
const USER_SCROLL_MS = 1000;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

type Refs = {
  body: RefObject<HTMLElement | null>;   // 滚动容器
  log: RefObject<HTMLElement | null>;    // 对话记录，子元素 .turn 是每一轮
  header: RefObject<HTMLElement | null>; // 容器顶部的固定栏，最新一轮不能被它挡住
};

// 当前跟随位置（见 followTarget）
function followPosition(box: HTMLElement, { log, header }: Refs): number {
  const logEl = log.current;
  const latest = logEl ? Array.from(logEl.querySelectorAll(':scope > .turn')).at(-1) : undefined;
  if (!logEl || !latest) return box.scrollHeight - box.clientHeight;
  const origin = box.getBoundingClientRect().top - box.scrollTop;
  return followTarget({
    scrollHeight: box.scrollHeight, clientHeight: box.clientHeight,
    latestTop: latest.getBoundingClientRect().top - origin, logBottom: logEl.getBoundingClientRect().bottom - origin,
    topInset: (header.current?.offsetHeight ?? 0) + 8,
  });
}

// 聊天记录自动跟随最新内容。只改消息容器自己的 scrollTop（不用 scrollIntoView），商城页面不会跟着动。
// 对话记录及其后的内容（推荐卡片、比较表、同步按钮，以及以后的流式回复）变高，或容器变矮（键盘弹出、输入框变高）时，
// 仍在跟随就滚到跟随位置。用户上滑看历史时暂停，滚回接近底部或主动发送时恢复。
// active：正在显示对话时为 true；面板关闭、首页、品类选择和调试页不跟随，也不记录滚动位置。
export function useChatScroll(refs: Refs, active: boolean) {
  const following = useRef(true);
  const lastTop = useRef(0);
  const pinnedTop = useRef<number | null>(null); // 自己设置的位置：对应的滚动事件不当作用户操作
  const userMoved = useRef(false);               // 跟随期间用户自己往下滚过（如往下看比较表）
  const userInput = useRef(-Infinity);           // 最近一次用户滚动操作的时间
  const [readingHistory, setReadingHistory] = useState(false);
  const { body, log } = refs;

  function pin(box: HTMLElement, top: number) {
    box.scrollTop = top;
    pinnedTop.current = box.scrollTop;
    userMoved.current = false;
  }
  // 跟随时由这里管理位置，关闭浏览器的滚动锚定：否则最新回复变高时，浏览器为了让下方的比较表不动，会把回复推出视野。
  // 看历史时保留锚定，上方内容变化时阅读位置不跳。
  function setFollowing(box: HTMLElement, value: boolean) {
    following.current = value;
    box.style.overflowAnchor = value ? 'none' : '';
    setReadingHistory(!value);
  }

  useLayoutEffect(() => {
    const box = body.current, start = log.current;
    if (!active || !box || !start) return;
    box.style.overflowAnchor = following.current ? 'none' : '';
    // 面板隐藏期间浏览器不保留滚动位置：回到对话时，跟随中就到跟随位置，否则回到上次阅读的位置
    pin(box, following.current ? followPosition(box, refs) : lastTop.current);
    // 用户没动过就校正到跟随位置（上方内容变短时也不让最新一轮钻到顶部栏下面）；
    // 用户自己往下滚过就只向下跟随，往下看比较表时不会被拉回
    const sizes = new ResizeObserver(() => {
      if (!following.current) return;
      const top = followPosition(box, refs);
      if (userMoved.current ? top > box.scrollTop + 1 : Math.abs(top - box.scrollTop) > 1) pin(box, top);
    });
    // 只观察对话记录及其后的内容：展开顶部的条件面板不会把用户带到底部
    const watch = () => {
      sizes.disconnect();
      sizes.observe(box);
      for (let el: Element | null = start; el; el = el.nextElementSibling) sizes.observe(el);
    };
    const children = new MutationObserver(watch);
    watch();
    children.observe(box, { childList: true });
    return () => { sizes.disconnect(); children.disconnect(); box.style.overflowAnchor = ''; };
    // refs 里都是稳定的 ref 对象
  }, [active, body, log]);

  function onScroll() {
    const box = body.current;
    if (!active || !box) return;
    const previousTop = lastTop.current;
    const ours = pinnedTop.current !== null && Math.abs(box.scrollTop - pinnedTop.current) < 2;
    pinnedTop.current = null;
    lastTop.current = box.scrollTop;
    if (ours) return;
    const byUser = performance.now() - userInput.current < USER_SCROLL_MS;
    if (byUser) userMoved.current = true;
    setFollowing(box, followAfterScroll(following.current, previousTop, box, byUser));
  }
  const noteInput = () => { userInput.current = performance.now(); };
  // 绑定到滚动容器上
  const scrollProps = {
    onScroll,
    onWheel: noteInput,
    onTouchStart: noteInput,
    onTouchMove: noteInput,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => { if (SCROLL_KEYS.has(e.key)) noteInput(); },
    // 直接按在容器上（滚动条或空白处）才算，点里面的按钮不算
    onPointerDown: (e: PointerEvent<HTMLElement>) => { if (e.target === e.currentTarget) noteInput(); },
  };

  // 主动发送消息、点“回到最新消息”：恢复跟随并滚到跟随位置。不在对话页时只恢复跟随，回到对话时再滚动。
  function followLatest(behavior: ScrollBehavior = 'auto') {
    const box = body.current;
    if (!box) return;
    setFollowing(box, true);
    if (!active) return;
    const top = followPosition(box, refs);
    // 平滑滚动的中途位置会触发滚动事件；只在向下滚时使用，向下滚不会被判为用户上滑
    if (behavior === 'smooth' && top > box.scrollTop) box.scrollTo({ top, behavior });
    else pin(box, top);
  }

  return { readingHistory, scrollProps, followLatest };
}

// 手机和平板的浮层助手贴合可视区域（见 visibleArea），通过 CSS 变量调整面板位置和高度。
// 面板变矮后，useChatScroll 观察到容器尺寸变化，会把仍在跟随的对话滚到跟随位置。
export function useVisibleViewport(panel: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const el = panel.current, viewport = window.visualViewport;
    if (!active || !el || !viewport) return;
    const clear = () => { el.style.removeProperty('--assistant-top'); el.style.removeProperty('--assistant-height'); };
    const update = () => {
      const area = visibleArea(viewport);
      if (!area) return clear();
      el.style.setProperty('--assistant-top', `${area.top}px`);
      el.style.setProperty('--assistant-height', `${area.height}px`);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      clear();
    };
  }, [panel, active]);
}
