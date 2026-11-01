import path from 'node:path';
import type { NextConfig } from 'next';

// 商品数据放在项目根目录 data/products.json（前端与第 2 阶段后端共用），
// 需要把 Turbopack 的根目录设为上一级，才能解析 frontend 以外的这个文件。
const config: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.SHOPMATE_API_URL ?? 'http://127.0.0.1:8000'}/api/:path*` }];
  },
  turbopack: { root: path.resolve(process.cwd(), '..') },
};

export default config;
