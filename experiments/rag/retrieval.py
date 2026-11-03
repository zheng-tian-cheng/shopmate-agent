"""检索：A/B/C 共用 Gemini Embedding + FAISS；C 另加 BM25，两路用 RRF 融合。

商品过滤（scope）在两路排名之前统一执行：范围外的片段不会进入任何一路，也就不会被融合进结果。
上下文按排名顺序装入，直到达到同一个估计 Token 预算，三组相同。
"""
import base64
from collections import Counter
import hashlib
import json
import math
import os
import re
import time
import faiss
import numpy as np
from google.genai import errors, types
from .corpus import CJK, ROOT, est_tokens

EMBED_MODEL = os.getenv('RAG_EMBED_MODEL', 'gemini-embedding-001')  # 2026-11-03 核对：稳定版、支持 task_type、免费层不收费
EMBED_DIM = 768        # 官方建议值之一；非 3072 维需自行归一化
EMBED_BATCH = 50
TOP_K = 5
CONTEXT_BUDGET = 1200  # 估计 Token，含每个片段的来源标签
RRF_K = 60
BM25_K1, BM25_B = 1.5, 0.75


class GeminiEmbedder:
    """批量调用 Embedding，结果按（模型、维度、任务类型、文本）缓存到 data/rag/cache/，重复运行不再调用 API。"""

    def __init__(self, client, pause=1.0):
        self.client, self.pause, self.name = client, pause, EMBED_MODEL
        self.path = ROOT / 'data/rag/cache' / f'embeddings-{EMBED_MODEL}-{EMBED_DIM}.jsonl'
        self.cache, self.calls, self.embedded, self.cached, self.waits = {}, 0, 0, 0, []
        if self.path.exists():
            for line in self.path.read_text(encoding='utf-8').splitlines():
                item = json.loads(line)
                self.cache[item['k']] = np.frombuffer(base64.b64decode(item['v']), dtype=np.float32)

    def key(self, text, task):
        return hashlib.sha256(f'{self.name}|{EMBED_DIM}|{task}|{text}'.encode()).hexdigest()

    def embed(self, texts, task):
        keys = [self.key(t, task) for t in texts]
        todo = list(dict.fromkeys(k for k in keys if k not in self.cache))
        self.cached += len(set(keys)) - len(todo)
        source = dict(zip(keys, texts))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for i in range(0, len(todo), EMBED_BATCH):
            batch = todo[i:i + EMBED_BATCH]
            vectors = self.call([source[k] for k in batch], task)
            with self.path.open('a', encoding='utf-8') as f:
                for k, v in zip(batch, vectors):
                    v = np.asarray(v, dtype=np.float32)
                    self.cache[k] = v
                    f.write(json.dumps(dict(k=k, v=base64.b64encode(v.tobytes()).decode())) + '\n')
            self.embedded += len(batch)
        return normalize(np.stack([self.cache[k] for k in keys]))

    def call(self, texts, task):
        for attempt in range(5):
            try:
                result = self.client.models.embed_content(model=self.name, contents=texts,
                                                          config=types.EmbedContentConfig(task_type=task, output_dimensionality=EMBED_DIM))
                self.calls += 1
                time.sleep(self.pause)
                return [e.values for e in result.embeddings]
            except errors.APIError as e:
                if e.code != 429 or attempt == 4:
                    raise
                wait = retry_delay(e) or 20 * (attempt + 1)
                self.waits.append(wait)
                time.sleep(wait)


class HashEmbedder:
    """离线自测用的确定性向量（词袋哈希），不代表任何真实模型，结果不能当实验结论。"""
    name, calls, embedded, cached, waits = 'offline-hash（离线自测）', 0, 0, 0, []

    def embed(self, texts, task):
        out = np.zeros((len(texts), 256), dtype=np.float32)
        for row, text in enumerate(texts):
            for t in tokens(text):
                out[row, int(hashlib.md5(t.encode()).hexdigest(), 16) % 256] += 1
        return normalize(out)


def retry_delay(error):
    m = re.search(r"retryDelay['\"]?\s*:\s*['\"](\d+(?:\.\d+)?)s", str(error.details))
    return float(m.group(1)) + 1 if m else None


def normalize(vectors):
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return (vectors / np.where(norms == 0, 1, norms)).astype(np.float32)


WORD = re.compile(r'[a-z]+|[0-9]+(?:\.[0-9]+)*|[㐀-鿿]+')


def tokens(text):
    """BM25 分词：英文按单词、数字单独成词（“49dB”和“49 dB”一致），中文按相邻两字切分，不引入分词库。"""
    out = []
    for t in WORD.findall(text.lower()):
        if CJK.match(t):
            out += [t[i:i + 2] for i in range(len(t) - 1)] if len(t) > 1 else [t]
        else:
            out.append(t)
    return out


class BM25:
    def __init__(self, docs):
        self.docs = [Counter(tokens(d)) for d in docs]
        self.lengths = [sum(d.values()) for d in self.docs]
        self.avg = sum(self.lengths) / len(self.docs)
        df = Counter(t for d in self.docs for t in d)
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def score(self, query, i):
        d, length, s = self.docs[i], self.lengths[i], 0.0
        for t in tokens(query):
            if t in d:
                tf = d[t]
                s += self.idf[t] * tf * (BM25_K1 + 1) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * length / self.avg))
        return s


def rrf(*rankings):
    scores = Counter()
    for ranking in rankings:
        for rank, i in enumerate(ranking, 1):
            scores[i] += 1 / (RRF_K + rank)
    return sorted(scores, key=lambda i: (-scores[i], i)), scores


class Index:
    def __init__(self, chunks, embedder):
        self.chunks = chunks
        self.vectors = embedder.embed([c.index_text for c in chunks], 'RETRIEVAL_DOCUMENT')
        self.faiss = faiss.IndexFlatIP(self.vectors.shape[1])
        self.faiss.add(self.vectors)
        self.bm25 = BM25([c.index_text for c in chunks])

    def search(self, query, query_vector, scope=None, hybrid=False):
        """返回按最终排名排列的 [(片段下标, 记录)]。scope 为商品 ID 集合，None 表示全库。"""
        allowed = (lambda i: True) if scope is None else (lambda i: self.chunks[i].product_id in scope)
        scores, ids = self.faiss.search(query_vector[None, :], len(self.chunks))
        vector = [(int(i), float(s)) for i, s in zip(ids[0], scores[0]) if i >= 0 and allowed(int(i))]
        vector_rank = {i: r for r, (i, _) in enumerate(vector, 1)}
        if not hybrid:
            return [(i, dict(score=s, vector_rank=r)) for r, (i, s) in enumerate(vector, 1)]
        lexical = sorted(((i, self.bm25.score(query, i)) for i in range(len(self.chunks)) if allowed(i)), key=lambda x: (-x[1], x[0]))
        lexical = [(i, s) for i, s in lexical if s > 0]
        lexical_rank = {i: r for r, (i, _) in enumerate(lexical, 1)}
        order, fused = rrf([i for i, _ in vector], [i for i, _ in lexical])
        return [(i, dict(score=fused[i], vector_rank=vector_rank.get(i), bm25_rank=lexical_rank.get(i))) for i in order]


def pack(chunks, budget=CONTEXT_BUDGET):
    """按排名装入上下文，下一个放不下就停；第一个总会放入。"""
    picked, used = [], 0.0
    for c in chunks:
        cost = est_tokens(c.label() + '\n' + c.text)
        if picked and used + cost > budget:
            break
        picked.append(c)
        used += cost
    return picked, round(used)
