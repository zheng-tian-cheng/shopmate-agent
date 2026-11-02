"""TEST ONLY: explicit deterministic model substitute for browser/HTTP regressions.
Run uvicorn tests.browser_app:app on a separate port. No Gemini credentials read.
This proves UI/tool integration, never real-model NLU.
"""
import json
from google.genai import types
from app import app
from src.agent import get_model


def call(name, **args):
    return types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(role='model', parts=[types.Part(function_call=types.FunctionCall(id='fixture-' + name, name=name, args=args))]))])


class BrowserModel:
    def __init__(self):
        self.turns = None
        self.index = 0

    async def generate(self, contents):
        if self.turns is None:
            data = json.loads(contents[0].parts[0].text)
            text, state = data['message'], data['state']
            changes, select = [], state['category'] is None
            def set_(field, kind, value):
                changes.append(dict(op='set', field=field, kind=kind, value=value))
            if text in ('300 元以内，地铁通勤，需要主动降噪', '我想买耳机，300 元以内，主要坐地铁。', '300 元以内的地铁通勤耳机'):
                set_('budget', 'hard', 300)
                set_('scene', 'scene', '地铁通勤')
                if text == '300 元以内，地铁通勤，需要主动降噪':
                    set_('anc', 'hard', True)
                else:
                    changes.append(dict(op='suggest', field='anc', kind='hard', value=True, reason='地铁环境噪音较大'))
            elif text in ('预算降到 200 元，其他不变', '预算改成 200，其他不变。'):
                changes.append(dict(op='update', field='budget', value=200))
            elif text == '不要入耳式，其他不变':
                set_('wearingStyle', 'hard', {'exclude': ['入耳式']})
            elif text == '我每天坐地铁通勤':
                set_('scene', 'scene', '地铁通勤')
                changes.append(dict(op='suggest', field='anc', kind='hard', value=True, reason='地铁环境噪音较大'))
            elif text == '300 元左右，最好有降噪':
                set_('budget', 'soft', 300)
                set_('anc', 'soft', True)
            elif text in ('Redmi Buds 6 和 OPPO Enco Air4 有什么区别？', 'compare-fixture'):
                self.turns = [call('compare_products', product_ids=['redmi-buds-6', 'oppo-enco-air4']), call('respond', text='{{redmi-buds-6.name}}的价格是{{redmi-buds-6.priceCny}}，{{oppo-enco-air4.name}}的价格是{{oppo-enco-air4.priceCny}}。', product_refs=['redmi-buds-6', 'oppo-enco-air4'])]
            elif text == '那它的续航怎么样？':
                self.turns = [call('respond', text='你是指 Redmi Buds 6 还是 OPPO Enco Air4？')]
            elif text == '想买沙发':
                self.turns = [call('select_category', category='unsupported'), call('respond', text='沙发选购尚未开放，目前只有蓝牙耳机。')]
            elif '续航' in text or '降噪怎么样' in text:
                product_id = 'redmi-buds-6s' if 'Redmi Buds 6S' in text else data['viewedProductId']
                field = 'battery' if '续航' in text else 'ancSpec'
                self.turns = [call('get_product', product_id=product_id), call('respond', text='{{' + product_id + '.name}}：{{' + product_id + '.' + field + '}}。', product_refs=[product_id])]
            if self.turns is None:
                self.turns = ([call('select_category', category='headphones')] if select else []) + ([call('update_conditions', changes=changes)] if changes else [])
                if any(c['field'] != 'scene' and c['op'] in ('set', 'update') for c in changes):
                    self.turns.append(call('search_products'))
                    self.turns.append(None)  # respond from actual search output below
                else:
                    self.turns.append(call('respond', text='已记下通勤场景。要把主动降噪设为必须条件吗？请在建议中确认。'))
        turn = self.turns[self.index]
        self.index += 1
        if turn is None:
            result = contents[-1].parts[0].function_response.response
            matches = result['matches']
            return call('respond', text='按当前条件，先看看这几款。' if matches else '没有满足条件的商品，不会自动放宽条件。', recommend_ids=[m['product']['id'] for m in matches[:3]])
        return turn

    async def close(self):
        pass


app.dependency_overrides[get_model] = BrowserModel


@app.get('/api/test-mode')
def test_mode():
    return {'model': 'fixture', 'notice': 'Deterministic test model; not Gemini'}
