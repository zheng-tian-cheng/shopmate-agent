'use client';
// 请求中与请求失败的统一展示：加载时不显示“没有结果”，失败时说明原因并可重试。
export function LoadingState({ label }: { label: string }) {
  return <div className="request-state" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorState({ message, onRetry, retryLabel = '重试' }: { message: string; onRetry: () => void; retryLabel?: string }) {
  return (
    <div className="request-state error" role="alert">
      <p>{message}</p>
      <button type="button" className="button outline small" onClick={onRetry}>{retryLabel}</button>
    </div>
  );
}

// 商品数据还没拿到时的整页状态（服务端预取失败时才会出现）
export function ServiceState({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return (
    <div className="service-state">
      <p className="service-logo"><span className="mall-logo-dot" aria-hidden="true" />好物日常</p>
      {error ? <>
        <h1>暂时无法加载商品</h1>
        <p role="alert">{error}</p>
        <p className="muted">本地开发时请先启动 FastAPI 后端（默认 http://127.0.0.1:8000），再点击重新加载。</p>
        <button type="button" className="button dark small" onClick={onRetry}>重新加载</button>
      </> : <LoadingState label="正在加载商品…" />}
    </div>
  );
}
