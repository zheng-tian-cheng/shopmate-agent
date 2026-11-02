import test from 'node:test';
import assert from 'node:assert/strict';
import { NEAR_BOTTOM_PX, followAfterScroll, followTarget, nearBottom, visibleArea } from '../lib/chat-scroll.ts';

// 容器可视高度 600，内容高度 2000：贴底时 scrollTop = 1400
const box = (scrollTop: number, scrollHeight = 2000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight });

test('距底部不到 80px 算接近底部；内容不足一屏时始终算在底部', () => {
  assert.equal(nearBottom(box(1400)), true);
  assert.equal(nearBottom(box(1400 - NEAR_BOTTOM_PX + 1)), true);
  assert.equal(nearBottom(box(1400 - NEAR_BOTTOM_PX)), false);
  assert.equal(nearBottom(box(0, 300)), true);
});

test('用户向上滑动看历史时暂停跟随', () => {
  assert.equal(followAfterScroll(true, 1400, box(900), true), false);
});

test('滚回接近底部时恢复跟随', () => {
  assert.equal(followAfterScroll(false, 900, box(1350), true), true);
});

test('向下滚动但还没到底部：保持原状（平滑滚向底部途中不会误判为离开底部）', () => {
  assert.equal(followAfterScroll(true, 600, box(900), true), true);
  assert.equal(followAfterScroll(false, 600, box(900), true), false);
});

test('内容变短、浏览器把位置收回到新的底部：仍跟随，不算用户上滑', () => {
  assert.equal(followAfterScroll(true, 1400, box(1000, 1600), false), true);
});

test('浏览器自己调整位置（输入框变矮收回底部、紧接着新消息让内容变长）：不暂停跟随', () => {
  // 发送后输入框变回一行，位置从 616 收回到 596；同一帧里新消息让内容从 1276 变成 1556
  assert.equal(followAfterScroll(true, 616, { scrollTop: 596, scrollHeight: 1556, clientHeight: 680 }, false), true);
  assert.equal(followAfterScroll(true, 616, { scrollTop: 596, scrollHeight: 1556, clientHeight: 680 }, true), false);
});

// 可视高度 600，顶部固定栏占 60
const layout = (latestTop: number, logBottom: number, scrollHeight: number) => ({ scrollHeight, clientHeight: 600, latestTop, logBottom, topInset: 60 });

test('对话记录下方没有其他内容：跟随到底部', () => {
  assert.equal(followTarget(layout(1700, 1980, 2000)), 1400);
});

test('下方有很高的比较表：最新一轮贴着顶部栏显示，比较表接在下面，不把最新一轮挤出视野', () => {
  // 最新一轮 1300–1400，比较表等到 2000；滚到底会让最新一轮落在可视区上方
  assert.equal(followTarget(layout(1300, 1400, 2000)), 1240);
});

test('最新内容比一屏还高（如流式长回复）：跟着对话记录的末尾走', () => {
  assert.equal(followTarget(layout(500, 1500, 2000)), 900);
});

test('内容不足一屏：位置为 0', () => {
  assert.equal(followTarget(layout(100, 300, 400)), 0);
});

test('浮层贴合可视区域：键盘弹出后可视高度变小、视口下移时，面板跟着移动', () => {
  assert.deepEqual(visibleArea({ height: 844, offsetTop: 0, scale: 1 }), { top: 0, height: 844 });
  assert.deepEqual(visibleArea({ height: 503.6, offsetTop: 120.2, scale: 1 }), { top: 120, height: 504 });
});

test('页面被双指缩放时不调整面板；iOS 回弹时的负偏移按 0 处理', () => {
  assert.equal(visibleArea({ height: 400, offsetTop: 200, scale: 2 }), null);
  assert.deepEqual(visibleArea({ height: 844, offsetTop: -12, scale: 1 }), { top: 0, height: 844 });
});
