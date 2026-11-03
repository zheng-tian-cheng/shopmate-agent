"""Scripted SDK responses test orchestration, not Gemini's actual NLU accuracy."""
import asyncio
from copy import deepcopy
import json
import httpx
import pytest
from fastapi.testclient import TestClient
from google.genai import types, errors
from app import app
from src.agent import get_model, run_agent, ChatError, GeminiModel, tool_declarations
from src.agent_models import ChatRequest
from src.conditions import empty_state, update_conditions
from src.tools import PRODUCTS, search_products


def call(name, **args):
    return types.Part(function_call=types.FunctionCall(id='call-' + name, name=name, args=args))


def response(*parts):
    return types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(role='model', parts=list(parts)))])


class ScriptedModel:
    def __init__(self, turns):
        self.turns = iter(turns)
        self.inputs = []
        self.closed = False

    async def generate(self, contents):
        self.inputs.append(deepcopy(contents))
        turn = next(self.turns)
        if isinstance(turn, Exception):
            raise turn
        return turn

    async def close(self):
        self.closed = True


def run(turns, message='想买耳机', state=None, history=None, viewed=None):
    request = ChatRequest(message=message, state=state or empty_state(None), history=history or [], viewedProductId=viewed)
    model = ScriptedModel(turns)
    result = asyncio.run(run_agent(request, model))
    assert model.closed
    return result, model


def change(field='budget', kind='hard', value=300, op='set'):
    return dict(op=op, field=field, kind=kind, value=value)


def done(text='先看看这些。', **args):
    return response(call('respond', text=text, **args))


@pytest.mark.parametrize('message', ['想买耳机', '帮我选一款蓝牙耳机'])
def test_category(message):
    result, _ = run([response(call('select_category', category='headphones')), done('想优先考虑预算，还是佩戴方式？')], message)
    assert result.state.category == 'headphones'


@pytest.mark.parametrize('kind,message', [('hard', '300 元以内'), ('soft', '300 元左右')])
def test_budget(kind, message):
    result, model = run([response(call('select_category', category='headphones')),
                        response(call('update_conditions', changes=[change(kind=kind)])),
                        response(call('search_products')), done()], message)
    assert result.state.conditions[0].kind == kind
    output = model.inputs[-1][-1].parts[0].function_response.response
    if kind == 'hard':
        assert all(m['product']['priceCny'] <= 300 for m in output['matches'])
    else:
        assert any(m['product']['priceCny'] > 300 for m in output['matches'])


def test_scene_is_only_suggestion_and_confirm_forbidden():
    result, _ = run([response(call('select_category', category='headphones')),
        response(call('update_conditions', changes=[change('scene', 'scene', '地铁通勤'), dict(op='suggest', field='anc', kind='hard', value=True, reason='通勤')])),
        response(call('update_conditions', changes=[dict(op='confirm', field='anc')])),
        done('要把主动降噪设为必须条件吗？请在建议中确认。')], '每天坐地铁')
    assert result.state.conditions[1].status == 'suggested'
    assert result.rejected[0].change.op == 'confirm'


def test_budget_update_preserves_other_conditions():
    state = update_conditions(empty_state(), [change(), change('anc', 'hard', True), change('scene', 'scene', '地铁通勤')], 'ui')['state']
    original = deepcopy(state)
    result, _ = run([response(call('update_conditions', changes=[dict(op='update', field='budget', value=200)])), response(call('search_products')), done('预算改为{{budget}}，其他条件不变。')], '预算改成200，其他不变', state)
    assert result.state.model_dump(exclude_unset=True)['conditions'][1:] == original['conditions'][1:]
    assert result.state.conditions[0].value == 200
    assert state == original
    assert '¥200' in result.reply


def test_compare_details_use_source_and_call_ids():
    ids = ['redmi-buds-6', 'oppo-enco-air4']
    result, model = run([response(call('compare_products', product_ids=ids)), done('{{redmi-buds-6.name}}：{{redmi-buds-6.priceCny}}；{{oppo-enco-air4.name}}：{{oppo-enco-air4.battery}}。', product_refs=ids)], '这两款有什么区别？', empty_state())
    assert result.compareIds == ids
    assert '¥199' in result.reply
    assert '单次：降噪关 12 小时' in result.reply
    assert '含充电盒：降噪开 28 小时' in result.reply
    fr = model.inputs[-1][-1].parts[0].function_response
    assert fr.id == 'call-compare_products' and fr.name == 'compare_products'
    assert 'notes' not in json.dumps(fr.response)


@pytest.mark.parametrize('ids', [['imaginary-product'], ['sony-wh-ch720n']])
def test_cannot_recommend_missing_or_over_budget(ids):
    state = update_conditions(empty_state(), [change(value=200)], 'ui')['state']
    result, _ = run([response(call('search_products')), done(recommend_ids=ids), done('这些候选不符合当前条件。')], state=state)
    assert not result.recommendations
    assert any(t.status == 'rejected' for t in result.tools)


def test_empty_search_never_fabricates_candidates():
    state = update_conditions(empty_state(), [change(value=1)], 'ui')['state']
    result, _ = run([response(call('search_products')), done('没有满足条件的商品。')], state=state)
    assert result.matchCount == 0 and result.recommendations == []
    assert result.state.conditions[0].value == 1


@pytest.mark.parametrize('tool,args', [('unknown', {}), ('get_product', {'product_id': 'unknown'}), ('update_conditions', {'changes': 'bad'}), ('search_products', {'budget': 9999})])
def test_invalid_tools_are_rejected(tool, args):
    result, _ = run([response(call(tool, **args)), done('这项操作没有执行。')], state=empty_state())
    assert result.tools[0].status == 'rejected'
    assert result.state.conditions == []


def test_suggestion_cannot_be_laundered_through_set():
    state = update_conditions(empty_state(), [dict(op='suggest', field='anc', kind='hard', value=True, reason='通勤')], 'system')['state']
    result, _ = run([response(call('update_conditions', changes=[change('anc', 'hard', True)])), done('请在界面上确认。')], state=state)
    assert result.state.conditions[0].status == 'suggested'
    assert result.tools[0].status == 'rejected'


@pytest.mark.parametrize('error,code', [(TimeoutError('secret'), 'MODEL_TIMEOUT'), (errors.APIError(429, {'error': {'message': 'secret-key'}}), 'QUOTA_EXHAUSTED'), (errors.APIError(404, {'error': {'message': 'secret-key'}}), 'MODEL_UNAVAILABLE'), (RuntimeError('secret-key'), 'GEMINI_UNAVAILABLE')])
def test_provider_failures_rollback_and_redact(error, code):
    state = empty_state()
    model = ScriptedModel([response(call('update_conditions', changes=[change()])), error])
    with pytest.raises(ChatError) as raised:
        asyncio.run(run_agent(ChatRequest(message='预算三百', state=state), model))
    assert raised.value.code == code
    assert 'secret' not in str(raised.value)
    assert state == empty_state()
    assert model.closed


def test_unsupported_category_does_not_route_to_headphones():
    result, _ = run([response(call('select_category', category='unsupported')), response(call('search_products')), done('目前尚未开放沙发选购。')], '想买沙发')
    assert result.state.category is None and result.recommendations is None
    assert result.tools[1].status == 'rejected'


def test_ambiguous_reference_clarifies_and_history_is_snapshot():
    history = [dict(role='assistant', text='比较这两款。', productRefs=['redmi-buds-6', 'oppo-enco-air4'], viewedProductId='redmi-buds-6')]
    result, model = run([done('你是指 Redmi Buds 6，还是 OPPO Enco Air4？')], '那它的续航怎么样？', empty_state(), history, 'huawei-freebuds-6i')
    assert result.recommendations is None
    payload = json.loads(model.inputs[0][0].parts[0].text)
    assert payload['history'] == history
    assert payload['viewedProductId'] == 'huawei-freebuds-6i'


def test_explicit_model_wins_and_missing_fields_are_not_guessed():
    result, _ = run([response(call('get_product', product_id='redmi-buds-6-pro')), done('{{redmi-buds-6-pro.name}}的续航{{redmi-buds-6-pro.battery}}。')], 'Redmi Buds 6 Pro续航呢', empty_state(), viewed='huawei-freebuds-6i')
    assert '暂未收录' in result.reply
    assert result.productRefs == ['redmi-buds-6-pro']


def test_invented_numeric_claim_is_rejected_then_corrected():
    result, _ = run([response(call('get_product', product_id='redmi-buds-6')), done('Redmi Buds 6 只要99元。'), done('{{redmi-buds-6.name}}价格为{{redmi-buds-6.priceCny}}。')], '多少钱', empty_state())
    assert '¥199' in result.reply and '99元' not in result.reply
    assert result.tools[1].status == 'rejected'


def test_tool_loop_bounded():
    model = ScriptedModel([response(call('search_products'))] * 20)
    with pytest.raises(ChatError) as e:
        asyncio.run(run_agent(ChatRequest(message='推荐', state=empty_state()), model))
    assert (e.value.code, e.value.status) == ('TOOL_PROTOCOL', 502)
    assert len(model.inputs) == 8


def test_sdk_schema_builds_and_no_credentials_in_prompt(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'do-not-disclose')
    assert len(tool_declarations()) == 7  # 第 7 个是 retrieve_evidence（商品证据检索）
    from src.agent_config import SYSTEM_PROMPT
    assert 'do-not-disclose' not in SYSTEM_PROMPT


def test_no_key_and_unverified_models_fail_before_network(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('GEMINI_MODEL', raising=False)
    with pytest.raises(ChatError) as e:
        asyncio.run(GeminiModel().generate([]))
    assert e.value.code == 'NOT_CONFIGURED'
    monkeypatch.setenv('GEMINI_MODEL', 'paid-only-model')
    with pytest.raises(ChatError) as e:
        asyncio.run(GeminiModel().generate([]))
    assert e.value.code == 'MODEL_NOT_ALLOWED'


def test_chat_http_success_and_error_redaction():
    model = ScriptedModel([done('想先看哪类商品？')])
    app.dependency_overrides[get_model] = lambda: model
    try:
        client = TestClient(app)
        r = client.post('/api/chat', json=dict(message='你好', state=empty_state(None)))
        assert r.status_code == 200 and r.json()['mode'] == 'gemini'
        app.dependency_overrides[get_model] = lambda: ScriptedModel([RuntimeError('sk-secret')])
        r = client.post('/api/chat', json=dict(message='你好', state=empty_state()))
        assert r.status_code == 503
        assert r.json()['error']['code'] == 'GEMINI_UNAVAILABLE'
        assert 'sk-secret' not in r.text
        assert client.post('/api/chat', json=dict(message=' ', state=empty_state())).status_code == 422
    finally:
        app.dependency_overrides.clear()


def feedback(model, turn):
    """Function responses the model saw after the given turn (0-based)."""
    return [p.function_response.response for p in model.inputs[turn + 1][-1].parts]


def test_rejections_tell_the_model_why_without_echoing_input():
    result, model = run([response(call('select_category', category='sofa-secret')),
                         response(call('get_product', product_id='redmi-buds-6')), done('Redmi Buds 6 只要九十九元。'),
                         done('{{redmi-buds-6.name}}的价格是{{redmi-buds-6.priceCny}}。')], '多少钱', empty_state())
    schema_error = feedback(model, 0)[0]['error']
    assert 'category' in schema_error and 'sofa-secret' not in schema_error
    assert '占位符' in feedback(model, 2)[0]['error'], '汉字数字的价格也要用占位符'
    assert '¥199' in result.reply and '九十九' not in result.reply


def test_recommendations_follow_service_rank_and_carry_soft_matches():
    state = update_conditions(empty_state(), [change(value=300), change('anc', 'soft', True)], 'ui')['state']
    ranked = None

    class Capture(ScriptedModel):
        async def generate(self, contents):
            nonlocal ranked
            turn = await super().generate(contents)
            if ranked is None and len(self.inputs) == 2:
                ranked = [m['product']['id'] for m in contents[-1].parts[0].function_response.response['matches']]
            if turn is None:
                return done('先看看这几款。', recommend_ids=list(reversed(ranked[:3])))
            return turn
    model = Capture([response(call('search_products')), None])
    result = asyncio.run(run_agent(ChatRequest(message='推荐', state=state), model))
    assert [r.productId for r in result.recommendations] == ranked[:3]
    anc = {p['id']: p['anc'] for p in PRODUCTS}
    assert all(('anc' in r.softMatched) == (anc[r.productId] is True) for r in result.recommendations)


def test_search_before_condition_change_cannot_back_recommendations():
    state = update_conditions(empty_state(), [change(value=300)], 'ui')['state']
    result, _ = run([response(call('search_products')), response(call('update_conditions', changes=[dict(op='update', field='budget', value=150)])),
                     done(recommend_ids=['redmi-buds-6']), done('预算改了，需要重新筛选。')], state=state)
    assert result.tools[2].status == 'rejected' and result.recommendations is None


def test_declared_condition_schema_only_offers_interpreter_operations():
    schema = next(d for d in tool_declarations() if d.name == 'update_conditions').parameters_json_schema
    props = schema['properties']['changes']['items']['properties']
    assert set(props['op']['enum']) == {'set', 'update', 'remove', 'suggest', 'ask'}
    assert set(props['field']['enum']) == {'budget', 'anc', 'wearingStyle', 'scene'}
    assert 'option' not in props


@pytest.mark.parametrize('name', ['gemini-3.8-flash', 'gemini-3.5-flash-lite'])
def test_gemini_request_uses_configured_model_and_lets_it_answer_directly(monkeypatch, name):
    monkeypatch.setenv('GEMINI_API_KEY', 'test-key')
    monkeypatch.setenv('GEMINI_MODEL', name)
    seen = {}

    class Models:
        async def generate_content(self, **kwargs):
            seen.update(kwargs)
            return 'ok'

    class Client:
        aio = type('Aio', (), {'models': Models()})()

        def __init__(self, api_key, vertexai, http_options):
            seen['client_timeout'] = http_options.timeout

    monkeypatch.setattr('src.agent.genai.Client', Client)
    assert asyncio.run(GeminiModel().generate(['hi'])) == 'ok'
    cfg = seen['config']
    assert seen['model'] == name
    assert cfg.tool_config.function_calling_config.mode == types.FunctionCallingConfigMode.AUTO
    assert seen['client_timeout'] == 20000  # 单次请求时限；不靠放大超时掩盖问题
    assert cfg.automatic_function_calling.disable is True
    assert cfg.automatic_continuation is False  # 一次模型调用只发一次 HTTP 请求
    assert cfg.thinking_config.thinking_level == types.ThinkingLevel.LOW
    assert cfg.system_instruction.startswith('你是 ShopMate')
    assert 'test-key' not in json.dumps(cfg.model_dump(mode='json'), ensure_ascii=False)


@pytest.mark.parametrize('error,code,status', [
    (errors.APIError(400, {'error': {'status': 'FAILED_PRECONDITION', 'message': 'User location is not supported for the API use.'}}), 'REGION_UNSUPPORTED', 503),
    (errors.APIError(400, {'error': {'status': 'INVALID_ARGUMENT', 'message': 'API key not valid. Please pass a valid API key.'}}), 'KEY_INVALID', 503),
    (errors.APIError(403, {'error': {'status': 'PERMISSION_DENIED', 'message': 'denied'}}), 'KEY_INVALID', 503),
    (errors.APIError(400, {'error': {'status': 'INVALID_ARGUMENT', 'message': 'bad schema'}}), 'BAD_REQUEST', 502),
    (errors.APIError(500, {'error': {'status': 'INTERNAL', 'message': 'oops'}}), 'GEMINI_UNAVAILABLE', 503),
    (httpx.ConnectError('connection refused'), 'NETWORK', 503),
    (httpx.ReadTimeout('slow'), 'MODEL_TIMEOUT', 504),
    (errors.APIError(504, {'error': {'status': 'DEADLINE_EXCEEDED', 'message': 'Deadline expired before operation could complete.'}}), 'MODEL_TIMEOUT', 504),
])
def test_provider_errors_are_explicit(error, code, status):
    with pytest.raises(ChatError) as raised:
        asyncio.run(run_agent(ChatRequest(message='想买耳机', state=empty_state()), ScriptedModel([error])))
    assert (raised.value.code, raised.value.status) == (code, status)


def test_provider_error_log_redacts_key(monkeypatch, caplog):
    monkeypatch.setenv('GEMINI_API_KEY', 'AIza-do-not-log')
    error = errors.APIError(400, {'error': {'status': 'INVALID_ARGUMENT', 'message': 'API key AIza-do-not-log not valid'}})
    with pytest.raises(ChatError):
        asyncio.run(run_agent(ChatRequest(message='想买耳机', state=empty_state()), ScriptedModel([error])))
    assert 'AIza-do-not-log' not in caplog.text and '***' in caplog.text


def say(text):
    return response(types.Part(text=text))


def test_greeting_ends_in_one_request_without_tools():
    result, model = run([say('你好！我可以帮你挑蓝牙耳机，想先说说预算还是使用场景？')], '你好')
    assert len(model.inputs) == 1
    assert result.reply.startswith('你好') and result.tools == []
    assert result.state.model_dump(exclude_unset=True) == empty_state(None)
    assert result.recommendations is None and result.productRefs == []


def test_plain_text_answers_pass_the_same_fact_checks():
    result, model = run([say('Redmi Buds 6 只要99元。'), response(call('get_product', product_id='redmi-buds-6')),
                         say('{{redmi-buds-6.name}}的价格是{{redmi-buds-6.priceCny}}。')], 'Redmi Buds 6 多少钱', empty_state())
    assert '¥199' in result.reply and '99元' not in result.reply
    assert result.productRefs == ['redmi-buds-6']
    assert '未通过校验' in model.inputs[1][-1].parts[0].text


def test_empty_model_turn_is_not_sent_back():
    empty = types.GenerateContentResponse(candidates=[types.Candidate(
        content=types.Content(role='model', parts=[]), finish_reason=types.FinishReason.MALFORMED_FUNCTION_CALL)])
    result, model = run([empty, say('想先看哪类耳机？')], '你好')
    assert result.reply == '想先看哪类耳机？'
    assert all(c.parts for c in model.inputs[1])


class SlowModel(ScriptedModel):
    async def generate(self, contents):
        await asyncio.sleep(1)


def test_agent_deadline_is_reported_separately_from_model_timeout(monkeypatch):
    from src import agent_config
    monkeypatch.setattr(agent_config, 'AGENT_TIMEOUT_SECONDS', 0.05)
    with pytest.raises(ChatError) as e:
        asyncio.run(run_agent(ChatRequest(message='你好', state=empty_state()), SlowModel([])))
    assert (e.value.code, e.value.status) == ('AGENT_TIMEOUT', 504)


def test_model_facing_schema_is_flat_but_calls_are_still_validated():
    text = json.dumps([d.parameters_json_schema for d in tool_declarations()], ensure_ascii=False)
    for noise in ('$ref', '$defs', 'maxLength', 'maxItems', '"title"', '"null"'):
        assert noise not in text
    result, _ = run([done('好' * 3001), say('请问想看哪类？')], '你好')
    assert result.tools[0].status == 'rejected' and result.reply == '请问想看哪类？'
    result, _ = run([response(call('compare_products', product_ids=['redmi-buds-6'])), say('请再说一款。')], '比较', empty_state())
    assert result.tools[0].status == 'rejected'


def test_request_log_has_timing_and_tool_names_but_no_content(monkeypatch, caplog):
    monkeypatch.setenv('GEMINI_API_KEY', 'AIza-do-not-log')
    caplog.set_level('INFO', logger='shopmate.agent')
    run([response(call('select_category', category='headphones')), done('想先看预算吗？')], '我想买耳机，预算保密')
    assert 'req=1' in caplog.text and 'calls=select_category' in caplog.text and 'calls=respond' in caplog.text
    assert 'result=ok requests=2 tool_calls=2' in caplog.text
    timeout = errors.APIError(504, {'error': {'status': 'DEADLINE_EXCEEDED', 'message': 'Deadline expired'}})
    with pytest.raises(ChatError):
        asyncio.run(run_agent(ChatRequest(message='你好，我的手机号是多少', state=empty_state()), ScriptedModel([timeout])))
    assert 'error=504 DEADLINE_EXCEEDED' in caplog.text and 'result=MODEL_TIMEOUT' in caplog.text
    for secret in ('预算保密', '想先看预算吗', '手机号', 'AIza-do-not-log'):
        assert secret not in caplog.text


def test_live_check_reads_recommendation_objects():
    from tests.live_gemini_check import checks_main_1
    result, _ = run([response(call('select_category', category='headphones'), call('update_conditions', changes=[change()])),
                     response(call('search_products')), done('先看卡片。', recommend_ids=['redmi-buds-6'])], '300 以内')
    r = result.model_dump()
    assert checks_main_1(r, None) == []
    r['recommendations'] = [dict(productId='sony-wh-ch720n', softMatched=[])]
    assert '推荐必须都在 300 元以内' in checks_main_1(r, None)


def test_unmapped_preference_is_rejected_without_breaking_valid_conditions():
    """“600元左右的酷炫动感耳机”：模型把“酷炫动感”误写成 soft 场景。预算照常记为参考预算，已有条件不变，这一项不生效；
    拒绝原因和处理说明在同一轮工具结果里交给模型，不增加请求。"""
    state = update_conditions(empty_state(), [change('anc', 'hard', True)], 'ui')['state']
    expected = search_products(update_conditions(state, [change(kind='soft', value=600)], 'ui')['state'])['matches']
    ids = [m['product']['id'] for m in expected[:3]]
    result, model = run([response(call('update_conditions', changes=[change(kind='soft', value=600), change('scene', 'soft', '酷炫动感')])),
                         response(call('search_products')),
                         done('先按{{budget}}左右找了几款，可以看看下面这些。“酷炫”暂时没法用来筛选，你更在意外观还是听感？', recommend_ids=ids)],
                        '想要一副600元左右的酷炫动感映月耳机', state)
    assert len(model.inputs) == 3, '没有额外的模型请求'
    assert [(c.field, c.kind, c.value) for c in result.state.conditions] == [('anc', 'hard', True), ('budget', 'soft', 600)]
    assert [(r.code, r.reason, r.change.value) for r in result.rejected] == [('invalid', '条件类别与字段不匹配', '酷炫动感')]
    assert result.tools[0].status == 'rejected'
    seen = feedback(model, 0)[0]
    assert seen['rejected'][0]['code'] == 'invalid' and '不能说已记录' in seen['note']
    prices = [p['priceCny'] for i in ids for p in PRODUCTS if p['id'] == i]
    assert prices == sorted(prices, key=lambda v: abs(v - 600)), '参考预算按接近 600 元排序，不是 600 元以内'
    assert all('scene' not in r.softMatched for r in result.recommendations)
    assert result.reply.startswith('先按¥600左右找了几款')


def test_rejections_are_classified_for_users_and_the_model():
    result = update_conditions(empty_state(), [change(value=200000), change('scene', 'soft', '酷炫'), change(value='六百'),
                                               dict(op='update', field='anc', value=True)], 'interpreter')
    assert [(r['code'], r['reason']) for r in result['rejected']] == [
        ('rule', '预算需大于 0 且不超过 100000 元'), ('invalid', '条件类别与字段不匹配'),
        ('invalid', '预算需为数字'), ('invalid', '没有已生效的条件可以修改')]
    body = TestClient(app).post('/api/conditions/apply', json=dict(state=empty_state(), changes=[change('scene', 'soft', '酷炫')], origin='interpreter')).json()
    assert body['rejected'][0]['code'] == 'invalid'


def test_money_placeholders_do_not_double_currency_signs():
    state = update_conditions(empty_state(), [change(kind='soft', value=600)], 'ui')['state']
    result, _ = run([response(call('get_product', product_id='huawei-freebuds-6i')),
                     done('{{huawei-freebuds-6i.name}}只要¥{{huawei-freebuds-6i.priceCny}}元，在你￥{{budget}}元左右的预算内。', product_refs=['huawei-freebuds-6i'])],
                    '这款多少钱', state)
    name = next(p['displayName'] for p in PRODUCTS if p['id'] == 'huawei-freebuds-6i')
    assert result.reply == f'{name}只要¥599，在你¥600左右的预算内。'


def test_rejection_log_has_field_and_code_but_not_user_words(caplog):
    caplog.set_level('INFO', logger='shopmate.agent')
    run([response(call('update_conditions', changes=[change('scene', 'soft', '酷炫动感映月')])), done('外观暂时没法筛选，你更在意什么？')],
        '想要酷炫动感映月耳机', empty_state())
    assert 'rejected=scene:invalid' in caplog.text and '酷炫' not in caplog.text


def test_prompt_keeps_prose_and_cards_apart_and_unmapped_needs_out_of_conditions():
    # 提示词约束（模型是否遵守需要真实模型检查）：正文不罗列卡片商品、占位符前后不重复货币符号、无字段的需求不写进条件
    from src.agent_config import SYSTEM_PROMPT
    for rule in ('正文不要逐个罗列推荐商品和价格', '前后不要再写¥或元', '没有对应字段的需求不写进条件', '不要拆成偏好', '不必每个形容词都追问'):
        assert rule in SYSTEM_PROMPT
