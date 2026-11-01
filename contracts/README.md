# 规则契约

`condition-cases.json` 记录购买条件和结构化筛选的规则用例，是前后端共同遵守的“单一规则来源”。

- **现在（第 2 阶段起）：** 规则由 FastAPI 后端执行：`src/conditions.py`（条件变更）、`src/tools.py`（筛选排序），数据结构用 Pydantic 校验（`src/models.py`）。`tests/test_contracts.py` 直接读取本文件逐条运行。前端只负责展示和发送条件变更，通过 `/api/conditions/apply`、`/api/products/search` 调用后端，不再保留生产用的第二套规则。
- **前端对照：** 原来的 TypeScript 规则冻结在 `frontend/tests/reference/`，只用于前端单元测试的测试替身，以及 `npm run test:api` 中在真实商品上对照 Python 与 TypeScript 的结果是否一致。
- **规则变化时：** 先改这里的用例，再改实现。两边都通过才算完成。

## 数据结构要点

每个条件有三个互相独立的维度：

| 维度 | 取值 |
| --- | --- |
| `kind` 类别 | `hard` 硬约束 / `soft` 软偏好 / `scene` 使用场景；待确认项为 `null`（尚未归类） |
| `status` 状态 | `confirmed` 已生效 / `suggested` 系统建议，未生效 / `pending` 用户表达待澄清，未生效 |
| `source` 来源 | `user` 用户 / `page` 商品列表筛选 / `system` 系统推导 |

条件变更（`op`）及允许的发起方：

| 发起方 `origin` | 允许的操作 |
| --- | --- |
| `interpreter`（固定话术；第 3 阶段为 LLM） | `set` `update` `remove` `suggest` `ask` |
| `ui`（用户点击） | `set` `update` `remove` `confirm` `dismiss` `resolve` |
| `page`（商品列表筛选） | `set` |
| `system`（系统推导，如“找相似款”） | `suggest` |

`confirm`、`dismiss`、`resolve` 只能来自用户点击，解释器不能替用户采纳建议或回答待确认的问题。只有 `confirmed` 的条件参与筛选。

搜索用例中的商品只列出筛选需要的字段，`price` 为数字或 `null`（价格待核验）。
