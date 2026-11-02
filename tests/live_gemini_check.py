"""真实 Gemini 端到端检查（会消耗免费额度，不属于 pytest 回归）。

用法（项目根目录，已在 .env 配置 GEMINI_API_KEY）：
    .venv/bin/python -m tests.live_gemini_check            # 全部 11 轮，轮间默认停 20 秒
    .venv/bin/python -m tests.live_gemini_check --only 1-4 --out live-report.json

直接在进程内调用 run_agent（与 /api/chat 相同的工具循环和规则），按前端的方式传递条件、历史和浏览商品。
每轮打印通过/未通过、回复、工具调用和耗时。自动判定只覆盖结构化结果；回答是否自然仍需人工阅读。
"""
import argparse
import asyncio
import json
import logging
import os
import time
from src import agent_config  # noqa: F401  加载 .env
from src.agent import ChatError, GeminiModel, run_agent
from src.agent_models import ChatRequest
from src.conditions import empty_state
from src.tools import PRODUCTS

PRICE = {p['id']: p['priceCny'] for p in PRODUCTS}


def cond(state, field):
    return next((c for c in state['conditions'] if c['field'] == field), None)


def confirmed(state, field):
    c = cond(state, field)
    return c if c and c['status'] == 'confirmed' else None


def recs_within(r, limit):
    ids = [x['productId'] for x in r.get('recommendations') or []]
    return all(i in PRICE and PRICE[i] is not None and PRICE[i] <= limit for i in ids)


def is_cond(state, field, kind, value=None):
    c = confirmed(state, field)
    return bool(c) and c['kind'] == kind and (value is None or c['value'] == value)


def failures(*pairs):
    return [message for ok, message in pairs if not ok]


# 判定函数：(本轮结果, 发送前的条件) -> 未通过的原因
def checks_main_1(r, before):
    s = r['state']
    return failures((s['category'] == 'headphones', '应识别为耳机品类'),
                    (is_cond(s, 'budget', 'hard', 300), '“300 元以内”应为硬预算 300'),
                    (not confirmed(s, 'anc'), '地铁场景不能自动确认 ANC'),
                    (recs_within(r, 300), '推荐必须都在 300 元以内'))


def checks_main_2(r, before):
    others = lambda st: [c for c in st['conditions'] if c['field'] != 'budget']
    return failures((is_cond(r['state'], 'budget', 'hard', 200), '预算应改为硬预算 200'),
                    (others(r['state']) == others(before), '其他条件应保持不变'),
                    (recs_within(r, 200), '推荐必须都在 200 元以内'))


def checks_compare(r, before):
    return failures((set(r.get('compareIds') or []) == {'redmi-buds-6', 'oppo-enco-air4'}, '应调用比较工具比较这两款'),
                    (r['state'] == before, '比较不应修改条件'))


def checks_ambiguous(r, before):
    asks = '哪' in r['reply'] or '？' in r['reply'] or '?' in r['reply']
    return failures((asks and r['state'] == before, '刚比较过两款，“它”应先澄清是哪一款'))


def kind_is(field, kind, value=None):
    return lambda r, before: failures((is_cond(r['state'], field, kind, value), f'{field} 应为已确认的 {kind}' + (f'（{value}）' if value is not None else '')))


def checks_sofa(r, before):
    return failures((r['state']['category'] is None, '未开放品类不能切到耳机'),
                    (not r.get('recommendations'), '未开放品类不能推荐耳机'))


def checks_price(r, before):
    return failures(('¥199' in r['reply'], '价格应与商品数据一致（¥199）'))


# (编号, 说明, 消息, 起始状态：'chain' 沿用上一轮 / None 无品类 / 'headphones', 浏览商品, 判定)
CASES = [
    (1, '多轮：预算、场景', '我想买耳机，300 元以内，主要坐地铁。', None, None, checks_main_1),
    (2, '多轮：只改预算', '预算改成 200，其他不变。', 'chain', None, checks_main_2),
    (3, '多轮：比较', 'Redmi Buds 6 和 OPPO Enco Air4 有什么区别？', 'chain', None, checks_compare),
    (4, '多轮：不明确指代', '那它的续航怎么样？', 'chain', 'huawei-freebuds-6i', checks_ambiguous),
    (5, '参考预算', '300 元左右', 'headphones', None, kind_is('budget', 'soft', 300)),
    (6, 'ANC 硬条件', '必须支持 ANC', 'headphones', None, kind_is('anc', 'hard', True)),
    (7, 'ANC 偏好', '最好有降噪', 'headphones', None, kind_is('anc', 'soft', True)),
    (8, '排除入耳式', '不要入耳式', 'headphones', None, kind_is('wearingStyle', 'hard', {'exclude': ['入耳式']})),
    (9, '未开放品类', '想买沙发', None, None, checks_sofa),
    (10, '品类识别', '帮我选一款蓝牙耳机', None, None, lambda r, b: failures((r['state']['category'] == 'headphones', '应识别为耳机品类'))),
    (11, '只问价格', 'Redmi Buds 6 多少钱', 'headphones', None, checks_price),
]


def selected(spec):
    if not spec:
        return {c[0] for c in CASES}
    ids = set()
    for part in spec.split(','):
        a, _, b = part.partition('-')
        ids.update(range(int(a), int(b or a) + 1))
    return ids


async def main(args):
    if not os.getenv('GEMINI_API_KEY', '').strip():
        raise SystemExit('未配置 GEMINI_API_KEY：请在项目根目录 .env 中填写后再运行。')
    logging.basicConfig(format='  %(message)s')
    logging.getLogger('shopmate').setLevel(logging.INFO)  # 每次模型请求的序号、耗时和工具名
    wanted = selected(args.only)
    state, history, report = empty_state(None), [], []
    first = True
    for number, title, message, start, viewed, check in CASES:
        if number not in wanted:
            continue
        if not first:
            await asyncio.sleep(args.pause)  # 免费层有每分钟请求数限制
        first = False
        if start != 'chain':
            state, history = empty_state(None if start is None else 'headphones'), []
        before = json.loads(json.dumps(state))
        began = time.monotonic()
        try:
            result = (await run_agent(ChatRequest.model_validate(dict(message=message, state=state, viewedProductId=viewed, history=history)), GeminiModel())).model_dump()
            problems = check(result, before)
            state = result['state']
            history += [dict(role='user', text=message, productRefs=[], viewedProductId=viewed),
                        dict(role='assistant', text=result['reply'], productRefs=result['productRefs'], viewedProductId=viewed)]
            entry = dict(case=number, title=title, message=message, passed=not problems, problems=problems, reply=result['reply'],
                         tools=[f"{t['name']}:{t['status']}" for t in result['tools']], state=state['conditions'],
                         recommendations=[r['productId'] for r in result.get('recommendations') or []], compareIds=result.get('compareIds'))
        except ChatError as e:
            entry = dict(case=number, title=title, message=message, passed=False, problems=[f'{e.code}: {e.message}'])
        entry['seconds'] = round(time.monotonic() - began, 1)
        report.append(entry)
        print(f"\n[{'通过' if entry['passed'] else '未通过'}] {number}. {title}：{message}（{entry['seconds']} 秒）")
        for p in entry['problems']:
            print('  ✗', p)
        if 'reply' in entry:
            print('  回复：', entry['reply'])
            print('  工具：', ' → '.join(entry['tools']))
            print('  推荐：', entry['recommendations'], ' 比较：', entry['compareIds'])
    passed = sum(e['passed'] for e in report)
    print(f'\n共 {len(report)} 轮，自动判定通过 {passed} 轮。回答的自然程度和事实表述请人工阅读上面的回复。')
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(dict(model=agent_config.model_name(), results=report), f, ensure_ascii=False, indent=2)
        print('报告已写入', args.out)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='真实 Gemini 端到端检查（消耗免费额度）')
    parser.add_argument('--only', help='只运行部分编号，如 1-4 或 5,9')
    parser.add_argument('--pause', type=float, default=20, help='每轮之间等待的秒数')
    parser.add_argument('--out', help='把结果写成 JSON 文件')
    asyncio.run(main(parser.parse_args()))
