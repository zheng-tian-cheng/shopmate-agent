"""商品证据检索接入 Agent 的离线测试：不调用 Gemini。
检索选取逻辑用构造的片段测试；B+ 切分用本地原始资料测试（缺资料时跳过）；Agent 工具循环用替身检索测试。"""
import json
from pathlib import Path
import pytest
from src import agent, evidence
from src.conditions import empty_state, update_conditions
from tests.test_agent import call, done, response, run, say

corpus = pytest.importorskip('experiments.rag.corpus')
ROOT = Path(__file__).resolve().parents[1]
need_sources = pytest.mark.skipif(len(corpus.sources()) < 18, reason='本地没有 RAG 原始资料')


def chunk(i, product, text, source_type='official_product_page', kind='body', position='正文', links=()):
    return corpus.Chunk(id=f'T:{product}:{i}', scheme='T', product_id=product, source_id=f'{product}--0{1 if source_type == "official_spec_page" else 3}',
                        region='测试站', source_type=source_type, text=text, index_text=text, position=position, kind=kind, links=list(links))


def test_each_product_gets_its_own_share_with_its_best_spec_snippet_first():
    pro = [chunk(i, 'oppo-enco-air4-pro', f'Pro marketing paragraph {i} about LHDC and studio sound ' * 6) for i in range(8)]
    air4 = [chunk(0, 'oppo-enco-air4', 'Air4 app feature paragraph ' * 8), chunk(1, 'oppo-enco-air4', 'Bluetooth Codec AAC/SBC', 'official_spec_page')]
    picked = evidence.select({'oppo-enco-air4': air4, 'oppo-enco-air4-pro': pro}, corpus, budget=600)
    assert picked[0].text == 'Bluetooth Codec AAC/SBC', '规格页片段排在该商品第一位'
    assert {c.product_id for c in picked} == {'oppo-enco-air4', 'oppo-enco-air4-pro'}, '两款都有证据，Pro 没有占满预算'
    for product in ('oppo-enco-air4', 'oppo-enco-air4-pro'):
        assert sum(corpus.est_tokens(c.label() + '\n' + c.text) for c in picked if c.product_id == product) <= 300 + 200


def test_duplicates_across_sources_and_footnotes_already_attached_to_the_body_are_dropped():
    note = 'LHDC transmission should be built via Bluetooth connection between two LHDC-supported devices and ColorOS 13.1 or later.'
    body = chunk(0, 'oppo-enco-air4-pro', f'Hi-Res Audio with LHDC 5.0 [^3]\n（注 3：{note}）', links=['T:oppo-enco-air4-pro:2'])
    same_spec = [chunk(i, 'oppo-enco-air4-pro', 'Bluetooth codec: LHDC 5.0/AAC/SBC Bluetooth version 5.4', 'official_spec_page') for i in (5, 6)]
    footnote = chunk(2, 'oppo-enco-air4-pro', f'3. {note}', kind='footnote', position='Remarks › 注 3', links=['T:oppo-enco-air4-pro:0'])
    picked = evidence.select({'oppo-enco-air4-pro': [same_spec[0], body, same_spec[1], footnote]}, corpus)
    assert [c.id for c in picked] == [same_spec[0].id, body.id], '新加坡站和菲律宾站的同一规格只留一份；已附在正文里的注 3 不再重复'
    # 脚注先被选中时，后面的正文去掉附带的同一条注
    picked = evidence.select({'oppo-enco-air4-pro': [footnote, body]}, corpus)
    assert [c.id for c in picked] == [footnote.id, body.id] and '（注 3' not in picked[1].text


def test_merged_ranking_alternates_products_and_keeps_each_snippet_once():
    a = [chunk(i, 'oppo-enco-air4', f'a{i}') for i in range(3)]
    b = [chunk(i, 'oppo-enco-air4-pro', f'b{i}') for i in range(1)]
    assert [c.id for c in evidence.merged_ranking({'x': a, 'y': b})] == [a[0].id, b[0].id, a[1].id, a[2].id]


@need_sources
def test_b_plus_keeps_spec_groups_apart_and_leaves_the_experiment_b_unchanged():
    entry = next(s for s in corpus.sources() if s['source_id'] == 'oppo-enco-air4--01')
    plus = corpus.chunk_structured(entry, 'B+', keep_spec_groups=True)
    codec = [c for c in plus if 'Codec AAC/SBC' in c.text]
    assert len(codec) == 1 and 'ETEE1' not in codec[0].text and 'Fresh Mint' not in codec[0].text, 'Air4 的蓝牙编码单独成段'
    merged = corpus.chunk_structured(entry)
    assert any('Codec AAC/SBC' in c.text and 'ETEE1' in c.text for c in merged), '实验的 B 仍是合并后的旧切分'
    product_page = next(s for s in corpus.sources() if s['source_id'] == 'oppo-enco-air4-pro--03')
    assert [c.text for c in corpus.chunk_structured(product_page, 'B+', True)] == [c.text for c in corpus.chunk_structured(product_page)], '只改规格页'


EVIDENCE = [
    dict(chunk_id='B+:oppo-enco-air4--01:3', product_id='oppo-enco-air4', product='OPPO Enco Air4', source_id='oppo-enco-air4--01', source='官网规格页',
         region='海外站（Global），型号 ETEE1', position='正文', url='https://example.test/air4', text='Bluetooth® Codec AAC/SBC Bluetooth® Version Bluetooth® 5.4'),
    dict(chunk_id='B+:oppo-enco-air4-pro--03:27', product_id='oppo-enco-air4-pro', product='OPPO Enco Air4 Pro', source_id='oppo-enco-air4-pro--03',
         source='官网产品页', region='菲律宾站', position='Remarks › 注 3', url='https://example.test/pro',
         text='3. LHDC transmission should be built via Bluetooth® connection between two LHDC-supported devices. ColorOS 13.1 or later versions, Find X6 and later.'),
]


@pytest.fixture
def fake_evidence(monkeypatch):
    calls = []

    def retrieve(question, product_ids):
        calls.append((question, product_ids))
        return [dict(e) for e in EVIDENCE if e['product_id'] in product_ids]
    monkeypatch.setattr(agent.evidence_tool, 'retrieve', retrieve)
    return calls


def ask():
    return response(call('retrieve_evidence', product_ids=['oppo-enco-air4', 'oppo-enco-air4-pro'], question='LHDC 兼容条件'))


def test_evidence_answer_may_quote_cited_numbers_and_returns_traceable_sources(fake_evidence):
    state = update_conditions(empty_state(), [dict(op='set', field='budget', kind='hard', value=300)], 'ui')['state']
    text = ('{{oppo-enco-air4.name}}只写了 AAC/SBC [S1]；{{oppo-enco-air4-pro.name}}的 LHDC 需要手机也支持 [S2]，'
            'OPPO 手机要 ColorOS 13.1 及以上 [S2]。你用的是哪款手机、什么系统版本？')
    result, model = run([ask(), done(text, product_refs=['oppo-enco-air4', 'oppo-enco-air4-pro'])], 'Air4 和 Pro 能用 LHDC 吗', state)
    assert fake_evidence == [('LHDC 兼容条件', ['oppo-enco-air4', 'oppo-enco-air4-pro'])]
    sent = model.inputs[1][-1].parts[0].function_response.response
    assert [(e['ref'], e['product_id'], e['source_id'], e['position']) for e in sent['evidence']] == [
        ('S1', 'oppo-enco-air4', 'oppo-enco-air4--01', '正文'), ('S2', 'oppo-enco-air4-pro', 'oppo-enco-air4-pro--03', 'Remarks › 注 3')]
    assert 'ColorOS 13.1 及以上 [S2]' in result.reply and result.reply.startswith('OPPO Enco Air4只写了')
    assert [(e.ref, e.sourceId, e.url) for e in result.evidence] == [('S1', 'oppo-enco-air4--01', 'https://example.test/air4'),
                                                                      ('S2', 'oppo-enco-air4-pro--03', 'https://example.test/pro')]
    assert result.state.model_dump(exclude_unset=True) == state, '证据检索不改条件'
    assert [t.name for t in result.tools] == ['retrieve_evidence', 'respond'] and result.recommendations is None


@pytest.mark.parametrize('bad,why', [
    ('LHDC 需要 ColorOS 13.1 及以上。', '必须标注'),
    ('LHDC 需要 ColorOS 14 及以上 [S2]。', '数值一致'),
    ('Pro 售价 299 元 [S2]。', '占位符'),
    ('Pro 的 LHDC 条件见 [S9]，需要 ColorOS 13.1。', '没有取回'),
])
def test_evidence_numbers_must_be_cited_and_match_the_snippet(fake_evidence, bad, why):
    result, model = run([ask(), done(bad), done('LHDC 需要手机也支持 [S2]，请告诉我你的手机型号。')], 'Pro 能用 LHDC 吗', empty_state())
    error = model.inputs[2][-1].parts[0].function_response.response['error']
    assert why in error and result.reply.startswith('LHDC 需要手机也支持')


def test_without_retrieved_evidence_the_old_no_digits_rule_still_applies():
    result, model = run([say('ColorOS 13.1 及以上可以用 [S1]。'), say('需要先查官网资料才能回答兼容条件。')], 'Pro 能用 LHDC 吗', empty_state())
    assert '占位符' in model.inputs[1][-1].parts[0].text and result.evidence is None


def test_unavailable_evidence_is_reported_to_the_model_and_the_chat_still_finishes(monkeypatch):
    def unavailable(question, product_ids):
        raise evidence.EvidenceUnavailable('证据向量尚未建立')
    monkeypatch.setattr(agent.evidence_tool, 'retrieve', unavailable)
    result, model = run([ask(), done('暂时查不到官网资料，只能根据已有参数说明：两款都支持主动降噪。')], 'Pro 能用 LHDC 吗', empty_state())
    error = model.inputs[1][-1].parts[0].function_response.response['error']
    assert '证据检索暂不可用：证据向量尚未建立' in error and result.tools[0].status == 'rejected' and result.evidence is None


def test_unknown_products_are_rejected_before_retrieval(fake_evidence):
    result, model = run([response(call('retrieve_evidence', product_ids=['not-a-product'], question='LHDC')), done('请告诉我具体型号。')],
                        'LHDC', empty_state())
    assert '商品不存在' in model.inputs[1][-1].parts[0].function_response.response['error'] and fake_evidence == []


def test_prompt_explains_when_to_retrieve_and_how_to_answer_with_evidence():
    from src.agent_config import SYSTEM_PROMPT
    for rule in ('调用retrieve_evidence', '比较几款就一次传入几款', '分别写，不能把一款的资料用在另一款上', '需要用户提供的就直接问',
                 '所在句子必须标注对应的[S编号]', '价格和预算仍只用占位符', '说明地区版本未核实'):
        assert rule in SYSTEM_PROMPT
    assert 'LHDC' not in SYSTEM_PROMPT and 'ColorOS' not in SYSTEM_PROMPT, '提示词不写具体题目的答案'
