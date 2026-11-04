"""评测脚本的离线自测：用预设的模型输出检查记录内容、T01 模拟用户、故障分类和汇总口径，不调用 Gemini。"""
import asyncio
import csv
import hashlib
import json
from pathlib import Path
import pytest
from google.genai import errors, types
from tests import eval_run as ev
from tests.test_agent import call, done, response, say

ROOT = Path(__file__).resolve().parents[1]
B0 = ROOT / 'eval/runs/B0-20261102-233030'
B0_CASES_SHA = '472f4e6e1cf4ff79'  # B0 运行时记录的 eval/cases.json 哈希：固定用例以它为基线
UNDER_500 = [p['id'] for p in ev.PRODUCTS if p['priceCny'] is not None and p['priceCny'] <= 500][:2]


class FakeGemini:
    """按本轮用户原话取预设输出；同一句话第二次出现（如重试）取下一组。请求内容记在 seen 里。"""

    def __init__(self, scripts, seen):
        self.scripts, self.seen, self.turns = scripts, seen, None

    async def generate(self, contents):
        if self.turns is None:
            request = json.loads(contents[0].parts[0].text)
            self.seen.append(request)
            self.turns = iter(self.scripts[request['message']].pop(0))
        turn = next(self.turns)
        if isinstance(turn, Exception):
            raise turn
        return turn

    async def close(self):
        pass


def execute(tmp_path, scripts, only, name='run'):
    seen, run_dir = [], tmp_path / name
    if not (run_dir / 'run.json').exists():
        ev.create_run(run_dir, 'B0', only=only)
    asyncio.run(ev.execute(run_dir, lambda: FakeGemini(scripts, seen), pause=0))
    return ev.load(run_dir), seen, run_dir


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def test_fixed_cases_are_the_b0_baseline():
    """固定用例以 eval/cases.json 为准：内容与 B0 运行时完全相同（哈希一致），9 项的编号和顺序不变；
    商品问答原句仍与 RAG 专项文档一致。改题必须同时更新基线，不能为了通过测试悄悄修改。"""
    assert hashlib.sha256((ROOT / 'eval/cases.json').read_bytes()).hexdigest()[:16] == B0_CASES_SHA
    assert list(ev.ITEMS) == ['A01', 'A02', 'A03', 'RAG-01', 'RAG-02', 'RAG-03', 'RAG-04', 'RAG-05', 'T01']
    assert len(ev.CASES['task']['steps']) == 4 and all(c['text'].strip() for c in ev.CASES['agent'] + ev.CASES['qa'])
    rag = read('docs/ShopMate_RAG_Eval_V0.1.md')
    for c in ev.CASES['qa']:
        assert f"### {c['id']}｜" in rag and f"**用户问题：**“{c['text']}”" in rag


@pytest.mark.skipif(not (B0 / 'run.json').exists(), reason='本地没有 B0 原始记录')
def test_b0_record_ran_exactly_these_cases():
    """B0 原始记录里实际发给 Agent 的原句与 eval/cases.json 一致，用来证明新旧版本测的是同一组题。"""
    data = ev.load(B0)
    assert data['sessions'][-1]['sha256']['eval/cases.json'] == B0_CASES_SHA
    assert data['plan'] == [f'{i}#1' for i in ev.ITEMS]
    for key in data['plan']:
        item, turns = ev.ITEMS[key.split('#')[0]], data['entries'][key]['turns']
        if item['group'] == 'task':
            sent = [next(t['message'] for t in turns if t.get('source') == f'第 {n} 步') for n in range(1, len(item['steps']) + 1)]
            assert sent == item['steps']
        else:
            assert turns[0]['message'] == item['text'] and turns[0]['before'] == ev.START['state']


def test_start_state_and_ui_texts_follow_the_frontend():
    session, panel, conditions = read('frontend/lib/session.ts'), read('frontend/components/ConditionPanel.tsx'), read('frontend/lib/conditions.ts')
    assert f"'{ev.START['history'][0]['text']}'" in session
    assert "emptyState(entry === 'home' ? null : 'headphones')" in session and 'history.slice(-30)' in session
    for text in ('已作为${', '好的，不加「', "'其他条件不变。'", "'按现在的条件，先看看这几款：'", 'matches.slice(0, RECOMMEND_LIMIT)', 'RECOMMEND_LIMIT = 3'):
        assert text in session
    for text in ("'采纳建议，设为必须条件'", "'采纳建议，作为偏好'", '`不需要：${describeCondition(c)}`', '`采纳建议：${describeCondition(c)}`'):
        assert text in panel
    assert "`预算 ≤ ${formatYuan(value as number)}`" in conditions and "'最好有主动降噪'" in conditions
    assert ev.describe_value('budget', 'hard', 500) == '预算 ≤ ¥500' and ev.describe_value('anc', 'soft', True) == '最好有主动降噪'


def test_single_item_keeps_tool_args_raw_text_and_validation_feedback(tmp_path):
    scripts = {'我想买200元以上的耳机': [[response(call('select_category', category='headphones')),
                                     say('暂时不能按200元以上筛选。'), say('暂时还不能按最低价筛选，你可以告诉我价格上限或用途吗？')]]}
    data, seen, run_dir = execute(tmp_path, scripts, {'A01'})
    entry = data['entries']['A01#1']
    assert entry['status'] == 'ok' and seen[0]['history'] == ev.START['history'] and seen[0]['state']['category'] is None
    [turn] = entry['turns']
    assert turn['requests'][0]['output'] == [dict(call='select_category', args={'category': 'headphones'})]
    assert turn['requests'][1]['output'] == [dict(text='暂时不能按200元以上筛选。')]
    assert turn['requests'][2]['fed'][0]['text'].startswith(ev.FEEDBACK)
    assert turn['reply'].startswith('暂时还不能') and turn['after']['category'] == 'headphones'
    review = (run_dir / 'review.md').read_text(encoding='utf-8')
    assert '文字回复被输出校验退回 1 次' in review and '暂时不能按200元以上筛选' in review
    assert data['sessions'][0]['sha256']['eval/cases.json'] and data['sessions'][0]['model']


def test_api_failures_stop_the_run_and_resume_only_reruns_them(tmp_path):
    scripts = {'我想买200元以上的耳机': [[errors.APIError(429, {'error': {'message': 'quota'}})]]}
    data, _, run_dir = execute(tmp_path, scripts, {'A01', 'A02'})
    assert data['entries']['A01#1']['status'] == 'env_error' and 'A02#1' not in data['entries']
    assert ev.tally(run_dir)['groups']['agent'] == dict(planned=2, passed=0, product=0, env=1, missing=1, unscored=0, severe=0)

    scripts = {'我想买200元以上的耳机': [[say('暂时还不能按最低价筛选。')]],
               '想买耳机，酷炫舒适的200元以上好放松': [[types.GenerateContentResponse(candidates=[])]]}  # 模型没有返回内容：产品运行失败
    data, seen, run_dir = execute(tmp_path, scripts, None)
    assert [r['message'] for r in seen] == ['我想买200元以上的耳机', '想买耳机，酷炫舒适的200元以上好放松']
    assert data['entries']['A01#1']['status'] == 'ok' and data['entries']['A02#1']['status'] == 'product_error'
    assert data['entries']['A02#1']['turns'][0]['error'] == dict(code='MODEL_EMPTY', message='模型没有返回有效内容，请重试。', type='product')
    assert len(data['sessions']) == 2


def test_t01_simulated_user_confirms_answers_and_retries_like_the_frontend(tmp_path):
    s1, s2, s3, s4 = ev.CASES['task']['steps']
    budget = dict(op='set', field='budget', kind='hard', value=500)
    scene = dict(op='set', field='scene', kind='scene', value='公交通勤')
    anc = dict(op='suggest', field='anc', kind='hard', value=True, reason='公交上噪音较大')
    scripts = {
        s1: [[response(call('select_category', category='headphones'), call('update_conditions', changes=[budget, scene, anc])),
              say('记下了预算和场景。要把主动降噪加进条件吗？在上方确认。')]],
        s2: [[types.GenerateContentResponse(candidates=[])],  # 第一次失败，模拟用户点重试
             [response(call('search_products')), done('先看这两款。', recommend_ids=UNDER_500)]],
        s3: [[say('你更在意单次续航，还是含充电盒的总续航？')]],
        '单次续航越长越好，其他按原来的要求。': [[say('好的，按单次续航来比较。')]],
        s4: [[response(call('compare_products', product_ids=UNDER_500)), done('看比较表。', product_refs=UNDER_500)]],
    }
    data, seen, run_dir = execute(tmp_path, scripts, {'T01'})
    entry = data['entries']['T01#1']
    assert entry['status'] == 'ok'
    kinds = [(t['kind'], t.get('source') or t['label']) for t in entry['turns']]
    assert kinds == [('chat', '第 1 步'), ('ui', '采纳建议，作为偏好'), ('chat', '第 2 步'), ('chat', '第 2 步 · 重试'),
                     ('chat', '第 3 步'), ('chat', '第 3 步 · 回答追问'), ('chat', '第 4 步')]
    ui = entry['turns'][1]
    assert ui['reply'].startswith('好的，「最好有主动降噪」已作为偏好加入。\n其他条件不变。\n按现在的条件，先看看这几款：')
    assert ev.is_cond(ui['after'], 'anc', 'soft', True) and len(ui['recommendations']) == 3
    # 有界面操作时不再回答追问；重试前失败的一问一答不进入历史
    retry_history = seen[2]['history']
    assert [m['text'] for m in retry_history] == [ev.START['history'][0]['text'], s1, entry['turns'][0]['reply'], '采纳建议，作为偏好', ui['reply']]
    assert retry_history[-1]['productRefs'] == ui['recommendations']
    assert seen[4]['message'] == '单次续航越长越好，其他按原来的要求。'
    assert seen[5]['history'][-1]['productRefs'] == []
    assert ev.flags(ev.ITEMS['T01'], entry['turns']) == ['第 3 轮：产品运行失败 MODEL_EMPTY']


def test_unmatched_suggestions_are_dismissed_and_pending_questions_follow_the_persona():
    user = ev.CASES['task']['user']
    state = ev.update_conditions({'schemaVersion': 1, 'category': 'headphones', 'conditions': [], 'dismissed': []}, [
        dict(op='suggest', field='wearingStyle', kind='hard', value={'exclude': ['入耳式']}, reason='久戴'),
        dict(op='ask', field='budget', question='预算是上限还是大概？', rawText='500 元以内',
             options=[dict(label='大约 ¥500', kind='soft', value=500), dict(label='最多 ¥500', kind='hard', value=500)])], 'interpreter')['state']
    assert ev.ui_actions(state, user) == [('不需要：排除入耳式', [dict(op='dismiss', field='wearingStyle')]),
                                          ('最多 ¥500', [dict(op='resolve', field='budget', option=1)])]
    assert ev.answer(['你想买什么品类？'], user['rule3_questions']) == '想买蓝牙耳机。'
    assert ev.answer(['要我按这些推荐吗？'], user['rule3_questions']) == user['rule3_questions']['fallback']


def fill(run_dir, rows):
    with (run_dir / 'scores.csv').open(encoding='utf-8-sig', newline='') as f:
        table = list(csv.DictReader(f))
    for r in table:
        r.update(rows.get(r['key'], {}))
    with (run_dir / 'scores.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, ev.SCORE_FIELDS)
        w.writeheader()
        w.writerows(table)


def test_summary_keeps_the_three_groups_apart_and_counts_failures_in_the_plan(tmp_path):
    run_dir = tmp_path / 'run'
    ev.create_run(run_dir, 'B0', only={'A01', 'A02', 'A03', 'RAG-01', 'RAG-02', 'T01'})
    data = ev.load(run_dir)
    data['sessions'].append(ev.snapshot())
    for key, status in {'A01#1': 'ok', 'A02#1': 'ok', 'A03#1': 'product_error', 'RAG-01#1': 'env_error', 'RAG-02#1': 'ok', 'T01#1': 'ok'}.items():
        data['entries'][key] = dict(status=status, session=1, turns=[])
    ev.save(run_dir, data)
    ev.write_scores(run_dir, data)
    fill(run_dir, {'A01#1': dict(s1='2', s2='2', s3='1'), 'A02#1': dict(s1='2', s2='2', s3='2', severe='K5;K1'),
                   'RAG-02#1': dict(s1='2', s2='1', s3='1'), 'T01#1': dict(c1='1', c2='1', c3='1', c4='0')})
    t = ev.tally(run_dir)['groups']
    assert t['agent'] == dict(planned=3, passed=1, product=1, env=0, missing=0, unscored=0, severe=1)
    assert t['qa'] == dict(planned=2, passed=0, product=0, env=1, missing=0, unscored=0, severe=0)
    assert t['task'] == dict(planned=1, passed=0, product=0, env=0, missing=0, unscored=0, severe=0)
    text = ev.summary([run_dir])
    assert '| Agent 通过 | 1/3 |' in text and '| 商品问答通过 | 0/2（不完整） |' in text and '| 完整任务达标 | 0/1 |' in text
    assert '| 结果完整 | 否 |' in text

    fill(run_dir, {'A01#1': dict(s1='3')})
    with pytest.raises(SystemExit):
        ev.tally(run_dir)


def test_evidence_checks_use_the_experiment_ground_truth_and_flag_missing_products():
    found = [dict(ref='S1', product_id='oppo-enco-air4-pro', source_id='oppo-enco-air4-pro--03', region='菲律宾站', position='Remarks › 注 3',
                  text='LHDC transmission should be built via Bluetooth® connection between two LHDC-supported devices. To use this function, '
                       'the OPPO phone supported by LHDC 5.0 needs to support ColorOS 13.1 or later versions, and are Find X6 and later released')]
    turns = [dict(kind='chat', reply='Pro 需要手机也支持 LHDC [S1]。', requests=[dict(fed=[dict(result='retrieve_evidence', response=dict(evidence=found))])])]
    lines = ev.evidence_checks(ev.ITEMS['RAG-02'], turns)
    assert '检索：必要证据 AIR4-CODEC 缺失' in lines and '检索：必要证据 PRO-DUAL 或 PRO-NOTE 已取回' in lines
    assert any(line.startswith('规则辅助') for line in lines)
    assert ev.evidence_checks(ev.ITEMS['RAG-01'], [dict(kind='chat', reply='', requests=[])]) == ['检索：本题没有取回任何证据（未调用 retrieve_evidence 或调用失败）']


@pytest.mark.skipif(not (B0 / 'run.json').exists(), reason='本地没有 B0 原始记录')
def test_b0_record_still_summarizes_and_is_not_modified():
    before = {p.name: p.read_bytes() for p in B0.iterdir()}
    text = ev.summary([B0])
    assert '| 商品问答通过 |' in text and 'gemini-3.5-flash-lite' in text and '| RAG 专项检索达标（T1+T2=4，单独统计） | N/A |' in text
    assert {p.name: p.read_bytes() for p in B0.iterdir()} == before


@pytest.mark.skipif(not (B0 / 'run.json').exists(), reason='本地没有 B0 原始记录')
def test_reports_only_read_the_b0_record(tmp_path):
    from tests import eval_report
    before = {p.name: p.read_bytes() for p in B0.iterdir()}
    text = eval_report.compare(B0, B0)
    assert '| A01#1 | Agent | 不通过 | 0/0/1（1/6） |' in text and '| src/tools.py |' in text
    report = eval_report.iteration()
    assert '## 四、RAG 集成后的产品评测（9 项固定用例）' in report and '待测' in report and 'B+规格+均衡' in report
    assert {p.name: p.read_bytes() for p in B0.iterdir()} == before
