"""ShopMate 商品证据 RAG 对照实验：A 普通切分+向量，B 结构化切分+向量，C 结构化切分+向量+BM25+RRF。

用法（项目根目录；依赖见 requirements-rag.txt）：
    .venv/bin/python -m experiments.rag.run             # 真实运行：调用 Gemini Embedding 和生成（消耗免费额度，Embedding 有缓存）
    .venv/bin/python -m experiments.rag.run --offline   # 离线自测：哈希向量 + 占位回答，只检查流程，结果不是实验结论

三组共用同一份语料、Embedding 模型、生成模型、回答 Prompt、检索深度和上下文预算；主问题每组只生成一次。
输出到 experiments/rag/results/<时间>/：answers.md、retrieval_results.csv、metrics.csv、report.md，完整记录在 run.json。
不经过 ShopMate Agent，也不受 Agent 回复校验（禁止写数字等）的约束，结果不代表产品当前表现。
"""
import argparse
import csv
from dataclasses import asdict
from datetime import datetime
import hashlib
import json
import os
import platform
import re
import statistics
import subprocess
import time
from pathlib import Path
from google import genai
from google.genai import errors, types
from . import corpus, evaluate as ev, retrieval as rt

HERE = Path(__file__).resolve().parent
GROUND_TRUTH = HERE / 'ground_truth.json'
STAGES = {'A': ('A', False, '普通切分 + 向量检索'), 'B': ('B', False, '结构化切分 + 向量检索'), 'C': ('B', True, '结构化切分 + 向量 + BM25 + RRF')}
MODES = {'filtered': '按商品过滤', 'unfiltered': '全库检索'}

SYSTEM = """你是 ShopMate 的商品证据助手，帮助用户做购物判断。只能依据用户消息里提供的证据片段回答。
1. 每个关键事实后用 [S编号] 标注所依据的片段；证据里没有的信息不要补充，也不要用常识推断具体型号的参数。
2. 注意每个片段所属的商品型号、来源和地区版本，不要把一个型号的资料用在另一个型号上。
3. 区分资料写明的事实、你的推断和资料没有提供的信息；资料不足以下结论时直接说明，并指出需要用户补充或核实什么。
4. 不保证实际使用体验，不做资料不支持的比较结论。
5. 用简体中文，先给结论，再说依据和限制，不超过 250 字。"""


def answer_prompt(question, context):
    evidence = '\n\n'.join(f'[S{i}] {c.label()}\n{c.text}' for i, c in enumerate(context, 1))
    return f'证据片段：\n\n{evidence}\n\n用户问题：{question}'


class GeminiGenerator:
    def __init__(self, client, model, pause=4.0):
        self.client, self.model, self.pause, self.calls = client, model, pause, 0

    def generate(self, system, prompt, json_mode=False):
        config = types.GenerateContentConfig(system_instruction=system, max_output_tokens=2048 if json_mode else 1024,
                                             thinking_config=types.ThinkingConfig(thinking_level='low'),
                                             response_mime_type='application/json' if json_mode else None)
        for attempt in range(3):
            try:
                began = time.monotonic()
                r = self.client.models.generate_content(model=self.model, contents=prompt, config=config)
                self.calls += 1
                time.sleep(self.pause)
                u, cand = r.usage_metadata, (r.candidates or [None])[0]
                return dict(status='ok', text=(r.text or '').strip(), model_version=r.model_version, seconds=round(time.monotonic() - began, 1),
                            finish=getattr(cand and cand.finish_reason, 'name', None),
                            tokens=dict(prompt=u.prompt_token_count, thinking=u.thoughts_token_count, output=u.candidates_token_count) if u else None)
            except errors.APIError as e:
                if e.code == 429 and attempt < 2:
                    time.sleep(rt.retry_delay(e) or 30)
                    continue
                return dict(status=f'失败：{e.code} {e.status}', text='', model_version=None, tokens=None)
        return dict(status='失败：重试后仍受限', text='', model_version=None, tokens=None)


class OfflineGenerator:
    model, calls = 'offline（离线自测）', 0

    def generate(self, system, prompt, json_mode=False):
        return dict(status='离线自测', text='{"criteria": [], "violations": [], "unsupported": []}' if json_mode else '【离线自测占位，不是模型回答】',
                    model_version=None, tokens=None)


def git(*args):
    return subprocess.run(['git', *args], cwd=corpus.ROOT, capture_output=True, text=True).stdout.strip()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]


def split_units(chunks_by_scheme, units, sources):
    """哪些证据单元在原文里完整存在，却没有任何一个片段完整包含（被切断）。"""
    plain = {s['source_id']: corpus.norm(corpus.plain_text(s['html'])) for s in sources}
    out = {}
    for scheme, chunks in chunks_by_scheme.items():
        out[scheme] = [uid for uid, u in units.items()
                       if any(re.search(u['pattern'], plain[s]) for s in u['sources'] if s in plain)
                       and not any(ev.covers(c, u) for c in chunks)]
    return out


def run(out, embedder, generator, offline, chunk_dir=corpus.ROOT / 'data/rag/chunks'):
    began = time.monotonic()
    gt = json.loads(GROUND_TRUTH.read_text(encoding='utf-8'))
    units, sources = gt['units'], corpus.sources()
    chunks = {s: corpus.build(s) for s in 'AB'}
    for scheme, items in chunks.items():
        corpus.save(items, chunk_dir / f'{scheme}.jsonl')
    print(f"切分完成：A {len(chunks['A'])} 段，B {len(chunks['B'])} 段；开始 Embedding（{embedder.name}）", flush=True)
    indexes = {s: rt.Index(items, embedder) for s, items in chunks.items()}
    queries = gt['queries'] + [dict(id=m['id'], type='主问题', text=m['question'], products=m['products'], required=m['required']) for m in gt['main']]
    vectors = embedder.embed([q['text'] for q in queries], 'RETRIEVAL_QUERY')

    retrieval, rows = [], []
    contexts = {}
    for stage, (scheme, hybrid, _) in STAGES.items():
        index = indexes[scheme]
        for mode in MODES:
            for q, v in zip(queries, vectors):
                hits = index.search(q['text'], v, set(q['products']) if mode == 'filtered' else None, hybrid)
                ranked = [index.chunks[i] for i, _ in hits]
                context, used = rt.pack(ranked)
                if mode == 'filtered':
                    contexts[(stage, q['id'])] = (context, used)
                m = ev.retrieval_metrics(ranked, context, q, units, rt.TOP_K)
                retrieval.append(dict(stage=stage, mode=mode, query=q['id'], type=q['type'], **m, context_chunks=len(context), context_tokens=used))
                for rank, (i, info) in enumerate(hits[:max(rt.TOP_K, len(context))], 1):
                    c = index.chunks[i]
                    rows.append(dict(stage=stage, mode=MODES[mode], query_id=q['id'], query=q['text'], rank=rank, chunk_id=c.id, product_id=c.product_id,
                                     source_id=c.source_id, region=c.region, position=c.position, kind=c.kind,
                                     vector_rank=info.get('vector_rank'), bm25_rank=info.get('bm25_rank') or '', score=round(info['score'], 5),
                                     in_scope=c.product_id in q['products'], in_context=rank <= len(context),
                                     covers=';'.join(u for u in units if ev.covers(c, units[u])), excerpt=c.text.replace('\n', ' ')[:120]))

    print('检索完成；开始生成主问题回答和辅助评分', flush=True)
    answers = []
    for main in gt['main']:
        for stage in STAGES:
            context, used = contexts[(stage, main['id'])]
            reply = generator.generate(SYSTEM, answer_prompt(main['question'], context))
            print(f"  {main['id']} · {stage}：{reply['status']}", flush=True)
            text = reply['text']
            judge_raw = generator.generate('你是严格的事实核查评审，只输出 JSON。', ev.judge_prompt(main, text, context), json_mode=True) if text else None
            judge = ev.parse_judge(judge_raw['text']) if judge_raw and judge_raw['status'] == 'ok' else None
            criteria, errors_found, trace = score(main, text, context, judge, units)
            answers.append(dict(main=main['id'], stage=stage, status=reply['status'], text=text, tokens=reply.get('tokens'), model_version=reply.get('model_version'),
                                context=[dict(n=n, id=c.id, label=c.label(), text=c.text, covers=[u for u in units if ev.covers(c, units[u])]) for n, c in enumerate(context, 1)],
                                context_tokens=used, criteria=criteria, errors=errors_found, trace=trace,
                                judge_status=judge_raw['status'] if judge_raw else '未运行', judge=judge,
                                judge_raw=judge_raw['text'] if judge_raw and not judge else None))

    stats = {s: dict(chunks=len(c), mean_tokens=round(statistics.mean(corpus.est_tokens(x.text) for x in c), 1),
                     footnotes=sum(x.kind == 'footnote' for x in c), linked=sum(bool(x.links) for x in c)) for s, c in chunks.items()}
    data = dict(
        run_id=out.name, offline=offline, date=datetime.now().astimezone().isoformat(timespec='seconds'), seconds=round(time.monotonic() - began),
        config=dict(embed_model=embedder.name, embed_dim=rt.EMBED_DIM if not offline else 256, generator=generator.model, generation='thinking_level=low，默认温度，每组每题 1 次',
                    judge='与生成相同的模型（自评偏差风险）', top_k=rt.TOP_K, context_budget=rt.CONTEXT_BUDGET, rrf_k=rt.RRF_K, bm25=dict(k1=rt.BM25_K1, b=rt.BM25_B),
                    a_window=dict(tokens=corpus.A_TOKENS, overlap=corpus.A_OVERLAP), b_chunk=dict(max_tokens=corpus.B_MAX, merge_below=corpus.B_SMALL, footnote_cap_chars=corpus.FOOTNOTE_CAP),
                    system_prompt_sha=hashlib.sha256(SYSTEM.encode()).hexdigest()[:16]),
        versions=dict(commit=git('rev-parse', '--short', 'HEAD'), uncommitted=bool(git('status', '--porcelain')), python=platform.python_version(),
                      genai=genai.__version__, faiss=rt.faiss.__version__, ground_truth=sha(GROUND_TRUTH), code={p.name: sha(p) for p in sorted(HERE.glob('*.py'))}),
        api=dict(embedding_calls=embedder.calls, embedded_texts=embedder.embedded, cache_hits=embedder.cached, rate_limit_waits=embedder.waits, generation_calls=generator.calls),
        sources=[dict(source_id=s['source_id'], product_id=s['product_id'], region=s['region_version'], sha256_ok=s['sha256_ok']) for s in sources],
        chunks=stats, split_units=split_units(chunks, units, sources), retrieval=retrieval, answers=answers)
    out.mkdir(parents=True, exist_ok=True)
    write_csv(out / 'retrieval_results.csv', rows)
    write_outputs(out, data, gt)
    return data


def score(main, text, context, judge, units):
    """规则评分（主）、LLM 辅助结果对照、归因和可追溯检查；不调用 API，--rescore 也用它。"""
    checks, errors_found = ev.RULES[main['id']](text) if text else ({c['id']: (False, '没有回答') for c in main['criteria']}, [])
    criteria = []
    for c in main['criteria']:
        passed, why = checks[c['id']]
        j = (judge or {}).get('criteria', {}).get(c['id']) if judge else None
        criteria.append(dict(id=c['id'], text=c['text'], rule=passed, rule_detail=why, judge=None if j is None else bool(j.get('pass')),
                             judge_reason=None if j is None else f"{j.get('reason', '')}（引用：{j.get('quote', '')}）",
                             review=j is None or bool(j.get('pass')) != passed, attribution=ev.attribute(main, c, passed, context, units)))
    return criteria, errors_found, ev.traceability(text, context, main['id'])


# 已知的评分器修正：只改程序缺陷，不改参考要点和规则的匹配范围；--rescore 后写入 run.json
SCORER_FIXES = ['引用解析支持“[S1, S6]”这种一个括号里多个编号的写法（原先只识别“[S1]”，引用统计偏少）',
                '否定词加入“不足以/得不出”（原先把“资料不足以得出一加更强的结论”误判为“断言一加更强”）']


def rescore(out):
    """用已保存的回答和上下文重新评分并重写报告，不调用 API。"""
    from types import SimpleNamespace
    gt = json.loads(GROUND_TRUTH.read_text(encoding='utf-8'))
    data = json.loads((out / 'run.json').read_text(encoding='utf-8'))
    mains = {m['id']: m for m in gt['main']}
    for a in data['answers']:
        context = [SimpleNamespace(source_id=c['id'].split(':')[1], text=c['text']) for c in a['context']]
        a['criteria'], a['errors'], a['trace'] = score(mains[a['main']], a['text'], context, a['judge'], gt['units'])
    data['rescored'] = dict(at=datetime.now().astimezone().isoformat(timespec='seconds'), fixes=SCORER_FIXES,
                            code={p.name: sha(p) for p in sorted(HERE.glob('*.py'))})
    write_outputs(out, data, gt)
    return data


def write_outputs(out, data, gt):
    from .report import load_review, write_answers, write_report
    review = load_review(out)
    (out / 'run.json').write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding='utf-8')
    write_csv(out / 'metrics.csv', metric_rows(data, review))
    write_answers(out / 'answers.md', data, gt, review)
    write_report(out / 'report.md', data, gt, review)


def summarize(retrieval, stage, mode, ids=None):
    items = [r for r in retrieval if r['stage'] == stage and r['mode'] == mode and (ids is None or r['query'] in ids)]
    return dict(queries=len(items), hit1=sum(r['hit1'] for r in items), recall=round(statistics.mean(r['recall'] for r in items), 3),
                full=sum(r['full'] for r in items), context_recall=round(statistics.mean(r['context_recall'] for r in items), 3),
                wrong_top5=sum(r['wrong_product'] for r in items), top1_wrong=sum(r['top1_wrong'] for r in items))


def metric_rows(data, review=None):
    rows = []
    for stage in STAGES:
        for mode in MODES:
            rows.append(dict(level='检索汇总（全部 17 题）', stage=stage, mode=MODES[mode], **summarize(data['retrieval'], stage, mode)))
    for r in data['retrieval']:
        rows.append(dict(level='检索单题', stage=r['stage'], mode=MODES[r['mode']], item=r['query'], type=r['type'], hit1=r['hit1'], recall=round(r['recall'], 3),
                         full=r['full'], context_recall=round(r['context_recall'], 3), wrong_top5=r['wrong_product'], top1_wrong=r['top1_wrong'],
                         first_ranks=' / '.join('—' if x is None else str(x) for x in r['first_ranks']), context_chunks=r['context_chunks'], context_tokens=r['context_tokens']))
    for a in data['answers']:
        rows.append(dict(level='回答', stage=a['stage'], mode='按商品过滤', item=a['main'], status=a['status'],
                         rule_pass=f"{sum(c['rule'] for c in a['criteria'])}/{len(a['criteria'])}",
                         judge_pass='—' if not a['judge'] else f"{sum(bool(c['judge']) for c in a['criteria'])}/{len(a['criteria'])}",
                         needs_review=sum(c['review'] for c in a['criteria']), errors=len(a['errors']), untraceable=';'.join(a['trace']['untraceable']),
                         citations=len(a['trace']['cited']), context_chunks=len(a['context']), context_tokens=a['context_tokens'],
                         review_pass=review_score(review, a),
                         prompt_tokens=(a['tokens'] or {}).get('prompt'), output_tokens=(a['tokens'] or {}).get('output')))
    return rows


def review_score(review, a):
    verdicts = (review or {}).get('answers', {}).get(f"{a['main']}/{a['stage']}")
    return f"{sum(v['pass'] for v in verdicts.values())}/{len(verdicts)}" if verdicts else ''


def write_csv(path, rows):
    fields = list(dict.fromkeys(k for r in rows for k in r))
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fields)
        w.writeheader()
        w.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description='ShopMate 商品证据 RAG 对照实验（A/B/C）')
    parser.add_argument('--offline', action='store_true', help='离线自测：不调用 API，结果不是实验结论')
    parser.add_argument('--out', type=Path, help='输出目录，默认 experiments/rag/results/<时间>')
    parser.add_argument('--rescore', type=Path, metavar='DIR', help='用已有运行目录里保存的回答重新评分并重写报告，不调用 API')
    args = parser.parse_args()
    if args.rescore:
        rescore(args.rescore)
        print(f'已重新评分：{args.rescore}')
        return
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    out = args.out or HERE / 'results' / (f'offline-{stamp}' if args.offline else stamp)
    if args.offline:
        embedder, generator = rt.HashEmbedder(), OfflineGenerator()
    else:
        from src import agent_config as config  # 加载项目 .env；不输出密钥
        if not os.getenv('GEMINI_API_KEY', '').strip():
            raise SystemExit('未配置 GEMINI_API_KEY：请在项目根目录 .env 中填写。')
        if config.model_name() not in config.FREE_FUNCTION_MODELS:
            raise SystemExit(f'GEMINI_MODEL={config.model_name()} 不在已核实的免费模型名单内。')
        client = genai.Client(api_key=os.environ['GEMINI_API_KEY'], vertexai=False,
                              http_options=types.HttpOptions(timeout=90_000, retry_options=types.HttpRetryOptions(attempts=1)))
        embedder, generator = rt.GeminiEmbedder(client), GeminiGenerator(client, config.model_name())
    data = run(out, embedder, generator, args.offline)
    print(f"完成（{data['seconds']} 秒）：{out}")
    print(f"Embedding 调用 {data['api']['embedding_calls']} 次（新向量 {data['api']['embedded_texts']} 条，缓存命中 {data['api']['cache_hits']} 条），生成调用 {data['api']['generation_calls']} 次")


if __name__ == '__main__':
    main()
