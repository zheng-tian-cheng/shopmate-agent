# ShopMate — AI 交互式购物助手

ShopMate 是一个嵌入模拟电商网站的 AI 选购助手项目，目标是帮助用户表达购物需求、筛选与比较商品，并理解商品参数对实际使用场景的意义。

项目面向多品类，**首轮 MVP 以 15 款蓝牙耳机为演示数据集**，不涉及真实交易。

## 当前进度

- **已完成**：Next.js 响应式商城、商品列表与详情、两款商品比较、ShopMate 聊天界面；FastAPI 商品查询、条件管理与筛选服务，以及前后端集成。
- **已验证**：23 个条件与筛选规则契约用例，并已开展后端、前端、HTTP 集成和浏览器测试。
- **待开发**：LLM 自然语言理解与工具调用、RAG 商品证据问答、完整端到端评测。

目前聊天输入仍以固定规则为主，**尚未接入真实大模型**。

## 技术架构

- **前端**：Next.js，负责商城展示、商品详情、聊天与比较交互。
- **后端**：Python + FastAPI，负责商品查询、条件更新、筛选排序与比较。
- **数据与契约**：`data/products.json` 为统一商品数据源；`contracts/condition-cases.json` 为前后端共用的规则验收用例。

后续由 LLM 理解用户意图并提出结构化操作，FastAPI 校验和执行；RAG 按商品 ID 检索资料，为解释提供证据。

## 本地运行

先在项目根目录启动后端：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app:app --reload --port 8000
```

另开终端启动前端：

```bash
cd frontend
npm ci
npm run dev
```

- 商城：http://localhost:3000
- API 文档：http://127.0.0.1:8000/docs

## 测试

```bash
# 项目根目录：后端与规则契约
.venv/bin/python -m pytest -q

# frontend/ 目录：前端与集成测试
npm test
npm run typecheck
npm run test:api
```

`test:api` 需要后端已启动。

## 项目文档

- [产品需求文档 PRD V0.8](docs/ShopMate_PRD_V0.8.md)
- [竞品分析报告](docs/ShopMate_竞品分析报告_V1.0.md)
- [商品数据核验清单](docs/商品数据核验清单.md)

> 本项目为非商业原型，商品价格取自固定演示数据集，并非实时售价；部分商品图片为示意素材。