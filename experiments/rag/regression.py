"""17 道固定查询的检索回归：比较实验 B 与产品接入的检索方案。只读向量缓存，不调用 API。

    .venv/bin/python -m experiments.rag.regression

方案：
  B          实验原样：问题涉及的商品放在同一个排名里，按排名装入上下文（应复现 20261103-011256 的 B 组结果）
  B+均衡     同一份 B 片段，按商品分别排名、平均分配预算、每款先放最相关的规格页片段、跨来源去重（src/evidence.select）
  B+规格+均衡  产品接入方案：规格页按规格组切分（B+），其余同上；需要先 `python -m src.evidence --build` 建好新片段的向量
查询、Ground Truth、判分与实验完全相同。修复方案参考过这些查询的表现，这里是已知用例的回归，不能证明对新问题的泛化能力。
输出 experiments/rag/results/regression-<时间>/：report.md、metrics.csv、run.json（只记片段 ID 和覆盖情况，不含厂商原文）。
"""
from datetime import datetime
import json
from pathlib import Path
import statistics
from src import evidence
from . import corpus, evaluate as ev, retrieval as rt
from .run import GROUND_TRUTH, HERE, git, sha, write_csv

HISTORY = HERE / 'results' / '20261103-011256' / 'run.json'
VARIANTS = {'B': ('B', False), 'B+均衡': ('B', True), 'B+规格+均衡': ('B+', True)}


class CacheOnly(rt.GeminiEmbedder):
    """只用已有缓存；缺向量时报错，不调用 API。"""

    def __init__(self):
        super().__init__(client=None)

    def call(self, texts, task):
        raise LookupError(texts)


def run_variant(name, scheme, balanced, queries, embedder, units):
    chunks = corpus.build(scheme)
    try:
        index = rt.Index(chunks, embedder)
        vectors = embedder.embed([q['text'] for q in queries], 'RETRIEVAL_QUERY')
    except LookupError:
        missing = sum(embedder.key(c.index_text, 'RETRIEVAL_DOCUMENT') not in embedder.cache for c in chunks)
        calls = -(-missing // rt.EMBED_BATCH)
        return dict(name=name, status=f'未运行：缺少 {missing} 段片段向量（先运行 .venv/bin/python -m src.evidence --build，约 {calls} 次 Embedding 调用）', chunks=len(chunks))
    rows = []
    for q, v in zip(queries, vectors):
        if balanced:
            per = {pid: [index.chunks[i] for i, _ in index.search(q['text'], v, {pid})] for pid in q['products']}
            ranked, context = evidence.merged_ranking(per), evidence.select(per, corpus)
        else:
            ranked = [index.chunks[i] for i, _ in index.search(q['text'], v, set(q['products']))]
            context, _ = rt.pack(ranked)
        m = ev.retrieval_metrics(ranked, context, q, units, rt.TOP_K)
        rows.append(dict(query=q['id'], type=q['type'], **m, context_chunks=len(context),
                         context_tokens=round(sum(corpus.est_tokens(c.label() + '\n' + c.text) for c in context)),
                         context_ids=[c.id for c in context],
                         context_products=sorted({c.product_id for c in context}), top5=[c.id for c in ranked[:rt.TOP_K]]))
    return dict(name=name, status='ok', chunks=len(chunks), rows=rows)


def totals(rows):
    return dict(hit1=sum(r['hit1'] for r in rows), recall=round(statistics.mean(r['recall'] for r in rows), 3), full=sum(r['full'] for r in rows),
                context_recall=round(statistics.mean(r['context_recall'] for r in rows), 3), wrong_top5=sum(r['wrong_product'] for r in rows), n=len(rows))


def history_rows():
    data = json.loads(HISTORY.read_text(encoding='utf-8'))
    return {r['query']: r for r in data['retrieval'] if r['stage'] == 'B' and r['mode'] == 'filtered'}


def ranks(r):
    return ' / '.join('—' if x is None else str(x) for x in r['first_ranks'])


def report(out, variants, history, gt):
    ids = [q['id'] for q in gt['queries']] + [m['id'] for m in gt['main']]
    names = [v['name'] for v in variants if v['status'] == 'ok']
    by = {v['name']: {r['query']: r for r in v['rows']} for v in variants if v['status'] == 'ok'}
    reproduced = 'B' in by and all(by['B'][q]['first_ranks'] == history[q]['first_ranks'] and by['B'][q]['context_recall'] == history[q]['context_recall'] for q in ids)
    lines = ['# 17 道固定查询的检索回归', '',
             f"> {out.name} · 只读向量缓存，未调用 API · 查询与 Ground Truth 同实验 20261103-011256（sha {sha(GROUND_TRUTH)}）",
             '> 修复方案参考过这些查询的表现：这是已知用例的回归验证，不能证明对新问题的泛化能力。', '',
             f"历史 B 组复现：{'与实验记录逐题一致' if reproduced else '与实验记录不一致，结果需核查'}。", '',
             '## 汇总（按商品过滤）', '', '| 方案 | 片段数 | Hit@1 | Recall@5 均值 | Top-5 完整召回 | 上下文召回均值 | Top-5 其他商品片段 | 状态 |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
    for v in variants:
        if v['status'] == 'ok':
            t = totals(v['rows'])
            lines.append(f"| {v['name']} | {v['chunks']} | {t['hit1']}/{t['n']} | {t['recall']} | {t['full']}/{t['n']} | {t['context_recall']} | {t['wrong_top5']} | 已运行 |")
        else:
            lines.append(f"| {v['name']} | {v['chunks']} | — | — | — | — | — | {v['status']} |")
    lines += ['', '## 逐题：必要证据首个命中排名 / 上下文召回', '', '| 题目 | 类型 | ' + ' | '.join(names) + ' |', '| --- | --- |' + ' --- |' * len(names)]
    for q in ids:
        cells = [f"{ranks(by[n][q])}（上下文 {by[n][q]['context_recall']:.2f}）" for n in names]
        lines.append(f"| {q} | {by[names[0]][q]['type'] if names else ''} | {' | '.join(cells)} |")
    for n in names[1:]:
        worse = [q for q in ids if (by[n][q]['context_recall'], by[n][q]['recall'], by[n][q]['hit1']) < (by['B'][q]['context_recall'], by['B'][q]['recall'], by['B'][q]['hit1'])]
        better = [q for q in ids if (by[n][q]['context_recall'], by[n][q]['recall'], by[n][q]['hit1']) > (by['B'][q]['context_recall'], by['B'][q]['recall'], by['B'][q]['hit1'])]
        lines += ['', f'**{n} 相比 B：** 变好 {"、".join(better) or "无"}；退步 {"、".join(worse) or "无"}（按上下文召回、Recall@5、Hit@1 依次比较）']
    lines += ['', '## RAG-02 / RAG-05 上下文里的商品与必要证据', '']
    for n in names:
        for q in ('RAG-02', 'RAG-05'):
            r = by[n][q]
            groups = next(m['required'] for m in gt['main'] if m['id'] == q)
            lines.append(f"- {n} · {q}：上下文 {r['context_chunks']} 段约 {r['context_tokens']} Token，商品 {'、'.join(r['context_products'])}；"
                         f"上下文召回 {r['context_recall']:.2f}（必要证据组 {' | '.join(' 或 '.join(g) for g in groups)}）")
    (out / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main():
    gt = json.loads(GROUND_TRUTH.read_text(encoding='utf-8'))
    queries = gt['queries'] + [dict(id=m['id'], type='主问题', text=m['question'], products=m['products'], required=m['required']) for m in gt['main']]
    embedder = CacheOnly()
    variants = [run_variant(n, scheme, balanced, queries, embedder, gt['units']) for n, (scheme, balanced) in VARIANTS.items()]
    out = HERE / 'results' / f"regression-{datetime.now():%Y%m%d-%H%M%S}"
    out.mkdir(parents=True)
    history = history_rows()
    (out / 'run.json').write_text(json.dumps(dict(date=datetime.now().astimezone().isoformat(timespec='seconds'), api_calls=embedder.calls,
                                                  commit=git('rev-parse', '--short', 'HEAD'), uncommitted=bool(git('status', '--porcelain')),
                                                  embed_model=rt.EMBED_MODEL, budget=evidence.BUDGET, spec_first=evidence.SPEC_FIRST,
                                                  code={p: sha(corpus.ROOT / p) for p in ('src/evidence.py', 'experiments/rag/corpus.py', 'experiments/rag/retrieval.py')},
                                                  variants=variants), ensure_ascii=False, indent=1), encoding='utf-8')
    write_csv(out / 'metrics.csv', [dict(variant=v['name'], query=r['query'], type=r['type'], hit1=r['hit1'], recall=r['recall'], full=r['full'],
                                         context_recall=r['context_recall'], wrong_top5=r['wrong_product'], first_ranks=ranks(r),
                                         context_chunks=r['context_chunks'], context_tokens=r['context_tokens'],
                                         context_products=';'.join(r['context_products']), context_ids=';'.join(r['context_ids']))
                                    for v in variants if v['status'] == 'ok' for r in v['rows']])
    report(out, variants, history, gt)
    print((out / 'report.md').read_text(encoding='utf-8'))
    print(f'输出：{out}（Embedding 调用 {embedder.calls} 次）')


if __name__ == '__main__':
    main()
