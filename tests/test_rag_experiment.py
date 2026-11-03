"""RAG 对照实验（experiments/rag）的离线自测：不调用 Gemini，只检查标准答案、切分、检索流程和评分规则本身。
原始资料只在本地（data/rag/sources/ 不进仓库），缺少时跳过依赖原文的测试。"""
import json
import re
from pathlib import Path
import pytest

pytest.importorskip('faiss')
pytest.importorskip('bs4')
from experiments.rag import corpus, evaluate as ev, retrieval as rt  # noqa: E402
from experiments.rag.run import OfflineGenerator, run  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
GT = json.loads((ROOT / 'experiments/rag/ground_truth.json').read_text(encoding='utf-8'))
SOURCES = corpus.sources()
need_sources = pytest.mark.skipif(len(SOURCES) < 18, reason='本地没有 RAG 原始资料')


@need_sources
def test_every_evidence_unit_is_verbatim_in_exactly_its_listed_sources():
    plain = {s['source_id']: (s['product_id'], corpus.norm(corpus.plain_text(s['html']))) for s in SOURCES}
    for uid, unit in GT['units'].items():
        found = {sid for sid, (product, text) in plain.items() if product == unit['product'] and re.search(unit['pattern'], text)}
        assert found == set(unit['sources']), uid
        assert re.search(unit['pattern'], corpus.norm(unit['quote'])), f'{uid} 的 quote 应包含 pattern'
    assert all(s['sha256_ok'] for s in SOURCES)


def test_questions_reference_known_units_and_main_questions_match_the_rag_doc():
    rag_doc = (ROOT / 'docs/ShopMate_RAG_Eval_V0.1.md').read_text(encoding='utf-8')
    for main in GT['main']:
        assert f"**用户问题：**“{main['question']}”" in rag_doc
        for c in main['criteria']:
            assert all(u in GT['units'] for g in c['needs'] for u in g)
    items = GT['queries'] + GT['main']
    assert 10 <= len(GT['queries']) <= 15 and len({q['id'] for q in items}) == len(items)
    for q in items:
        assert q['required'] and all(GT['units'][u]['product'] in q['products'] for g in q['required'] for u in g)


@need_sources
def test_structured_chunks_link_lhdc_claims_and_the_27db_claim_to_their_footnotes():
    by_source = {s['source_id']: corpus.chunk_structured(s) for s in SOURCES if s['source_id'] in ('oppo-enco-air4-pro--03', 'huawei-freebuds-6i--01')}
    pro, units = by_source['oppo-enco-air4-pro--03'], GT['units']
    remark = [c for c in pro if c.kind == 'footnote' and ev.covers(c, units['PRO-DUAL'])]
    assert len(remark) == 1, '页面重复渲染 3 次的 Remarks 去重后只剩一份'
    body = [c for c in pro if c.kind == 'body' and 'transmission[^3]' in c.text]
    assert body and remark[0].id in body[0].links and ev.covers(body[0], units['PRO-PHONES']), 'LHDC 正文附上了注 3 的兼容条件'
    huawei = by_source['huawei-freebuds-6i--01']
    claim = next(c for c in huawei if c.kind == 'body' and '可达 27 dB [^1]' in c.text)
    assert ev.covers(claim, units['HW-27DEF']) and claim.links


@need_sources
def test_plain_chunks_are_fixed_windows_with_overlap():
    entry = next(s for s in SOURCES if s['source_id'] == 'oppo-enco-air4-pro--03')
    chunks = corpus.chunk_plain(entry)
    assert all(corpus.est_tokens(c.text) <= corpus.A_TOKENS for c in chunks)
    first, second = chunks[0].text, chunks[1].text
    assert second[:20] in first, '相邻窗口有重叠'


def test_bm25_tokens_treat_spaced_units_alike_and_split_chinese_into_bigrams():
    assert rt.tokens('49dB') == rt.tokens('49 dB') == ['49', 'db']
    assert rt.tokens('LHDC 5.0/AAC') == ['lhdc', '5.0', 'aac'] and rt.tokens('平均降噪') == ['平均', '均降', '降噪']


def fake_chunk(i, product, text):
    return corpus.Chunk(id=f'T:{i}', scheme='T', product_id=product, source_id=f'{product}--01', region='测试', source_type='official_spec_page',
                        text=text, index_text=text, position='正文')


def test_scope_filter_applies_to_both_retrieval_paths_before_fusion():
    chunks = [fake_chunk(0, 'oppo-enco-air4', 'Air4 codec AAC SBC'), fake_chunk(1, 'oppo-enco-air4-pro', 'Air4 Pro codec LHDC 5.0 AAC SBC'),
              fake_chunk(2, 'oneplus-buds-3', 'Buds 3 codec LHDC AAC SBC'), fake_chunk(3, 'oppo-enco-air4-pro', 'Air4 Pro ColorOS 13.1 Find X6')]
    index, embedder = rt.Index(chunks, rt.HashEmbedder()), rt.HashEmbedder()
    query = 'LHDC codec'
    vector = embedder.embed([query], 'RETRIEVAL_QUERY')[0]
    for hybrid in (False, True):
        hits = index.search(query, vector, {'oppo-enco-air4-pro'}, hybrid)
        assert {chunks[i].product_id for i, _ in hits} == {'oppo-enco-air4-pro'}
        assert len(index.search(query, vector, None, hybrid)) >= 3
    order, scores = rt.rrf([1, 3], [3, 1])
    assert scores[1] == scores[3] == 1 / 61 + 1 / 62


B0_RAG02 = ('OPPO Enco Air4 Pro支持 LHDC 协议（搭配支持该协议的安卓手机可以开启高解析音质），售价为¥299；而OPPO Enco Air4暂未在参数中列出支持 LHDC，'
            '售价为¥169。如果你希望在安卓手机上使用高音质编码，加钱买 Pro 是可以支持 LHDC 的。')
B0_RAG05 = ('宣传参数上的降噪分贝（如华为 FreeBuds 6i的27dB 降噪深度（标称值，不代表实际降噪效果）与一加 Buds 3的最高 49dB 自适应降噪（标称值，不代表实际降噪效果））'
            '通常是实验室条件下的最大降噪深度，不能直接简单对比绝对强弱，因为各家的测试标准和频段覆盖可能有所不同。')


def test_rules_catch_the_b0_bad_cases_and_accept_a_complete_answer():
    checks, _ = ev.rule_rag02(B0_RAG02)
    assert not checks['C3'][0] and not checks['C4'][0], 'B0 没说安卓不足以确认，也没问手机型号和系统'
    good = ('不一定。Air4 只支持 AAC/SBC [S1]；Air4 Pro 支持 LHDC 5.0/AAC/SBC [S2]，但 LHDC 需要手机也支持 LHDC 才能用 [S3]。'
            '只知道是安卓手机还不能确定，请告诉我手机型号和系统版本（资料列的是 ColorOS 13.1 及以上的部分 OPPO 机型）[S3]。'
            '编码更高也不一定代表音质更好；这些是海外官网资料，国行是否一致需要核实。')
    checks, errors = ev.rule_rag02(good)
    assert all(ok for ok, _ in checks.values()) and errors == []
    checks, errors = ev.rule_rag05(B0_RAG05)
    assert any('27dB 说成最大值' in e for e in errors) and not checks['D1'][0], 'B0 把 27dB 平均值说成了最大降噪深度'
    checks, errors = ev.rule_rag05('华为的 27dB 是 50Hz–20kHz 多个频点的平均降噪深度 [S1]，一加写的是最高 49dB [S2]。两者口径不同，不能直接比较谁更强。')
    assert all(ok for ok, _ in checks.values()) and errors == []


@need_sources
def test_offline_run_writes_all_outputs_and_says_it_is_not_a_result(tmp_path):
    data = run(tmp_path / 'offline', rt.HashEmbedder(), OfflineGenerator(), offline=True, chunk_dir=tmp_path / 'chunks')
    for name in ('answers.md', 'retrieval_results.csv', 'metrics.csv', 'report.md', 'run.json'):
        assert (tmp_path / 'offline' / name).exists()
    assert '离线自测' in (tmp_path / 'offline' / 'report.md').read_text(encoding='utf-8')
    assert {a['stage'] for a in data['answers']} == {'A', 'B', 'C'} and all(a['status'] == '离线自测' for a in data['answers'])
    assert len(data['retrieval']) == 3 * 2 * (len(GT['queries']) + len(GT['main']))


HISTORY = ROOT / 'experiments/rag/results/20261103-011256/run.json'
CACHE = ROOT / 'data/rag/cache/embeddings-gemini-embedding-001-768.jsonl'


@need_sources
@pytest.mark.skipif(not (HISTORY.exists() and CACHE.exists()), reason='本地没有实验记录或向量缓存')
def test_regression_reproduces_the_historical_b_stage_from_cache_without_api_calls():
    from experiments.rag import regression
    queries = GT['queries'] + [dict(id=m['id'], type='主问题', text=m['question'], products=m['products'], required=m['required']) for m in GT['main']]
    embedder = regression.CacheOnly()
    result = regression.run_variant('B', 'B', False, queries, embedder, GT['units'])
    history = regression.history_rows()
    assert result['status'] == 'ok' and embedder.calls == 0
    assert all(r['first_ranks'] == history[r['query']]['first_ranks'] and r['context_recall'] == history[r['query']]['context_recall'] for r in result['rows'])
    balanced = regression.run_variant('B+均衡', 'B', True, queries, embedder, GT['units'])
    rag05 = next(r for r in balanced['rows'] if r['query'] == 'RAG-05')
    assert rag05['context_recall'] == 1.0 and rag05['context_products'] == ['huawei-freebuds-6i', 'oneplus-buds-3']
