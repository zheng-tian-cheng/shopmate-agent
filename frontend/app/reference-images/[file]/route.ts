// 未授权的本地参考商品图：只在本地开发（next dev）且 NEXT_PUBLIC_IMAGE_MODE=local 时提供，
// 其他情况（生产构建、公开部署、公开模式）一律 404。文件放在不提交到仓库的 frontend/reference-images/。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  if (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_IMAGE_MODE !== 'local') {
    return new Response('Not found', { status: 404 });
  }
  const { file } = await params;
  const match = file.match(/^[a-z0-9-]+\.(jpg|jpeg|png|webp)$/);
  if (!match) return new Response('Not found', { status: 404 });
  try {
    const data = await readFile(path.join(process.cwd(), 'reference-images', file));
    return new Response(data, { headers: { 'Content-Type': TYPES[match[1]], 'Cache-Control': 'no-store' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
