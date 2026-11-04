"""ShopMate 评测（B0/B1/B2）：用真实 Gemini 运行固定题目并保存完整记录，人工评分后汇总。不属于 pytest 回归。

用法（项目根目录，已在 .env 配置 GEMINI_API_KEY）：
    .venv/bin/python -m tests.eval_run run --version B0                 # 9 项各 1 次，消耗免费额度
    .venv/bin/python -m tests.eval_run run --version B0 --repeat 3      # 每项 3 次
    .venv/bin/python -m tests.eval_run run --resume eval/runs/B0-...    # 只补跑环境/API 故障和未运行的项
    .venv/bin/python -m tests.eval_run summary eval/runs/B0-... [eval/runs/B1-...]

题目、初始状态和 T01 的模拟用户规则见 eval/cases.json。与 live_gemini_check 相同，在进程内调用 run_agent
（与 /api/chat 相同的工具循环和校验），按前端的方式拼历史；另外记录工具参数、模型原文、校验退回、Token 和模型实际版本。
每次运行写入 eval/runs/<版本>-<时间>/：run.json 是完整记录，review.md 供阅读，scores.csv 由评审填写，summary 读取后汇总。
"""
import argparse
import asyncio
import csv
from copy import deepcopy
from datetime import datetime
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import time
from google import genai
from src import agent_config as config
from src.agent import ChatError, GeminiModel, error_label, run_agent
from src.agent_models import ChatRequest
from src.conditions import update_conditions
from src.tools import PRODUCTS, search_products
from tests.live_gemini_check import PRICE, cond, is_cond

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / 'eval/cases.json').read_text(encoding='utf-8'))
START = CASES['start']
ITEMS = {**{c['id']: dict(c, group='agent') for c in CASES['agent']},
         **{c['id']: dict(c, group='qa') for c in CASES['qa']},
         CASES['task']['id']: dict(CASES['task'], group='task')}
GROUPS = {'agent': 'Agent', 'qa': '商品问答', 'task': '完整购物任务'}
STATUS = {'ok': '已完成', 'product_error': '产品运行失败', 'env_error': '环境/API 故障'}
NAME = {p['id']: p['displayName'] for p in PRODUCTS}
HASHED = ('eval/cases.json', 'data/products.json', 'src/agent_config.py', 'src/agent.py', 'src/conditions.py', 'src/tools.py',
          'src/agent_models.py', 'src/evidence.py', 'experiments/rag/corpus.py', 'experiments/rag/retrieval.py', 'data/rag/sources_manifest.json')
# RAG 专项文档 4.1 中 RAG-01/03/04 的必要来源（RAG-02、RAG-05 用实验 Ground Truth 的证据单元逐条检查）
REQUIRED_SOURCES = {'RAG-01': ['sony-wh-ch720n--02'], 'RAG-03': ['huawei-freebuds-6i--02', 'huawei-freebuds-6i--04'],
                    'RAG-04': ['redmi-buds-6--03', 'redmi-buds-6--04']}
# 环境/API 故障与产品质量无关：停止本次运行，处理后用 --resume 补跑，不计入产品运行失败。
# 超时、工具协议错误等是用户实际会遇到的失败，和提示词、工具轮数、模型选择有关，算产品运行失败。
ENV_CODES = {'NOT_CONFIGURED', 'KEY_INVALID', 'MODEL_NOT_ALLOWED', 'MODEL_UNAVAILABLE', 'REGION_UNSUPPORTED', 'QUOTA_EXHAUSTED', 'NETWORK'}
FEEDBACK = '上一条回复未通过校验'
QUESTION = re.compile(r'[^。！？!?\n]*[？?]')
SCORE_FIELDS = ['key', 'group', 'case', 'repeat', 'status', 's1', 's2', 's3', 'c1', 'c2', 'c3', 'c4', 'r1', 'r2', 'severe', 'cause', 'reviewer', 'note']


# —— 前端文案（frontend/lib/conditions.ts、session.ts、components/ConditionPanel.tsx），用于复现界面操作写进历史的消息 ——
KIND_LABEL = {'hard': '必须满足', 'soft': '偏好', 'scene': '使用场景'}
STATUS_LABEL = {'confirmed': '已生效', 'suggested': '系统建议 · 未生效', 'pending': '待你确认 · 未生效'}


def yuan(v):
    return f'¥{int(v)}' if float(v).is_integer() else f'¥{v:.2f}'


def describe_value(field, kind, value):
    if field == 'budget':
        return f'预算 ≤ {yuan(value)}' if kind == 'hard' else f'预算 {yuan(value)} 左右'
    if field == 'anc':
        if kind == 'hard':
            return '必须支持主动降噪' if value else '不要主动降噪'
        return '最好有主动降噪' if value else '最好不带主动降噪'
    if field == 'wearingStyle':
        styles = '、'.join(value['exclude'])
        return f'排除{styles}' if kind == 'hard' else f'尽量避开{styles}'
    return f'场景：{value}'


def describe(c):
    return c['question'] if c['status'] == 'pending' else describe_value(c['field'], c['kind'], c['value'])


def conditions_text(state):
    return '；'.join(f"{describe(c)}（{KIND_LABEL.get(c.get('kind'), '待定')} · {STATUS_LABEL[c['status']]}）" for c in state['conditions']) or '无'


def ui_turn(state, label, changes):
    """界面点击，同前端 applyAndReport（origin=ui）：用户的按钮文案和助手的固定回复进入历史；
    改变筛选结果时重新筛选，展示前三款。模拟用户只会采纳、忽略建议或选择待确认项，只复现这几种文案。"""
    result = update_conditions(state, changes, 'ui')
    after = result['state']
    get = lambda s, f: next((c for c in s['conditions'] if c['field'] == f), None)
    confirmed = lambda s: [c for c in s['conditions'] if c['status'] == 'confirmed']
    lines = []
    noted = [describe(get(after, c['field'])) for c in result['applied'] if c['op'] == 'resolve']
    if noted:
        lines.append(f"记下了：{'、'.join(noted)}。")
    for c in result['applied']:
        if c['op'] == 'confirm':
            now = get(after, c['field'])
            lines.append(f"好的，「{describe(now)}」已作为{'偏好' if now['kind'] == 'soft' else '必须条件'}加入。")
        elif c['op'] == 'dismiss':
            lines.append(f"好的，不加「{describe(get(state, c['field']))}」这条。")
    changed = {c['field'] for c in result['applied']}
    affects = any(c['op'] in ('confirm', 'resolve') and c['field'] != 'scene' for c in result['applied'])
    if affects and any(c['field'] not in changed for c in confirmed(state)):
        lines.append('其他条件不变。')
    recommendations = None
    if after['category'] is None:
        lines.append('先选一个品类，再一起挑商品。目前可体验蓝牙耳机。')
    elif affects:
        if not [c for c in confirmed(after) if c['kind'] != 'scene']:
            lines.append('现在没有用来筛选的条件了，说说预算或必须的功能吧。')
        else:
            matches = search_products(after)['matches']
            recommendations = [m['product']['id'] for m in matches[:3]]
            lines.append('按现在的条件，先看看这几款：' if matches else '按现在的条件暂时没有合适的款式。我不会自动放宽条件，可以试着调整预算或要求。')
    return dict(kind='ui', label=label, changes=changes, before=deepcopy(state), after=after, rejected=result['rejected'],
                reply='\n'.join(lines or ['条件没有变化。']), recommendations=recommendations)


# —— T01 模拟用户（规则见 eval/cases.json 的 task.user） ——
def pick(field, value, choices):
    for r in choices:
        if r['field'] == field and r.get('value', value) == value and any(k in str(value) for k in r.get('contains', [''])):
            return r['choose']
    return None


def ui_actions(state, user):
    """规则一、二：按前端面板的顺序（先建议、后待确认），对每一项点固定的按钮。"""
    choices, actions = user['rule1_suggestions']['choices'], []
    for c in sorted(state['conditions'], key=lambda c: c['status'] != 'suggested'):
        field = c['field']
        if c['status'] == 'suggested':
            choice = pick(field, c['value'], choices)
            if field == 'scene' and choice:
                actions.append((f'采纳建议：{describe(c)}', [dict(op='confirm', field=field)]))
            elif field != 'scene' and choice in ('hard', 'soft'):
                actions.append(('采纳建议，设为必须条件' if choice == 'hard' else '采纳建议，作为偏好', [dict(op='confirm', field=field, kind=choice)]))
            else:
                actions.append((f'不需要：{describe(c)}', [dict(op='dismiss', field=field)]))
        elif c['status'] == 'pending':
            fits = [i for i, o in enumerate(c['options']) if pick(field, o['value'], choices)]
            same = [i for i in fits if c['options'][i]['kind'] == pick(field, c['options'][i]['value'], choices)]
            if fits:
                best = (same or fits)[0]
                actions.append((c['options'][best]['label'], [dict(op='resolve', field=field, option=best)]))
    return actions


def waiting_question(turn):
    """回复在等用户回答：有问句，且本轮没有推荐卡片或比较。返回问句列表。"""
    return [] if turn.get('recommendations') or turn.get('compareIds') else QUESTION.findall(turn['reply'])


def answer(questions, rule):
    text = ''.join(questions)
    return ''.join(a['answer'] for a in rule['answers'] if any(k in text for k in a['keywords'])) or rule['fallback']


# —— 运行与记录 ——
def ms(since):
    return round((time.monotonic() - since) * 1000)


def brief(response):
    """工具结果只记可复核的部分：商品参数由 products.json 的哈希固定，只记 ID。"""
    if not isinstance(response, dict):
        return response
    if 'displayName' in response:  # get_product
        return dict(id=response['id'])
    r = dict(response)
    if 'matches' in r:
        r['matches'] = [dict(id=m['product']['id'], evaluation=m['evaluation']) for m in r['matches']]
    if 'products' in r:
        r['products'] = [p['id'] for p in r['products']]
    return r


def part_record(p):
    if p.function_call:
        return dict(call=p.function_call.name, args=p.function_call.args)
    if p.function_response:
        return dict(result=p.function_response.name, response=brief(p.function_response.response))
    if p.text and not p.thought:
        return dict(text=p.text)
    return None


class RecordingModel:
    """包住 GeminiModel：逐次记录发回模型的工具结果和校验退回，以及模型返回的工具调用参数、文字、Token 和实际版本。"""

    def __init__(self, inner):
        self.inner, self.requests, self.sent, self.provider_failed = inner, [], 1, False  # contents[0] 是请求本身，另行保存

    async def generate(self, contents):
        entry = dict(fed=[r for c in contents[self.sent:] if c.role == 'user' for r in map(part_record, c.parts or []) if r])
        self.sent = len(contents)
        self.requests.append(entry)
        began = time.monotonic()
        try:
            response = await self.inner.generate(contents)
        except Exception as e:
            self.provider_failed = True
            entry.update(error=error_label(e), ms=ms(began))
            raise
        candidate = response.candidates[0] if response.candidates else None
        parts = (candidate.content.parts or []) if candidate and candidate.content else []
        usage = response.usage_metadata
        entry.update(ms=ms(began), modelVersion=response.model_version, finish=getattr(candidate and candidate.finish_reason, 'name', None),
                     output=[r for r in map(part_record, parts) if r],
                     tokens=usage and dict(input=usage.prompt_token_count, thinking=usage.thoughts_token_count, output=usage.candidates_token_count))
        return response

    async def close(self):
        await self.inner.close()


async def chat_turn(message, state, history, make_model, source):
    model = RecordingModel(make_model())
    began = time.monotonic()
    turn = dict(kind='chat', source=source, message=message, before=deepcopy(state))
    try:
        request = ChatRequest.model_validate(dict(message=message, state=state, viewedProductId=START['viewedProductId'], history=history[-30:]))
        r = (await run_agent(request, model)).model_dump(exclude_unset=True)  # 与 /api/chat 返回给前端的 JSON 一致
        turn.update(reply=r['reply'], after=r['state'], applied=r['applied'], rejected=r['rejected'], tools=r['tools'],
                    recommendations=None if r['recommendations'] is None else [x['productId'] for x in r['recommendations']],
                    matchCount=r['matchCount'], compareIds=r['compareIds'], productRefs=r['productRefs'], evidence=r.get('evidence'))
    except ChatError as e:
        env = e.code in ENV_CODES or (e.code == 'GEMINI_UNAVAILABLE' and model.provider_failed)
        turn['error'] = dict(code=e.code, message=e.message, type='env' if env else 'product')
    turn.update(seconds=round(time.monotonic() - began, 1), requests=model.requests)
    return turn


def chat_history(turn):
    """同前端 chatHistory：用户原话和助手回复，助手消息带上本轮讨论和推荐的商品。失败的一问一答不进入历史。"""
    viewed = START['viewedProductId']
    return [dict(role='user', text=turn['message'], productRefs=[], viewedProductId=viewed),
            dict(role='assistant', text=turn['reply'], productRefs=list(dict.fromkeys(turn['productRefs'] + (turn['recommendations'] or []))), viewedProductId=viewed)]


def ui_history(turn):
    viewed = START['viewedProductId']
    return [dict(role='user', text=turn['label'], productRefs=[], viewedProductId=viewed),
            dict(role='assistant', text=turn['reply'], productRefs=turn['recommendations'] or [], viewedProductId=viewed)]


def status_of(turn):
    return 'ok' if 'error' not in turn else 'env_error' if turn['error']['type'] == 'env' else 'product_error'


async def run_single(item, make_model, wait):
    """单项题：新会话，一问一答。"""
    await wait()
    turn = await chat_turn(item['text'], deepcopy(START['state']), deepcopy(START['history']), make_model, '题目')
    return [turn], status_of(turn)


async def run_task(item, make_model, wait):
    """T01：同一会话连续执行各步；每次助手回复后按模拟用户规则处理界面项、回答追问、重试失败。"""
    user = item['user']
    state, history, turns, lost = deepcopy(START['state']), deepcopy(START['history']), [], 0
    for step, text in enumerate(item['steps'], 1):
        queue, asked = [(text, f'第 {step} 步', False)], False
        while queue:
            message, source, retried = queue.pop(0)
            await wait()
            turn = await chat_turn(message, state, history, make_model, source)
            turn['step'] = step
            turns.append(turn)
            if 'error' in turn:
                if turn['error']['type'] == 'env':
                    return turns, 'env_error'
                if retried:
                    lost += 1
                else:
                    queue.insert(0, (message, f'{source} · 重试', True))
                continue
            history += chat_history(turn)
            state = turn['after']
            actions = ui_actions(state, user)
            for label, changes in actions:
                ui = dict(ui_turn(state, label, changes), step=step)
                turns.append(ui)
                state = ui['after']
                history += ui_history(ui)
            questions = waiting_question(turn)
            if questions and not actions and not asked:
                asked = True
                queue.append((answer(questions, user['rule3_questions']), f'第 {step} 步 · 回答追问', False))
    return turns, 'product_error' if lost else 'ok'


def pacer(pause):
    """两次对话之间停顿（免费层有每分钟请求数限制）；第一次不等。"""
    first = True

    async def wait():
        nonlocal first
        if not first:
            await asyncio.sleep(pause)
        first = False
    return wait


def snapshot():
    def git(*args):
        return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    return dict(at=datetime.now().astimezone().isoformat(timespec='seconds'), model=config.model_name(),
                commit=git('rev-parse', '--short', 'HEAD'), uncommitted=git('status', '--porcelain').splitlines(),
                sha256={p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest()[:16] for p in HASHED},
                python=platform.python_version(), genai=genai.__version__)


def load(run_dir):
    return json.loads((run_dir / 'run.json').read_text(encoding='utf-8'))


def save(run_dir, data):
    tmp = run_dir / 'run.json.tmp'
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding='utf-8')
    tmp.replace(run_dir / 'run.json')


def create_run(run_dir, version, repeat=1, only=None):
    ids = [i for i in ITEMS if not only or i in only]
    run_dir.mkdir(parents=True)
    save(run_dir, dict(version=version, plan=[f'{i}#{r}' for r in range(1, repeat + 1) for i in ids], sessions=[], entries={}))


async def execute(run_dir, make_model=GeminiModel, pause=20):
    """按计划运行尚未完成的项（新运行全部，--resume 时只补环境/API 故障和未运行项），每项结束即写盘。"""
    data = load(run_dir)
    data['sessions'].append(snapshot())
    wait = pacer(pause)
    for key in data['plan']:
        old = data['entries'].get(key)
        if old and old['status'] != 'env_error':
            continue
        item = ITEMS[key.split('#')[0]]
        print(f"[{key}] {GROUPS[item['group']]}……", flush=True)
        turns, status = await (run_task if item['group'] == 'task' else run_single)(item, make_model, wait)
        data['entries'][key] = dict(status=status, session=len(data['sessions']), turns=turns)
        save(run_dir, data)
        errors = [t['error']['code'] for t in turns if 'error' in t]
        print(f"  {STATUS[status]}{'：' + '、'.join(errors) if errors else ''}（{len(turns)} 轮）", flush=True)
        if status == 'env_error':
            print(f"  已停止：{turns[-1]['error']['message']} 处理后运行 --resume {run_dir} 补跑。")
            break
    write_review(run_dir, data)
    write_scores(run_dir, data)
    return data


# —— 阅读记录与评分表 ——
def flags(item, turns):
    """帮评审定位的自动提示，只看结构化结果，不代替评分。"""
    out, chats = [], [(n, t) for n, t in enumerate(turns, 1) if t['kind'] == 'chat']
    for n, t in chats:
        back = sum(f.get('text', '').startswith(FEEDBACK) for r in t['requests'] for f in r['fed'])
        refused = [f['response']['error'] for r in t['requests'] for f in r['fed'] if isinstance(f.get('response'), dict) and 'error' in f['response']]
        if back:
            out.append(f'第 {n} 轮：文字回复被输出校验退回 {back} 次')
        if refused:
            out.append(f'第 {n} 轮：工具调用被拒 {len(refused)} 次')
        for r in t.get('rejected') or []:
            out.append(f"第 {n} 轮：条件没有生效：{r['change'].get('field')}（{r['code']}：{r['reason']}）")
        if 'error' in t:
            out.append(f"第 {n} 轮：{'环境/API 故障' if t['error']['type'] == 'env' else '产品运行失败'} {t['error']['code']}")
    for n, t in enumerate(turns, 1):
        if t['kind'] == 'ui':
            out += [f"第 {n} 轮：模拟点击被拒：{r['reason']}" for r in t['rejected']]
    if item['group'] == 'qa':
        out += evidence_checks(item, turns)
    done = [t for t in turns if 'after' in t]
    if not done:
        return out
    final, case = done[-1]['after'], item['id']
    if case in ('A01', 'A02') and (b := cond(final, 'budget')) and b.get('value') == 200:
        out.append(f"预算记成了“{describe(b)}”（{STATUS_LABEL[b['status']]}）：核对是否把“200元以上”当成了上限或“左右”")
    if case == 'A02':
        for c in final['conditions']:
            if any(w in json.dumps(c, ensure_ascii=False) for w in ('酷炫', '舒适', '放松')):
                out.append(f"主观词写进了条件：{describe(c)}（{STATUS_LABEL[c['status']]}）：核对回复有没有把它说成已生效的筛选条件")
    if case == 'A03' and not is_cond(final, 'budget', 'hard', 300):
        out.append('“300元以内”没有成为必须满足的“预算 ≤ ¥300”')
    limit = {'A03': 300, 'T01': 500}.get(case)
    for n, t in enumerate(turns, 1):
        over = [NAME.get(i, i) for i in t.get('recommendations') or [] if limit and (PRICE.get(i) is None or PRICE[i] > limit)]
        if over:
            out.append(f"第 {n} 轮：推荐超出 ¥{limit}：{'、'.join(over)}")
    if case == 'T01':
        kept = [is_cond(t['after'], 'budget', 'hard', 500) for t in turns if 'after' in t]
        if True not in kept:
            out.append('预算一直没有成为必须满足的“预算 ≤ ¥500”')
        elif False in kept[kept.index(True):]:
            out.append('“预算 ≤ ¥500”设上后又丢失或被改动（检查点①）')
        shown = {i for t in turns if t.get('step', 0) < 4 for i in t.get('recommendations') or []}
        compared = [t['compareIds'] for t in turns if t.get('step') == 4 and t.get('compareIds')]
        if not compared:
            out.append('第 4 步没有调用比较：核对推荐是否不足两款、回复是否说明原因')
        elif not set(compared[-1]) <= shown:
            out.append(f"第 4 步比较的商品不全是前面推荐过的：{'、'.join(NAME.get(i, i) for i in compared[-1])}")
    return out


def retrieved(turns):
    """本题各轮取回的证据（retrieve_evidence 的工具结果）。"""
    return [e for t in turns if t['kind'] == 'chat' for r in t['requests'] for f in r['fed']
            if f.get('result') == 'retrieve_evidence' and isinstance(f.get('response'), dict) for e in f['response'].get('evidence', [])]


def evidence_checks(item, turns):
    """检索层自动检查，只用于定位，不代替 T1/T2 人工评分：RAG-02/RAG-05 按实验 Ground Truth 的证据单元，其余按专项文档的必要来源。"""
    found = retrieved(turns)
    if not found:
        return ['检索：本题没有取回任何证据（未调用 retrieve_evidence 或调用失败）']
    out = [f"检索：取回 {len(found)} 段，涉及商品 {'、'.join(dict.fromkeys(NAME.get(e['product_id'], e['product_id']) for e in found))}"]
    try:
        from types import SimpleNamespace
        from experiments.rag import corpus, evaluate
    except ImportError:
        return out + ['检索：缺少实验依赖，跳过证据单元检查']
    gt = json.loads((ROOT / 'experiments/rag/ground_truth.json').read_text(encoding='utf-8'))
    main = next((m for m in gt['main'] if m['id'] == item['id']), None)
    if main:
        chunks = [SimpleNamespace(source_id=e['source_id'], text=e['text']) for e in found]
        for group in main['required']:
            ok = evaluate.group_hit(chunks, group, gt['units'])
            out.append(f"检索：必要证据 {' 或 '.join(group)} {'已取回' if ok else '缺失'}")
        checks, errors = evaluate.RULES[main['id']](next((t['reply'] for t in reversed(turns) if 'reply' in t), ''))
        out.append('规则辅助（会漏判同义改写，只供参考）：' + '；'.join(f"{k} {'✓' if ok else '✗'}" for k, (ok, _) in checks.items())
                   + (f"；疑似禁止断言：{'；'.join(errors)}" if errors else ''))
    for sid in REQUIRED_SOURCES.get(item['id'], []):
        indexed = sid in {s['source_id'] for s in corpus.sources()}
        out.append(f"检索：必要来源 {sid} " + ('已取回' if sid in {e['source_id'] for e in found} else '未取回' if indexed else '不在证据语料中（说明书 PDF 或第三方摘录尚未接入）'))
    return out


def turn_lines(n, t):
    def cards():
        out = []
        if t.get('recommendations') is not None:
            count = f"（符合 {t['matchCount']} 款）" if t.get('matchCount') is not None else ''
            out.append(f"- 卡片：{'、'.join(NAME.get(i, i) for i in t['recommendations']) or '无'}{count}")
        if t.get('compareIds'):
            out.append(f"- 比较：{' / '.join(NAME.get(i, i) for i in t['compareIds'])}")
        return out
    if t['kind'] == 'ui':
        return [f"### 第 {n} 轮 · 模拟用户点击：{t['label']}", f"- 条件：{conditions_text(t['after'])}",
                f"- 助手（前端固定回复）：{t['reply']}".replace('\n', ' '), *cards()]
    out = [f"### 第 {n} 轮 · {t['source']}", f"- 用户：{t['message']}"]
    for i, r in enumerate(t['requests'], 1):
        for f in r['fed']:
            if 'text' in f:
                out.append(f"  - 发回模型：{f['text']}")
            elif isinstance(f.get('response'), dict) and 'error' in f['response']:
                out.append(f"  - 工具被拒（{f['result']}）：{f['response']['error']}")
            elif f.get('result') == 'retrieve_evidence' and isinstance(f.get('response'), dict):
                out.append('  - 取回证据：' + '；'.join(f"{e['ref']} {e['source_id']}（{e['region']}）{e['position'][:30]}" for e in f['response'].get('evidence', [])))
        calls = [f"{o['call']}({json.dumps(o['args'], ensure_ascii=False)})" for o in r.get('output', []) if 'call' in o]
        texts = [o['text'] for o in r.get('output', []) if 'text' in o]
        tokens = f"，Token {r['tokens']['input']}/{r['tokens']['output']}" if r.get('tokens') else ''
        out.append(f"- 请求 {i}（{r.get('ms')} ms{tokens}）：" + ('；'.join(calls) or '无工具调用')
                   + (f"；文字：{' '.join(texts)}" if texts else '') + (f"；出错：{r['error']}" if 'error' in r else ''))
    if 'error' in t:
        out.append(f"- **{'环境/API 故障' if t['error']['type'] == 'env' else '产品运行失败'} {t['error']['code']}**：{t['error']['message']}")
        return out
    out += [f"- 未生效：{r['change'].get('field')}（{r['code']}：{r['reason']}）" for r in t['rejected']]
    return [*out, f"- 条件：{conditions_text(t['before'])} → {conditions_text(t['after'])}",
            f"- 回复（用户看到的）：{t['reply']}".replace('\n', ' '), *cards(),
            *([f"- 回答引用的证据：{'、'.join(e['ref'] + ' ' + e['sourceId'] for e in t['evidence'])}"] if t.get('evidence') else []),
            f"- 用时 {t['seconds']} 秒"]


def write_review(run_dir, data):
    s = data['sessions'][-1]
    lines = [f"# {data['version']} 评测记录", '',
             f"模型 {s['model']} · 代码 {s['commit']}{'（有未提交改动）' if s['uncommitted'] else ''} · 题目与数据哈希见 run.json", '',
             '在 scores.csv 里评分，规则见总览第二节和 RAG 专项第四节；“自动提示”只帮助定位，不代替评分。', '',
             '- Agent：s1 原意理解、s2 条件与工具执行、s3 反馈与澄清，各 0–2',
             '- 商品问答：s1 事实准确（F）、s2 要点覆盖（C）、s3 条件与建议边界（U），各 0–2',
             '- 完整购物任务 T01：c1–c4 是四个达标条件，满足填 1，不满足填 0',
             '- 商品问答的检索：r1 必要证据覆盖（T1）、r2 型号/来源/条件匹配（T2），各 0–2，只在有证据检索的版本填写；不与回答分相加',
             '- severe 填严重错误标签（如 K1;K3），没有就留空；cause 填失败归因（D1–D5）；产品运行失败和环境/API 故障不用评分', '']
    for key in data['plan']:
        item, entry = ITEMS[key.split('#')[0]], data['entries'].get(key)
        lines += [f"## {key} · {GROUPS[item['group']]}", '']
        if item['group'] == 'task':
            lines.append('四步原句和达标条件见总览第三节 B；模拟用户规则见 eval/cases.json。')
        else:
            lines.append(f"题目：{item['text']}")
            lines.append(f"检查重点：{item['focus']}" if 'focus' in item else f"参考答案、必要证据和禁止断言：RAG 专项第一节 {item['id']}；要点组见第四节 4.1")
            if 'reviewNote' in item:
                lines.append(f"评审提示：{item['reviewNote']}")
        if not entry:
            lines += ['', '未运行（待测）', '']
            continue
        lines += ['', f"状态：{STATUS[entry['status']]}"]
        if hints := flags(item, entry['turns']):
            lines += ['', '自动提示：', *[f'- {h}' for h in hints]]
        for n, t in enumerate(entry['turns'], 1):
            lines += ['', *turn_lines(n, t)]
        lines.append('')
    (run_dir / 'review.md').write_text('\n'.join(lines), encoding='utf-8')


def read_scores(run_dir):
    path = run_dir / 'scores.csv'
    if not path.exists():
        return {}
    text = path.read_text(encoding='utf-8-sig').lstrip('\r\n')  # 用表格软件编辑后可能在表头前多出空行
    return {r['key']: {k: (r.get(k) or '').strip() for k in SCORE_FIELDS} for r in csv.DictReader(text.splitlines())}


def write_scores(run_dir, data):
    """评分表：每个计划项一行；补跑后重写时保留已填的分数。"""
    old = read_scores(run_dir)
    with (run_dir / 'scores.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, SCORE_FIELDS)
        w.writeheader()
        for key in data['plan']:
            case, repeat = key.split('#')
            entry = data['entries'].get(key)
            w.writerow({**dict.fromkeys(SCORE_FIELDS, ''), **old.get(key, {}), 'key': key, 'group': GROUPS[ITEMS[case]['group']],
                        'case': case, 'repeat': repeat, 'status': STATUS[entry['status']] if entry else '未运行'})


# —— 汇总：三类结果分开统计，不合成总体准确率 ——
def verdict(group, row):
    """分数是否达标（不含严重错误）；没填完返回 None。"""
    keys, top = (('c1', 'c2', 'c3', 'c4'), 1) if group == 'task' else (('s1', 's2', 's3'), 2)
    if any(row.get(k, '') == '' for k in keys):
        return None
    values = [int(row[k]) for k in keys]
    if any(not 0 <= v <= top for v in values):
        raise ValueError
    return all(values) if group == 'task' else sum(values) >= 5


def tally(run_dir):
    data, scores = load(run_dir), read_scores(run_dir)
    groups = {g: dict(planned=0, passed=0, product=0, env=0, missing=0, unscored=0, severe=0) for g in GROUPS}
    retrieval_ok = retrieval_scored = 0
    for key in data['plan']:
        group = ITEMS[key.split('#')[0]]['group']
        c, entry, row = groups[group], data['entries'].get(key), scores.get(key, {})
        c['planned'] += 1
        if not entry:
            c['missing'] += 1
            continue
        if entry['status'] == 'env_error':
            c['env'] += 1
            continue
        c['severe'] += bool(row.get('severe'))  # 同一次运行有多个严重错误只算一次
        if entry['status'] == 'product_error':
            c['product'] += 1  # 计入计划次数，不通过
            continue
        try:
            v = verdict(group, row)
        except ValueError:
            raise SystemExit(f'{run_dir / "scores.csv"} 中 {key} 的分数不合法：s1–s3 填 0–2，c1–c4 填 0 或 1。')
        if v is None:
            c['unscored'] += 1
        elif v and not row.get('severe'):
            c['passed'] += 1
        if group == 'qa' and row.get('r1', '') != '' and row.get('r2', '') != '':
            retrieval_scored += 1
            retrieval_ok += int(row['r1']) + int(row['r2']) == 4
    chats = [t for e in data['entries'].values() if e['status'] != 'env_error' for t in e['turns'] if t['kind'] == 'chat' and t.get('error', {}).get('type') != 'env']
    requests = [r for t in chats for r in t['requests']]
    seconds = sorted(t['seconds'] for t in chats)
    tokens = {k: sum((r.get('tokens') or {}).get(k) or 0 for r in requests) for k in ('input', 'thinking', 'output')}
    return dict(version=data['version'], groups=groups, sessions=data['sessions'], chats=len(chats), requests=len(requests),
                retrieval=dict(ok=retrieval_ok, scored=retrieval_scored),
                feedback=sum(f.get('text', '').startswith(FEEDBACK) for r in requests for f in r['fed']),
                median=seconds[len(seconds) // 2] if seconds else None, p90=seconds[math.ceil(len(seconds) * 0.9) - 1] if seconds else None,
                tokens=tokens, versions=sorted({r['modelVersion'] for r in requests if r.get('modelVersion')}))


def summary(dirs):
    runs = [(d, tally(d)) for d in dirs]
    head = ' | '.join(f"{t['version']}（{d.name}）" for d, t in runs)
    rows = [f'| 指标 | {head} |', '| --- |' + ' --- |' * len(runs)]

    def row(label, fn):
        rows.append(f"| {label} | {' | '.join(fn(t) for _, t in runs)} |")

    def incomplete(c):
        return c['env'] or c['missing'] or c['unscored']

    def each(key):
        return lambda t: ' · '.join(f"{GROUPS[g]} {c[key]}" for g, c in t['groups'].items())
    for g, label in (('agent', 'Agent 通过'), ('qa', '商品问答通过'), ('task', '完整任务达标')):
        row(label, lambda t, g=g: f"{t['groups'][g]['passed']}/{t['groups'][g]['planned']}" + ('（不完整）' if incomplete(t['groups'][g]) else ''))
    row('RAG 专项检索达标（T1+T2=4，单独统计）', lambda t: f"{t['retrieval']['ok']}/{t['retrieval']['scored']}" if t['retrieval']['scored'] else 'N/A')
    row('严重错误（发生的运行次数）', each('severe'))
    row('产品运行失败（计入计划次数）', each('product'))
    row('环境/API 故障（不计入产品失败，需补跑）', each('env'))
    row('未运行', each('missing'))
    row('待评分', each('unscored'))
    row('结果完整', lambda t: '否' if any(incomplete(c) for c in t['groups'].values()) else '是')
    row('模型（配置 / 实际版本）', lambda t: f"{t['sessions'][-1]['model']} / {'、'.join(t['versions']) or '未知'}")
    row('代码提交', lambda t: '、'.join(dict.fromkeys(s['commit'] + ('（有未提交改动）' if s['uncommitted'] else '') for s in t['sessions'])))
    row('对话轮数 / 模型请求次数', lambda t: f"{t['chats']} / {t['requests']}")
    row('文字回复被输出校验退回', lambda t: str(t['feedback']))
    row('每轮用时中位数 / P90（秒）', lambda t: f"{t['median']} / {t['p90']}")
    row('Token 输入 / 思考 / 输出', lambda t: ' / '.join(str(t['tokens'][k]) for k in ('input', 'thinking', 'output')))
    return '\n'.join(['通过数的分母是计划次数；三类结果分开统计，不合成总体准确率。', '', *rows])


def main():
    parser = argparse.ArgumentParser(description='ShopMate 评测：运行题目（消耗 Gemini 免费额度）或汇总评分')
    sub = parser.add_subparsers(dest='command', required=True)
    run = sub.add_parser('run', help='运行题目并保存记录')
    run.add_argument('--version', help='版本标签，如 B0；新建运行时必填')
    run.add_argument('--repeat', type=int, default=1, help='每项运行次数，默认 1')
    run.add_argument('--only', help='只运行部分项，如 A01,T01')
    run.add_argument('--pause', type=float, default=20, help='两次对话之间等待的秒数')
    run.add_argument('--resume', type=Path, help='补跑已有记录里的环境/API 故障和未运行项')
    total = sub.add_parser('summary', help='读取 scores.csv 汇总；传多个目录可并排比较')
    total.add_argument('dirs', nargs='+', type=Path)
    total.add_argument('--out', type=Path, help='同时写入 Markdown 文件')
    args = parser.parse_args()
    if args.command == 'summary':
        text = summary(args.dirs)
        print(text)
        if args.out:
            args.out.write_text(text + '\n', encoding='utf-8')
        return
    if not os.getenv('GEMINI_API_KEY', '').strip():
        raise SystemExit('未配置 GEMINI_API_KEY：请在项目根目录 .env 中填写后再运行。')
    if config.model_name() not in config.FREE_FUNCTION_MODELS:
        raise SystemExit(f'GEMINI_MODEL={config.model_name()} 不在已核实的免费模型名单内。')
    if args.resume:
        run_dir = args.resume
    else:
        if not args.version or not re.fullmatch(r'[\w.-]+', args.version):
            parser.error('新建运行需要 --version，如 B0')
        only = set(args.only.split(',')) if args.only else None
        if only and only - ITEMS.keys():
            parser.error(f"没有这些题目：{'、'.join(sorted(only - ITEMS.keys()))}")
        run_dir = ROOT / 'eval/runs' / f"{args.version}-{datetime.now():%Y%m%d-%H%M%S}"
        create_run(run_dir, args.version, args.repeat, only)
    logging.basicConfig(format='  %(message)s')
    logging.getLogger('shopmate').setLevel(logging.INFO)  # 每次模型请求的序号、耗时和工具名，不含用户内容
    print(f'模型 {config.model_name()}；记录写入 {run_dir}')
    asyncio.run(execute(run_dir, GeminiModel, args.pause))
    print(f'\n阅读 {run_dir / "review.md"}，在 scores.csv 填分后运行：\n.venv/bin/python -m tests.eval_run summary {run_dir.relative_to(ROOT) if run_dir.is_relative_to(ROOT) else run_dir}')


if __name__ == '__main__':
    main()
