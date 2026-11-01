'use client';
import { useEffect, useState } from 'react';
export function useRequest<T>(key: string, request: () => Promise<T>) {
  const [result, setResult] = useState<{ key: string; value?: T; error?: string }>({ key: '' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setResult({ key });
    request().then(value => { if (active) setResult({ key, value }); }, error => {
      if (active) setResult({ key, error: error instanceof Error ? error.message : '请求失败，请重试' });
    });
    return () => { active = false; };
    // key contains every input; late results are ignored.
  }, [key, retry]);
  return { value: result.key === key ? result.value : undefined, error: result.key === key ? result.error : undefined,
    retry: () => setRetry(n => n + 1) };
}
