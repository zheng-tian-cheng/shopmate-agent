import { initialSession, reduce, requestChat } from './session.ts';
import type { ShopAction, ShopSession } from './session.ts';

// 会话动作按顺序应用到最新状态。聊天请求可能要等几秒到几十秒，所以在队列外进行：
// 等待期间可以继续浏览、关闭面板、调整列表筛选；结果回来后再排队，应用到那时的最新状态。
// 修改条件、切换品类、重新开始会作废等待中的请求，迟到的结果由 reducer 忽略。
export function createSessionController(
  commit: (session: ShopSession) => void,
  status: (busy: boolean, error?: string) => void,
  reducer: typeof reduce = reduce,
  request: typeof requestChat = requestChat,
) {
  let current = initialSession();
  let queue: Promise<void> = Promise.resolve();
  let active = 0;
  const inFlight = new Set<number>();
  const begin = () => { active++; status(true); };
  const end = () => { active--; status(active > 0); };

  function enqueue(action: ShopAction): Promise<void> {
    queue = queue.then(async () => {
      begin();
      try {
        current = await reducer(current, action);
        commit(current);
      } catch (error) {
        status(active > 1, error instanceof Error ? error.message : '请求失败，请重试');
      } finally { end(); }
    });
    return queue;
  }

  async function chat(requestId: number): Promise<void> {
    await queue; // 先让已排队的动作（如发送这条消息）生效
    const pending = current.assistant.pendingRequest;
    if (!pending || pending.id !== requestId || inFlight.has(requestId)) return; // 已作废或重复触发
    inFlight.add(requestId);
    begin();
    try {
      await enqueue(await request(current, pending));
    } finally {
      inFlight.delete(requestId);
      end();
    }
  }

  return {
    dispatch(action: ShopAction): Promise<void> {
      return action.type === 'textResolved' ? chat(action.requestId) : enqueue(action);
    },
  };
}
