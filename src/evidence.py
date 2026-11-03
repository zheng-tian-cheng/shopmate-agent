"""商品证据检索：RAG 实验 B 方案（官网 HTML 的 DOM 结构化切分 + Gemini Embedding + FAISS）接入 Agent。
切分用 B+：与 B 相同，只是官网规格页不合并相邻小片段，每个规格组单独成段（实验 Bad Case 3）。

多商品比较时按商品 ID 分别检索再合并：每款商品平均分配上下文预算，先放入该商品最相关的官网规格页片段，
再按相关度补充正文和脚注，跨来源去重。这样一款商品不会占满证据空间（RAG-02 的 Bad Case：
前五名全是 Air4 Pro，Air4 的编码规格没有进入上下文）。只读，不影响条件、筛选和推荐。

复用 experiments/rag 的切分与检索代码。原始资料只在本地（data/rag/sources/，不进仓库）；片段向量要先建好缓存：
    .venv/bin/python -m src.evidence --build    # 缺少的片段向量会调用 Gemini Embedding，已缓存的不再调用
请求时只为问题算一个查询向量（1 次 Embedding 调用）。资料、依赖或向量缓存缺失时工具返回“暂不可用”。
"""
from dataclasses import replace
import json
import logging
import os
import re
import threading

log = logging.getLogger('shopmate.evidence')
BUDGET = 1200        # 估计 Token，含来源标签；与实验 B 的上下文预算相同
SPEC_FIRST = 1       # 每款商品先放入的官网规格页片段数
DUPLICATE = 0.8      # 片段内容有八成已在已选片段中出现，视为重复
MAX_PRODUCTS = 3


class EvidenceUnavailable(Exception):
    """资料、依赖、向量缓存或 Embedding 服务不可用；Agent 把原因交给模型，照常回答。"""


def _rag():
    try:
        from experiments.rag import corpus, retrieval
    except ImportError as e:
        raise EvidenceUnavailable('证据检索依赖未安装（见 requirements-rag.txt）') from e
    return corpus, retrieval


def _gemini_embedder(retrieval):
    from google import genai
    from google.genai import types
    key = os.getenv('GEMINI_API_KEY', '').strip()
    if not key:
        raise EvidenceUnavailable('未配置 GEMINI_API_KEY')
    client = genai.Client(api_key=key, vertexai=False, http_options=types.HttpOptions(timeout=15_000, retry_options=types.HttpRetryOptions(attempts=1)))

    class RequestEmbedder(retrieval.GeminiEmbedder):
        def call(self, texts, task):  # 聊天请求里不等待限流重试，失败就报暂不可用
            result = self.client.models.embed_content(model=self.name, contents=texts,
                                                      config=types.EmbedContentConfig(task_type=task, output_dimensionality=retrieval.EMBED_DIM))
            self.calls += 1
            return [e.values for e in result.embeddings]
    return RequestEmbedder(client, pause=0)


def shingles(corpus, text, step=5):
    """20 字的连续片段。已选内容逐字取（step=1），候选内容每 5 字取一个，内容出现在任何位置都能比对上。"""
    t = corpus.norm(corpus.MARKER.sub('', text))
    return {t[i:i + 20] for i in range(0, max(1, len(t) - 19), step)}


def without_note(chunk, n):
    """去掉正文片段末尾附带的注 n（该脚注已单独放入上下文时用）。"""
    return re.sub(rf'\n（注 {n}：.*?）(?=\n（注 |\Z)', '', chunk.text, flags=re.S)


def select(per_product, corpus, budget=BUDGET):
    """每款商品分得同样的预算：先放该商品最相关的规格页片段，再按相关度放其他片段，放不下就停。
    与已选内容重复的片段跳过；脚注已经单独放入时，正文片段去掉附带的同一条注。"""
    share, picked, seen = budget / max(1, len(per_product)), [], set()
    for ranked in per_product.values():
        specs = [c for c in ranked if c.source_type == 'official_spec_page'][:SPEC_FIRST]
        used = 0.0
        for c in specs + [c for c in ranked if c not in specs]:
            ids = {p.id for p in picked}
            for link in c.links if c.kind == 'body' else []:
                if link in ids:
                    note = next(p for p in picked if p.id == link)
                    number = re.search(r'注 (\d+)', note.position)
                    c = replace(c, text=without_note(c, number.group(1))) if number else c
            sh = shingles(corpus, c.text)
            if sh and len(sh & seen) / len(sh) >= DUPLICATE:
                continue
            cost = corpus.est_tokens(c.label() + '\n' + c.text)
            if used and used + cost > share:
                break
            picked.append(c)
            seen |= shingles(corpus, c.text, step=1)
            used += cost
    return picked


def merged_ranking(per_product):
    """各商品排名轮流合并成一个列表（用于 Hit@1、Recall@5 等检索指标），同一片段只出现一次。"""
    out, seen = [], set()
    for row in zip(*[r + [None] * (max(map(len, per_product.values())) - len(r)) for r in per_product.values()]):
        for c in row:
            if c is not None and c.id not in seen:
                seen.add(c.id)
                out.append(c)
    return out


class Retriever:
    def __init__(self, embedder=None, build=False, scheme='B+'):
        corpus, retrieval = _rag()
        self.corpus = corpus
        self.chunks = corpus.build(scheme)
        if not self.chunks:
            raise EvidenceUnavailable('本地没有官网原始资料（data/rag/sources/）')
        self.embedder = embedder or _gemini_embedder(retrieval)
        cache = getattr(self.embedder, 'cache', None)
        if cache is not None and not build:
            missing = sum(self.embedder.key(c.index_text, 'RETRIEVAL_DOCUMENT') not in cache for c in self.chunks)
            if missing:
                raise EvidenceUnavailable(f'证据向量尚未建立（缺 {missing} 段），请先运行 .venv/bin/python -m src.evidence --build')
        self.index = retrieval.Index(self.chunks, self.embedder)
        manifest = json.loads(corpus.MANIFEST.read_text(encoding='utf-8'))
        self.urls = {s['source_id']: s.get('url') for s in manifest['sources']}

    def per_product(self, question, product_ids):
        vector = self.embedder.embed([question], 'RETRIEVAL_QUERY')[0]
        return {pid: [self.index.chunks[i] for i, _ in self.index.search(question, vector, {pid})] for pid in product_ids}

    def retrieve(self, question, product_ids, budget=BUDGET):
        return [self.public(c) for c in select(self.per_product(question, product_ids), self.corpus, budget)]

    def public(self, c):
        return dict(chunk_id=c.id, product_id=c.product_id, product=self.corpus.PRODUCTS[c.product_id]['displayName'], source_id=c.source_id,
                    source=self.corpus.SOURCE_TYPE.get(c.source_type, c.source_type), region=c.region, position=c.position,
                    url=self.urls.get(c.source_id), text=c.text)


_lock, _default = threading.Lock(), {}


def retrieve(question, product_ids):
    """Agent 工具使用的入口：第一次调用时加载片段和向量缓存，之后复用。"""
    with _lock:
        if 'retriever' not in _default:
            _default['retriever'] = Retriever()
        retriever = _default['retriever']
    try:
        found = retriever.retrieve(question, product_ids)
    except EvidenceUnavailable:
        raise
    except Exception as e:  # Embedding 限流、网络等：不让整轮聊天失败
        log.warning('evidence retrieval failed: %s', type(e).__name__)
        raise EvidenceUnavailable('证据检索服务暂时不可用') from None
    log.info('evidence products=%s chunks=%d', ','.join(product_ids), len(found))
    return found


if __name__ == '__main__':
    import argparse
    from src import agent_config  # noqa: F401  加载 .env
    parser = argparse.ArgumentParser(description='建立商品证据检索用的片段向量缓存')
    parser.add_argument('--build', action='store_true', help='为缺少缓存的片段调用 Gemini Embedding')
    args = parser.parse_args()
    _, retrieval = _rag()
    try:
        r = Retriever(embedder=retrieval.GeminiEmbedder(_gemini_embedder(retrieval).client), build=args.build)
    except EvidenceUnavailable as e:
        raise SystemExit(f'证据检索暂不可用：{e}')
    print(f'片段 {len(r.chunks)} 段；本次新算向量 {r.embedder.embedded} 段，Embedding 调用 {r.embedder.calls} 次；向量缓存已齐全，聊天里可以使用证据检索')
