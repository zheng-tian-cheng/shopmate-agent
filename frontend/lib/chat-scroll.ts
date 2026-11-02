// 聊天记录自动跟随与浮层贴合可视区域的判断规则（纯函数）。界面接线见 use-chat-scroll.ts。

export const NEAR_BOTTOM_PX = 80;

export type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

export function nearBottom(box: ScrollBox): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
}

// 一次滚动事件之后是否继续跟随最新内容：回到接近底部就恢复；只有用户自己向上滚动（在看历史）才暂停；
// 其余情况保持原状：平滑滚向底部的途中、浏览器自己调整位置（如输入框变矮时收回底部、紧接着内容又变长）都不暂停。
export function followAfterScroll(following: boolean, previousTop: number, box: ScrollBox, byUser: boolean): boolean {
  if (nearBottom(box)) return true;
  return byUser && box.scrollTop < previousTop ? false : following;
}

// 跟随时滚到的位置（均为容器内容坐标）。通常就是底部；但对话记录下面还有比较表、同步按钮等内容时，
// 最多滚到最新一轮贴着顶部固定栏（topInset）的位置，不把最新一轮挤出视野；
// 对话记录的末尾总要可见，所以最新内容比可视区还高时（如以后的流式长回复）跟着末尾走。
export type FollowLayout = { scrollHeight: number; clientHeight: number; latestTop: number; logBottom: number; topInset: number };

export function followTarget(layout: FollowLayout): number {
  const bottom = layout.scrollHeight - layout.clientHeight;
  const keepLatest = Math.max(layout.latestTop - layout.topInset, layout.logBottom - layout.clientHeight);
  return Math.max(0, Math.min(bottom, keepLatest));
}

export type Viewport = { height: number; offsetTop: number; scale: number };

// 浮层助手应占据的可视区域。手机虚拟键盘弹出时，iOS Safari 和 Android Chrome 默认只缩小可视视口，
// 固定定位的面板仍按整屏布局，输入框和最新消息会被键盘盖住。页面被双指缩放时不调整，返回 null。
export function visibleArea(viewport: Viewport): { top: number; height: number } | null {
  if (Math.abs(viewport.scale - 1) > 0.01) return null;
  return { top: Math.max(0, Math.round(viewport.offsetTop)), height: Math.round(viewport.height) };
}
