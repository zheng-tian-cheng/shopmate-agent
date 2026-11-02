"""逐步定位 Gemini 请求超时：真实调用，最多 4 次 HTTP 请求，不属于 pytest 回归。

用法（项目根目录，.env 已配置）：.venv/bin/python -m tests.gemini_probe

四步输入相同（用户说“你好”时后端实际发送的内容），每步只比上一步多一个因素，第 4 步就是线上请求。
诊断不发送 X-Server-Timeout，测的是实际耗时，超过线上单次时限会标出；客户端保护时限只在本机等待。
SDK 重试和自动续写都关闭，HTTP 层另有计数，第 5 次请求在发出前被拦下。遇到第一处失败即停止。
只打印配置摘要、耗时、状态码和工具数量，不打印密钥、提示词和回复内容。
"""
import asyncio
import os
import time
import httpx
from google import genai
from google.genai import types
from src import agent_config as config
from src.agent import GeminiModel, error_label, model_input
from src.agent_models import ChatRequest
from src.conditions import empty_state

MAX_HTTP_REQUESTS = 4
CLIENT_GUARD_SECONDS = 120  # 只在本机等待，不发给 Gemini


class HttpBudget:
    """Counts real HTTP requests and refuses any beyond the limit before they are sent."""
    def __init__(self):
        self.sent, self.deadline_header, self.status = 0, None, None

    async def on_request(self, request):
        if self.sent >= MAX_HTTP_REQUESTS:
            raise RuntimeError(f'已达 {MAX_HTTP_REQUESTS} 次 HTTP 请求上限，未发送')
        self.sent += 1
        self.deadline_header, self.status = request.headers.get('x-server-timeout'), None

    async def on_response(self, response):
        self.status = response.status_code


def steps():
    full = GeminiModel.request_config()
    off = dict(automatic_continuation=False)  # SDK 本地开关，不进入请求体
    prompt = dict(system_instruction=full.system_instruction)
    thinking = dict(thinking_config=full.thinking_config, max_output_tokens=full.max_output_tokens)
    return [
        ('1 基准：无配置（同之前的直连测试）', '无', types.GenerateContentConfig(**off)),
        ('2 加系统提示词', '系统提示词', types.GenerateContentConfig(**off, **prompt)),
        ('3 加思考配置', '思考等级 low 与输出上限 3000', types.GenerateContentConfig(**off, **prompt, **thinking)),
        ('4 加工具声明（线上完整配置）', '工具声明', full.model_copy(update=off)),
    ]


def summary(cfg):
    tools = sum(len(t.function_declarations or []) for t in cfg.tools or [])
    mode = cfg.tool_config.function_calling_config.mode.name if cfg.tool_config else '-'
    thinking = cfg.thinking_config.thinking_level.name if cfg.thinking_config else '默认'
    prompt = f'{len(cfg.system_instruction)} 字' if cfg.system_instruction else '无'
    return f'系统提示词 {prompt}｜思考 {thinking}｜输出上限 {cfg.max_output_tokens or "默认"}｜工具 {tools} 个（{mode}）', tools


def explain_failure(e, budget):
    if isinstance(e, TimeoutError):
        return f'客户端保护时限 {CLIENT_GUARD_SECONDS} 秒到期，服务端仍未返回（这个时限只在本机，未发给 Gemini）'
    label = error_label(e)
    if getattr(e, 'code', None) == 504:
        source = f'请求带有 X-Server-Timeout={budget.deadline_header}，是人为设置的截止时间' if budget.deadline_header \
            else '请求未携带 X-Server-Timeout，不是我们设置的截止时间，而是 Google 服务端自身超时或异常'
        return f'{label}：{source}'
    return label


async def main():
    name = config.model_name()
    if name not in config.FREE_FUNCTION_MODELS:
        raise SystemExit('GEMINI_MODEL 不在已核实的免费模型中，诊断不运行。')
    key = os.getenv('GEMINI_API_KEY', '').strip()
    if not key:
        raise SystemExit('未配置 GEMINI_API_KEY：请在项目根目录 .env 中填写后再运行。')
    budget = HttpBudget()
    http = httpx.AsyncClient(timeout=CLIENT_GUARD_SECONDS + 10,
                             event_hooks={'request': [budget.on_request], 'response': [budget.on_response]})
    # 不设 timeout：SDK 不会发送 X-Server-Timeout；attempts=1：不重试
    client = genai.Client(api_key=key, vertexai=False, http_options=types.HttpOptions(
        retry_options=types.HttpRetryOptions(attempts=1), httpx_async_client=http))
    contents = [model_input(ChatRequest(message='你好', state=empty_state(None)))]
    print(f'模型 {name}；线上单次时限 {config.MODEL_REQUEST_TIMEOUT_SECONDS} 秒；本次诊断不发服务端截止时间，客户端保护 {CLIENT_GUARD_SECONDS} 秒')
    results = []
    try:
        for title, added, cfg in steps():
            text, tools = summary(cfg)
            print(f'\n{title}\n  配置：{text}')
            began = time.monotonic()
            try:
                r = await asyncio.wait_for(client.aio.models.generate_content(model=name, contents=contents, config=cfg), CLIENT_GUARD_SECONDS)
            except Exception as e:
                print(f'  [失败] {time.monotonic() - began:.1f} 秒｜HTTP {budget.status or "无响应"}｜服务端截止时间 {budget.deadline_header or "未发送"}')
                print(f'  原因：{explain_failure(e, budget)}')
                if not results:
                    cause = '基准请求本身失败，与 ShopMate 的配置无关（网络、地区或 Google 服务）'
                elif results[0][2] > config.MODEL_REQUEST_TIMEOUT_SECONDS:
                    cause = (f'基准请求已用 {results[0][2]:.1f} 秒，超过线上时限；之后的变慢或超时不能单独归因于新增的“{added}”，'
                             '主因是 Gemini 响应本身很慢')
                else:
                    cause = f'第 {title[0]} 步新增的“{added}”导致失败'
                print(f'\n诊断：{cause}；后续步骤不再请求。')
                return
            seconds = time.monotonic() - began
            c = r.candidates[0] if r.candidates else None
            parts = (c.content.parts or []) if c and c.content else []
            calls = sum(1 for p in parts if p.function_call)
            finish = getattr(c and c.finish_reason, 'name', None)
            over = f'（超过线上 {config.MODEL_REQUEST_TIMEOUT_SECONDS} 秒时限）' if seconds > config.MODEL_REQUEST_TIMEOUT_SECONDS else ''
            print(f'  [通过] {seconds:.1f} 秒{over}｜HTTP {budget.status}｜服务端截止时间 {budget.deadline_header or "未发送"}'
                  f'｜结束原因 {finish}｜声明工具 {tools} 个，模型调用 {calls} 个')
            results.append((title, added, seconds))
        slowest = max(range(1, len(results)), key=lambda i: results[i][2] - results[i - 1][2])
        total = results[-1][2]
        print(f'\n诊断：四步都返回了。线上完整配置不带服务端截止时间时耗时 {total:.1f} 秒；'
              f'耗时增加最多的是第 {slowest + 1} 步“{results[slowest][1]}”'
              f'（+{results[slowest][2] - results[slowest - 1][2]:.1f} 秒）。'
              + ('基准请求就已超过线上时限，主因是 Gemini 响应本身很慢。' if results[0][2] > config.MODEL_REQUEST_TIMEOUT_SECONDS else ''))
    finally:
        await client.aio.aclose()
        await http.aclose()
        print(f'实际 HTTP 请求：{budget.sent} 次（上限 {MAX_HTTP_REQUESTS}）')


if __name__ == '__main__':
    asyncio.run(main())
