# ShopMate — AI 交互式购物助手

嵌入模拟电商商城的购物助手，首轮使用 15 款蓝牙耳机，不提供真实交易。

## 当前进度

- Next.js 商城、详情、比较、桌面非模态侧栏和手机全屏聊天已接入 FastAPI。
- Python 独立执行条件更新、硬过滤与软排序；只读取 `data/products.json` 的 `products`，保留 `reserve`、null 和分口径参数。
- 已实现 Gemini 工具调用与 `/api/chat`；自由输入不再经过固定话术解析。系统提示词和工具定义在 `src/agent_config.py`、`src/agent.py`。
- **尚未进行真实 Gemini 调用**：未配置用户密钥。自动化 Agent 测试使用模拟 SDK 输出，只验证工具循环与规则护栏，不能据此宣称真实模型的理解准确率；配置密钥后用下文的真实模型检查记录实际表现。
- 未开发 RAG、评测采集、登录、持久化会话、新品类或交易功能。

## 配置与运行

Python 3.11+，Node 22.18+。在项目根目录：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# 自行编辑 .env，填入 GEMINI_API_KEY；不要把密钥放在聊天或前端环境变量中
.venv/bin/python -m uvicorn app:app --reload --port 8000
```

`.env` 只由后端加载，已加入 `.gitignore`。配置 `GEMINI_MODEL=gemini-3.8-flash` 或 `gemini-3.5-flash-lite`（名单外的模型会被拒绝），使用官方 `google-genai==2.34.0`。
2026-11-01 核对的[模型说明](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)支持 Function Calling，[定价页](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash)列有免费层。2026-11-02 核对 [gemini-3.5-flash-lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)：稳定版，支持 Function Calling 和思考等级 low，免费层不收费。
请使用**未启用计费的免费项目**；SDK 无法从 API Key 判断项目计费层级。免费层的请求内容可能被 Google 用于改进产品，不要在聊天中输入个人信息。代码只允许已核实的模型，不切换模型、不启用付费服务。

另开终端：

```bash
cd frontend
npm ci
npm run dev
```

商城 http://localhost:3000；接口文档 http://127.0.0.1:8000/docs。
浏览器通过 Next.js `/api` 同源代理连接后端，手机使用电脑的局域网地址即可。后端地址变化时，在启动 Next.js 前设置 `SHOPMATE_API_URL`；直接跨域访问的来源可通过后端 `CORS_ORIGINS` 配置。

体验：“我想买耳机，300 元以内，主要坐地铁。”→ 在建议中确认 ANC →“预算改成 200，其他不变。”→“Redmi Buds 6 和 OPPO Enco Air4 有什么区别？”→“那它的续航怎么样？”（不明确时应澄清）。
没有密钥时商品浏览、筛选、条件按钮和比较仍可使用，聊天提示未配置，不会偷偷退回 Mock。

## API 与边界

| 接口 | 行为 |
| --- | --- |
| `GET /api/products` | 正式商品与参数来源 |
| `GET /api/products/{id}` | 完整商品，未知/备用 ID 返回 404 |
| `POST /api/products/search` | 根据已确认状态筛选排序 |
| `POST /api/conditions/apply` | 逐条应用或拒绝变更，返回原因 |
| `POST /api/products/compare` | 返回两款完整商品，保留续航/重量口径 |
| `POST /api/chat` | Gemini 理解、工具执行及最终回复 |

聊天请求：`{message, state, viewedProductId, history:[{role,text,productRefs,viewedProductId}]}`。
成功返回：`{reply,state,applied,rejected,recommendations:[{productId,softMatched}],matchCount,productRefs,compareIds,tools,mode}`；卡片理由由前端按已生效条件生成。
失败返回 `{error:{code,message,retryable}}`，条件不变：请求格式 422；额度/速率 `QUOTA_EXHAUSTED` 429；未配置 `NOT_CONFIGURED`、密钥 `KEY_INVALID`、地区 `REGION_UNSUPPORTED`、模型 `MODEL_UNAVAILABLE`、网络 `NETWORK` 503；单次模型请求超过 20 秒 `MODEL_TIMEOUT`、整轮累计超过 45 秒 `AGENT_TIMEOUT` 504；模型多次未给出有效工具调用或回复 `TOOL_PROTOCOL` 502。后端控制台逐次记录模型请求的序号、耗时、结束原因、工具名、token 数和脱敏错误码，不记录密钥和用户内容。

工具直接调用现有 Python 函数，不发内部 HTTP。函数调用模式为 AUTO：问候、澄清可直接用文字一次结束（同样经过事实校验），修改条件和推荐卡片只能通过工具；最多 8 次模型请求、12 次工具调用；工具被拒时把原因返回模型修正。解析器不能确认建议，卡片只能引用最新合格结果，顺序按后端排序。商品事实使用经校验的占位符，由服务端从 JSON 填入；内部核验 notes 不作为评测证据。开放式文字的语义正确性仍需真实模型评测，不能保证零幻觉。
会话仅保存在当前页面内存，切换页面保留，刷新清空；等待回复时可继续浏览和调整列表，修改条件会作废等待中的回复。未来 RAG 可复用工具循环、状态契约、商品 ID 上下文及错误处理，再新增证据检索工具。

## 测试

```bash
.venv/bin/python -m pytest -q
cd frontend
npm test
npm run typecheck
npm run build
npm run test:api   # 需运行普通 FastAPI；不调用 Gemini
```

共享 JSON 的 12 个 applyCases、11 个 searchCases 由 pytest 逐条读取。旧 TypeScript 规则仅冻结在 `frontend/tests/reference/` 作为对照；前端测试因 HTTP 异步化改用 await、值相等断言及工具状态，保留原场景。

无密钥聊天 HTTP/浏览器回归使用**独立的测试模型服务**（不用于真实聊天）：

```bash
# 终端一，项目根目录
.venv/bin/python -m uvicorn tests.browser_app:app --port 8003
# 终端二，frontend/；独立目录避免影响正在运行的开发服务器
NEXT_DIST_DIR=.next-check SHOPMATE_API_URL=http://127.0.0.1:8003 npm run build
NEXT_DIST_DIR=.next-check SHOPMATE_API_URL=http://127.0.0.1:8003 npm run start -- --port 3002
# 终端三，frontend/
SHOPMATE_API_URL=http://127.0.0.1:8003 npm run test:chat
BASE_URL=http://127.0.0.1:3002 npm run check:browser
```

浏览器脚本使用本机 Chrome，并检查测试服务标记，防止回归测试误用真实额度。

真实模型检查（**消耗免费额度**，不属于回归测试；共 11 轮，轮间默认停 20 秒）：

```bash
.venv/bin/python -m tests.live_gemini_check --out live-report.json   # 可用 --only 1-4 只跑多轮对话
```

自动判定只看结构化结果（品类、条件类型、推荐是否超预算、是否比较、是否澄清）；回复是否自然需人工阅读。模型理解、项目可用性和实际延迟尚待记录。

请求超时排查（真实调用，最多 4 次请求）：逐步加入系统提示词、思考设置和工具声明，第一处失败即停止。

```bash
.venv/bin/python -m tests.gemini_probe
```

## 项目文档

- [PRD V0.8](docs/ShopMate_PRD_V0.8.md)
- [规则契约](contracts/README.md)
- [商品数据核验](docs/商品数据核验清单.md)
- [竞品分析](docs/ShopMate_竞品分析报告_V1.0.md)

价格来自固定演示数据集，并非实时售价；部分图片为演示示意。图片许可与映射仍在前端，不经过 Gemini。
