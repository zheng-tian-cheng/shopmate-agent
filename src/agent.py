"""Bounded Gemini tool loop. Mutations are transactional within a single response."""
import asyncio
from copy import deepcopy
import json
import logging
import os
import re
import time
import uuid
import httpx
from google import genai
from google.genai import types, errors
from pydantic import ValidationError
from . import agent_config as config
from .agent_models import (ChatRequest, ChatResponse, SelectCategory, UpdateConditions,
                           NoArgs, GetProduct, Respond)
from .models import CompareRequest, ConditionState
from .conditions import ALLOWED, FIELDS, update_conditions
from .tools import PRODUCTS, get_product, search_products, compare_products

log = logging.getLogger('shopmate.agent')

TOOL_MODELS = {'select_category': SelectCategory, 'update_conditions': UpdateConditions,
               'search_products': NoArgs, 'get_product': GetProduct,
               'compare_products': CompareRequest, 'respond': Respond}
DESCRIPTIONS = {
    'select_category': '识别用户本轮要买的品类。只有 headphones 开放；unsupported/unclear 不执行耳机选购。',
    'update_conditions': '增量更新购买条件，origin固定为interpreter。支持set/update/remove/suggest/ask。不可代替用户确认建议。',
    'search_products': '使用当前已确认条件查询正式商品，严格硬过滤、软排序。没有参数，不可自行提供或放宽条件。',
    'get_product': '通过准确product_id查询原始参数。用户只问价格时只回答价格。',
    'compare_products': '比较两个不同的正式product_ids，保留续航与重量口径。',
    'respond': '结束本轮并展示推荐卡片或商品引用：text为回复（事实用占位符），recommend_ids为合格推荐ID，product_refs为相关商品ID。读完其他工具结果后单独调用。',
}
SCHEMA_NOISE = {'title', 'default', 'minLength', 'maxLength', 'minItems', 'maxItems'}


def model_schema(schema):
    """Flat schema for Gemini: refs inlined, Optional[X] as X, no titles or length limits.
    Every call is still validated by the Pydantic model, so the limits keep applying."""
    defs = schema.pop('$defs', {})

    def walk(node):
        if isinstance(node, list):
            return [walk(n) for n in node]
        if not isinstance(node, dict):
            return node
        if '$ref' in node:
            return walk(defs[node['$ref'].rsplit('/', 1)[-1]])
        node = {k: {p: walk(s) for p, s in v.items()} if k == 'properties' else walk(v)
                for k, v in node.items() if k not in SCHEMA_NOISE}
        options = [a for a in node.get('anyOf', []) if a != {'type': 'null'}]
        if len(options) == 1:  # omitting an optional field already means None
            node.pop('anyOf')
            node.update(options[0])
        return node
    return walk(schema)


def tool_declarations():
    declarations = []
    for name, model in TOOL_MODELS.items():
        schema = model.model_json_schema()
        # JsonValue is recursive; Gemini only needs the condition value union here.
        if name == 'update_conditions':
            schema['$defs']['Change']['properties']['value'] = {'anyOf': [
                {'type': 'number'}, {'type': 'boolean'}, {'type': 'string'},
                {'type': 'object', 'properties': {'exclude': {'type': 'array', 'items': {'type': 'string', 'enum': ['入耳式', '半入耳式', '头戴式']}}}, 'required': ['exclude']} ]}
            schema['$defs']['Option']['properties']['value'] = schema['$defs']['Change']['properties']['value']
            schema['$defs'].pop('JsonValue', None)
            # Change accepts any string so the contract can reject per item; the model only sees legal choices.
            props = schema['$defs']['Change']['properties']
            props['op'] = {'type': 'string', 'enum': list(ALLOWED['interpreter'])}
            props['field'] = {'type': 'string', 'enum': list(FIELDS)}
            props['kind'] = {'type': 'string', 'enum': ['hard', 'soft', 'scene']}
            props.pop('option')
        declarations.append(types.FunctionDeclaration(name=name, description=DESCRIPTIONS[name], parameters_json_schema=model_schema(schema)))
    return declarations


class ChatError(Exception):
    def __init__(self, code, message, status=502, retryable=True):
        self.code, self.message, self.status, self.retryable = code, message, status, retryable
        super().__init__(message)


class GeminiModel:
    def __init__(self):
        self.client = None
        self.model = config.model_name()

    def connect(self):
        if self.model not in config.FREE_FUNCTION_MODELS:
            raise ChatError('MODEL_NOT_ALLOWED', '此模型尚未核实免费层和工具调用支持，请使用 .env.example 中的模型。', 503, False)
        if self.client is None:
            key = os.getenv('GEMINI_API_KEY', '').strip()
            if not key:
                raise ChatError('NOT_CONFIGURED', '聊天服务尚未配置 Gemini API Key，请在后端 .env 中配置后重启。', 503, False)
            self.client = genai.Client(api_key=key, vertexai=False, http_options=types.HttpOptions(
                timeout=config.MODEL_REQUEST_TIMEOUT_SECONDS * 1000, retry_options=types.HttpRetryOptions(attempts=1)))
        return self.client

    @staticmethod
    def request_config():
        # AUTO: greetings and clarifications may end with one plain-text answer, checked like respond;
        # conditions and recommendation cards still change only through tool calls.
        # automatic_continuation off: one generate call is exactly one HTTP request, so turn limits hold.
        return types.GenerateContentConfig(system_instruction=config.SYSTEM_PROMPT, automatic_continuation=False,
            tools=[types.Tool(function_declarations=tool_declarations())],
            tool_config=types.ToolConfig(function_calling_config=types.FunctionCallingConfig(mode='AUTO')),
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            max_output_tokens=3000, thinking_config=types.ThinkingConfig(thinking_level="low"))

    async def generate(self, contents):
        return await self.connect().aio.models.generate_content(model=self.model, contents=contents, config=self.request_config())

    async def close(self):
        if self.client:
            await self.client.aio.aclose()
            self.client.close()


def get_model():
    return GeminiModel()


def public_product(p):
    # Do not expose internal verification notes as evidence to the model.
    return {k: v for k, v in p.items() if k not in ('notes', 'fieldSources', 'officialLink', 'priceConditions')}


def fact(p, field):
    if field == 'name':
        return p['displayName']
    value = p[field]
    if value is None or value == []:
        return '暂未收录'
    if field == 'priceCny':
        return f'¥{value:g}'
    if field == 'anc':
        return '支持主动降噪' if value else '不支持主动降噪'
    if field == 'battery':
        scope = {'single': '单次', 'total': '含充电盒', 'unspecified': '口径未注明'}
        anc = {'on': '降噪开', 'off': '降噪关', 'unspecified': '降噪状态未注明'}
        text = '；'.join(f"{scope[b['scope']]}：{anc[b['anc']]} {b['hours']:g} 小时" for b in value)
        return text + (f"（{p['batteryConditions']}）" if p['batteryConditions'] else '')
    if field == 'weight':
        scope = {'earbud': '单耳', 'total': '整机', 'unspecified': '未注明单耳或整机'}
        return '；'.join(f"{scope[w['scope']]} {w['grams']:g} g" for w in value)
    if field == 'ancSpec':
        return value + '（标称值，不代表实际降噪效果）'
    return str(value)


FACT_FIELDS = {'name', 'priceCny', 'anc', 'ancSpec', 'wearingStyle', 'battery', 'weight', 'bluetooth'}
PLACEHOLDER = re.compile(r'\{\{([^{}]+)\}\}')
CN_AMOUNT = re.compile(r'[零一二两三四五六七八九十百千万几]+个?\s*(?:元|块|小时|分钟|克|分贝|毫安)')


def render_reply(text, seen, state, matches):
    def replace(m):
        token = m.group(1)
        if token == 'budget':
            c = next((c for c in state['conditions'] if c['field'] == 'budget' and c['status'] == 'confirmed'), None)
            if not c:
                raise ValueError('没有已确认预算')
            return f"¥{c['value']:g}"
        if token == 'matchCount' and matches is not None:
            return str(len(matches))
        product_id, _, field = token.partition('.')
        if product_id not in seen or field not in FACT_FIELDS:
            raise ValueError('事实必须引用本轮工具查询到的商品及支持的字段')
        return fact(get_product(product_id), field)
    # Exact placeholders make numbers/units source-bound, not model-authored.
    prose = PLACEHOLDER.sub('', text)
    for p in PRODUCTS:
        prose = prose.replace(p['displayName'], '').replace(p['model'], '')
    if re.search(r'\d|https?://|www\.', prose) or CN_AMOUNT.search(prose) or '{{' in PLACEHOLDER.sub('', text):
        raise ValueError('商品参数和预算请使用事实占位符，不要自行写数值或链接')
    return PLACEHOLDER.sub(replace, text)


def tool_error(e):
    """Feedback for the model so it can correct itself: rule messages and schema paths, never raw input values."""
    if isinstance(e, ValidationError):
        problems = '；'.join(f"{'.'.join(map(str, x['loc'])) or '参数'}：{x['msg']}" for x in e.errors(include_input=False, include_url=False)[:5])
        return f'参数不符合工具Schema（{problems}）。本次调用未执行，请修正后重试。'
    if isinstance(e, KeyError):
        return '商品不存在。请使用catalog_identity_only中的准确id。本次调用未执行。'
    return f'{e}。本次调用未执行，不要声称已执行。'


def redact(text):
    key = os.getenv('GEMINI_API_KEY', '').strip()
    text = str(text or '')[:300]
    return text.replace(key, '***') if key else text


def provider_error(e):
    detail = f'{e.status or ""} {e.message or ""}'.lower()
    if e.code == 429:
        return ChatError('QUOTA_EXHAUSTED', 'Gemini 免费额度或速率限制已达到，条件未改变。请稍后重试；不会切换收费模型。', 429)
    if e.code in (400, 403) and 'location' in detail:
        return ChatError('REGION_UNSUPPORTED', '当前网络所在地区不支持 Gemini API，条件未改变。请检查网络环境。', 503, False)
    if e.code in (401, 403) or 'api key' in detail or 'api_key' in detail:
        return ChatError('KEY_INVALID', 'Gemini API Key 无效或无权访问该模型，请检查后端 .env 后重启服务。', 503, False)
    if e.code == 404:
        return ChatError('MODEL_UNAVAILABLE', '当前项目无法使用所配置的 Gemini 模型，请检查 GEMINI_MODEL；不会自动切换其他模型。', 503, False)
    if e.code == 400:
        return ChatError('BAD_REQUEST', 'Gemini 拒绝了这次请求，条件未改变。请换一种说法重试。', 502)
    if e.code == 504 or 'deadline' in detail:  # the server enforces our per-request timeout
        return model_timeout()
    return ChatError('GEMINI_UNAVAILABLE', 'Gemini 服务暂不可用，条件未改变，请稍后重试。', 503)


def model_timeout():
    return ChatError('MODEL_TIMEOUT', f'Gemini 单次响应超过 {config.MODEL_REQUEST_TIMEOUT_SECONDS} 秒，条件未改变，请稍后重试。', 504)


def chat_error(e, agent_expired):
    """Map a failure inside the loop to a user-facing error; details go to the server log only."""
    if isinstance(e, ChatError):
        return e
    if isinstance(e, (TimeoutError, httpx.TimeoutException)):
        if agent_expired:
            return ChatError('AGENT_TIMEOUT', f'本次需要多步处理，累计超过 {config.AGENT_TIMEOUT_SECONDS} 秒，条件未改变。请把问题拆短后重试。', 504)
        return model_timeout()
    if isinstance(e, httpx.TransportError):
        log.warning('Gemini network error: %s', type(e).__name__)
        return ChatError('NETWORK', '无法连接 Gemini 服务（网络异常），条件未改变。请检查网络后重试。', 503)
    if isinstance(e, errors.APIError):
        log.warning('Gemini API error %s %s: %s', e.code, e.status, redact(e.message))
        return provider_error(e)
    log.exception('Chat agent failed')  # 细节只进服务端日志，响应不带异常内容
    return ChatError('GEMINI_UNAVAILABLE', '聊天服务暂不可用，条件未改变，请稍后重试。', 503)


def error_label(e):
    """Short, content-free label for request logs."""
    return f'{e.code} {e.status}' if isinstance(e, errors.APIError) else type(e).__name__


def model_input(request: ChatRequest):
    return types.Content(role='user', parts=[types.Part(text=json.dumps({
        'message': request.message, 'state': request.state.model_dump(exclude_unset=True), 'viewedProductId': request.viewedProductId,
        'history': [m.model_dump() for m in request.history],
        'catalog_identity_only': [{'id': p['id'], 'name': p['displayName'], 'model': p['model']} for p in PRODUCTS],
    }, ensure_ascii=False))])


async def run_agent(request: ChatRequest, model):
    original = request.state.model_dump(exclude_unset=True)
    state = deepcopy(original)
    known_ids = {p['id'] for p in PRODUCTS}
    if request.viewedProductId is not None and request.viewedProductId not in known_ids:
        raise ChatError('UNKNOWN_PRODUCT', '当前浏览商品不存在，请返回商品列表。', 422, False)
    seen, applied, rejected, statuses = set(), [], [], []
    matches, comparison = None, None
    blocked_category = False
    contents = [model_input(request)]
    chat_id, requests, calls_used, began = uuid.uuid4().hex[:8], 0, 0, time.monotonic()

    def ms(since):
        return round((time.monotonic() - since) * 1000)

    async def generate():
        nonlocal requests
        requests += 1
        start = time.monotonic()
        try:
            response = await model.generate(contents)
        except Exception as e:
            log.warning('chat=%s req=%d ms=%d error=%s', chat_id, requests, ms(start), error_label(e))
            raise
        candidate = response.candidates[0] if response.candidates else None
        parts = (candidate.content.parts or []) if candidate and candidate.content else []
        usage = response.usage_metadata
        # Metadata only: timing, tool names and token counts, never the user's text or tool arguments.
        log.info('chat=%s req=%d ms=%d finish=%s calls=%s tokens(in/think/out)=%s', chat_id, requests, ms(start),
                 getattr(candidate and candidate.finish_reason, 'name', None),
                 ','.join(p.function_call.name for p in parts if p.function_call) or '-',
                 f'{usage.prompt_token_count}/{usage.thoughts_token_count}/{usage.candidates_token_count}' if usage else '-')
        return candidate, parts

    def finish(text, recommend_ids=(), product_refs=(), tool=None):
        """Validate a final answer (respond or plain text) and build the response; raises ValueError."""
        if blocked_category and (recommend_ids or product_refs):
            raise ValueError('未开放或不明确品类不能推荐耳机')
        rank = {m['product']['id']: i for i, m in enumerate(matches or [])}
        if len(set(recommend_ids)) != len(recommend_ids) or not set(recommend_ids) <= rank.keys():
            raise ValueError('推荐必须来自本轮最新筛选结果，不能绕过硬约束')
        if not set(product_refs) <= seen:
            raise ValueError('商品引用必须经过本轮查询')
        reply = render_reply(text, seen, state, matches)
        # Cards follow the service's ranking; the model only chooses which eligible items to show.
        picks = sorted(recommend_ids, key=rank.__getitem__)
        soft = {m['product']['id']: m['evaluation']['softMatched'] for m in matches or []}
        refs = list(dict.fromkeys([*product_refs, *recommend_ids, *(t.split('.')[0] for t in PLACEHOLDER.findall(text) if '.' in t)]))
        return ChatResponse.model_validate(dict(reply=reply, state=state, applied=applied, rejected=rejected,
            recommendations=[dict(productId=i, softMatched=soft[i]) for i in picks] if matches is not None else None,
            matchCount=len(matches) if matches is not None else None, productRefs=refs,
            compareIds=comparison, tools=statuses + ([dict(name=tool, status='ok')] if tool else []), mode='gemini'))

    async def loop():
        nonlocal state, matches, comparison, calls_used, blocked_category
        for _ in range(config.MAX_MODEL_TURNS):
            candidate, parts = await generate()
            if candidate is None:
                raise ChatError('MODEL_EMPTY', '模型没有返回有效内容，请重试。')
            if parts:
                contents.append(candidate.content)  # preserve thought signatures and call IDs exactly
            calls = [p.function_call for p in parts if p.function_call]
            if not calls:
                text = ''.join(p.text for p in parts if p.text and not p.thought).strip()
                try:
                    if not text:
                        raise ValueError('没有生成有效的工具调用或回复')
                    return finish(text)  # greetings and clarifications end here, in one request
                except ValueError as e:
                    contents.append(types.Content(role='user', parts=[types.Part(text=f'上一条回复未通过校验：{e}。请修正后重新回答；需要查询或修改条件时调用工具。')]))
                continue
            replies = []
            for call in calls:
                calls_used += 1
                if calls_used > config.MAX_TOOL_CALLS:
                    raise ChatError('TOOL_LIMIT', '本次处理步骤过多，条件未改变。请拆成更简短的问题重试。')
                name = call.name
                try:
                    if name not in TOOL_MODELS:
                        raise ValueError('不支持的工具')
                    args = TOOL_MODELS[name].model_validate(call.args or {})
                    if name == 'select_category':
                        blocked_category = args.category != 'headphones'
                        if not blocked_category:
                            state['category'] = 'headphones'
                        else:
                            state = deepcopy(original)
                            applied.clear()
                            rejected.clear()
                            matches, comparison = None, None
                        result = {'category': args.category, 'state': state}
                    elif name == 'update_conditions':
                        if blocked_category:
                            raise ValueError('当前意图不是已开放耳机品类，不能修改耳机条件')
                        changes = [c.model_dump(exclude_unset=True) for c in args.changes]
                        # Existing suggestions/questions require the UI; never launder them through set.
                        locked = {c['field'] for c in state['conditions'] if c['status'] != 'confirmed'}
                        if any(c['field'] in locked and c['op'] in ('set', 'update', 'remove') for c in changes):
                            raise ValueError('建议或待确认项请在界面操作，不能通过文字解析绕过确认')
                        result = update_conditions(state, changes, 'interpreter')
                        state = result['state']
                        applied.extend(result['applied'])
                        rejected.extend(result['rejected'])
                        matches = None  # later changes invalidate earlier recommendations
                    elif name == 'search_products':
                        if blocked_category or state['category'] != 'headphones':
                            raise ValueError('请先明确选择耳机品类')
                        matches = search_products(state)['matches']
                        seen.update(m['product']['id'] for m in matches)
                        result = {'matches': [{'product': public_product(m['product']), 'evaluation': m['evaluation']} for m in matches]}
                    elif name == 'get_product':
                        p = get_product(args.product_id)
                        seen.add(p['id'])
                        result = public_product(p)
                    elif name == 'compare_products':
                        result = {'products': [public_product(p) for p in compare_products(args.product_ids)['products']]}
                        comparison = args.product_ids
                        seen.update(comparison)
                    else:
                        if len(calls) != 1:
                            raise ValueError('respond必须单独调用，在读取完工具结果后执行')
                        return finish(args.text, args.recommend_ids, args.product_refs, tool=name)
                    statuses.append(dict(name=name, status='rejected' if name == 'update_conditions' and result['rejected'] else 'ok'))
                except (ValidationError, ValueError, KeyError) as e:
                    result = {'error': tool_error(e)}
                    statuses.append(dict(name=name if name in TOOL_MODELS else 'unknown', status='rejected', message=result['error']))
                replies.append(types.Part(function_response=types.FunctionResponse(id=call.id, name=call.name, response=result)))
            contents.append(types.Content(role='user', parts=replies))
        raise ChatError('TOOL_PROTOCOL', '模型多次未给出有效的工具调用或回复，条件未改变。请换一种说法重试。', 502)

    deadline = asyncio.timeout(config.AGENT_TIMEOUT_SECONDS)
    outcome = 'ok'
    try:
        async with deadline:
            return await loop()
    except Exception as e:
        error = chat_error(e, deadline.expired())
        outcome = error.code
        raise error from None
    finally:
        log.info('chat=%s result=%s requests=%d tool_calls=%d ms=%d', chat_id, outcome, requests, calls_used, ms(began))
        try:
            await model.close()
        except Exception:
            pass  # Closing a transport must not leak provider error payloads.
