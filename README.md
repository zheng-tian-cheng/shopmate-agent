# ShopMate — AI 购物决策助手

**AI Agent MVP 原型｜自然语言选购｜商城协作｜商品证据问答**

![ShopMate 模拟商城与 AI 购物助手](docs/images/shopmate-overview.png)

*实际运行界面：左侧为模拟商城，右侧为 AI 助手与推荐卡片。商品图片及价格用于演示。*

## 项目概述

用户选购商品时，往往能够说出预算和使用场景，却不容易判断哪些参数重要、不同商品有什么区别。传统筛选页适合执行明确条件，AI 问答则可能遗漏使用限制或误读宣传数据。

**ShopMate** 将对话助手嵌入模拟商城，支持用户用自然语言表达购买需求、筛选与比较候选商品，并在需要时查询官方资料，解释商品功能与参数。首期以 **15 款蓝牙耳机**构建可运行原型，不涉及真实交易。

## 产品体验

以「**想买 300 元以内的蓝牙耳机，主要用于通勤**」为例，用户可以：

1. **提出需求：** 在聊天框输入预算和用途，查看助手识别的购物条件。
2. **浏览候选：** 按已生效的条件筛选商品，查看价格、基础参数和推荐卡片。
3. **比较商品：** 从商城或助手中选择两款商品，并排查看已收录参数。
4. **查证疑问：** 对兼容性、功能限制、降噪指标等问题追问，查看带官网来源的解释。
5. **自主同步：** 确认后将助手中的可同步筛选条件应用到商城页面。

这里的「使用场景」并不自动等于硬性筛选条件。例如仅输入「地铁通勤」，不代表系统已经能稳定推导出「必须主动降噪」。

## 关键产品设计

| 设计重点 | 方案及考虑 |
| --- | --- |
| **自然语言与规则筛选结合** | 模型负责理解需求、选择工具；已确认的预算上限等条件由后端规则执行，商品价格与结构化参数从数据中读取，减少随意生成商品信息的风险。 |
| **助手嵌入商城，而非替代商城** | 用户既能正常浏览、筛选和比较，也能在对话中调整条件；助手与商城的筛选状态通过用户确认进行同步，避免对话直接改动正在浏览的列表。 |
| **商品参数与证据解释分工** | 已收录规格直接通过商品工具查询；遇到编码兼容、测试口径等问题，再按具体型号检索官网资料并展示来源。证据用于解释，不直接决定推荐排序。 |

**实现方式：** Next.js + FastAPI + Gemini 函数调用；RAG 采用官网 HTML 结构化切分、Gemini Embedding 与 FAISS，并支持按商品组织检索结果。

## 从问题发现到迭代验证

原始版本曾把某耳机的「**27dB 平均降噪深度**」误解释为「最大值」。为降低这类事实错误，项目建立固定测试用例，并比较三种证据检索方案：普通切分、DOM 结构化切分，以及加入 BM25 + RRF 的混合检索。

实验中，结构化切分显著改善了证据召回，而混合检索没有体现相应的回答收益，因此选择较简洁的结构化向量检索，并进一步调整规格分组与跨商品证据组织。

| 验证结果 | 改进前 | 改进后 |
| --- | ---: | ---: |
| **Recall@5**（17 道固定检索查询） | 0.588 | **0.912** |
| **降噪参数解释用例得分** | 2/6 | **5/6** |

这一轮完成了**发现问题 → 对照选型 → 产品集成 → 回归验证**的迭代。当前原型已支持基本选购操作和有来源的商品问答，但复杂多商品购买建议仍不稳定；以上为小规模固定用例结果，不等同于用户体验或交易效果已得到验证。

<p align="center">
  <img src="docs/images/shopmate-rag.png" width="420" alt="ShopMate 商品证据问答局部截图：回答中标注引用编号，下方展开官网依据来源">
</p>

*商品证据问答局部截图：回答中标注引用编号，下方可展开查看官网依据来源。*

## 本地模型适配与部署

在 Gemini 基础上接入 Ollama，支持通过环境变量切换云端模型与本地 Qwen 模型，复用原有商品工具和业务校验逻辑。

测试发现，小模型在复杂工具调用中容易出现参数格式错误、重复调用及任务终止失败。因此，尝试简化 Prompt、动态工具选择和参数标准化，并通过 Structured Output 将预算解析与后端业务执行分离。

在 Apple M1、8GB 统一内存环境下完成 Docker 后端部署，验证 Linux ARM64 容器与宿主机 Ollama 的通信。结构化输出实验成功识别 300 元预算上限，并从 15 款商品中筛选出 9 款候选商品。

- Gemini 仍为默认模型，原有 Agent 回归测试通过 54 项。
- 本地模型的完整自主工具调用仍不稳定，结构化输出工作流暂为独立实验。
- RAG Embedding 仍使用 Gemini API，尚未实现完全离线运行。

## 本地模型选型实验

使用 10 道固定预算解析题，对比不同模型规模和量化方案的实际表现。测试覆盖预算上下限、价格区间、软性偏好、口语数字及条件变更。本地模型使用相同的 Prompt、JSON Schema 和推理配置。

| 模型 | 量化方案 | 正确率 | 平均请求延迟 |
| --- | --- | ---: | ---: |
| Qwen3 1.7B | Q4_K_M | 50%（5/10） | 0.706s |
| Qwen3 4B | Q4_K_M | 70%（7/10） | 3.403s |
| Qwen3 1.7B | Q8_0 | 70%（7/10） | 1.411s |

在本次测试中，1.7B Q8 与 4B Q4 的正确率相同，但前者响应延迟更低，因此将其作为后续本地部署的候选模型。

作为云端参考，Gemini 3.5 Flash-Lite 首轮完成 5/10 道题，经重试后完成 9/10 道题，返回的 9 个有效答案均正确。

三个本地模型均通过 JSON 格式校验，但在预算下限和条件变更等场景中仍存在语义理解错误。

以上为小规模业务测试，平均延迟包含首次请求的潜在模型加载开销，结果仅作为初步模型选型依据。

[评测脚本](experiments/model_budget_eval.py) · [原始实验记录](experiments/model_eval/) · [结构化输出实验](experiments/ollama_budget_demo.py)

### Docker 后端部署

在已安装 Docker Desktop 与 Ollama 的 macOS 环境中：

```bash
ollama pull qwen3:1.7b

docker build -t shopmate-backend:v1 .

docker run -d \
  --name shopmate-backend \
  -p 127.0.0.1:8001:8000 \
  -e LLM_PROVIDER=ollama \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  shopmate-backend:v1
```

API 文档：http://localhost:8001/docs

验证容器内的结构化预算筛选：

```bash
docker exec -i shopmate-backend python - \
  < experiments/ollama_budget_demo.py
```

复现本地模型评测：

```bash
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen3:1.7b \
.venv/bin/python -m experiments.model_budget_eval
```

以上 Docker 配置用于本地部署实验，仅容器化后端，前端和 Ollama 独立运行。

## 本地体验

需要 Python 3.11+、Node.js 22.18+ 及 Gemini API Key。

**终端 1：后端（项目根目录）**

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-rag.txt
cp .env.example .env   # 在 .env 中填写 GEMINI_API_KEY
.venv/bin/python -m uvicorn app:app --reload --port 8000
```

**终端 2：前端**

```bash
cd frontend
npm ci
npm run dev
```

访问 **http://localhost:3000**。商品浏览和结构化比较不依赖 Gemini；证据检索所需的官网原始资料未随仓库公开。启用 RAG 前，需按照 [`sources_manifest.json`](data/rag/sources_manifest.json) 准备本地资料，再运行 `.venv/bin/python -m src.evidence --build` 建立向量缓存。

## 更多项目资料

- [PRD V0.9（修订草案）](docs/ShopMate_PRD_V0.9.md)：产品目标、功能范围与交互流程
- [竞品分析](docs/ShopMate_竞品分析报告_V1.0.md)：场景研究及设计依据
- [产品质量评测与迭代总结](docs/ShopMate_产品质量评测与迭代总结.md)：测试结果与改进过程
