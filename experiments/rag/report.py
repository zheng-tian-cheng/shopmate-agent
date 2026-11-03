"""把 run.json 的内容写成 answers.md 和 report.md。报告里的数字和差异都由数据自动生成。
运行目录里如有 review.json（逐条复核结论）和 analysis.md（分析与结论），会一并写入，重新生成报告时不会丢失。"""
import json
from .run import MODES, STAGES, summarize

YES = {True: '✓', False: '✗', None: '—'}


def load_review(out):
    path = out / 'review.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else None


def verdicts(review, a):
    return (review or {}).get('answers', {}).get(f"{a['main']}/{a['stage']}", {})


def attribution(main_criterion, passed, a):
    """按复核结论归因：资料本身没有 / 没有检索到 / 检索到了但回答没用对。"""
    if passed:
        return '通过'
    if not main_criterion['needs']:
        return '资料未提供该信息（应说明未知或边界）'
    covered = {u for c in a['context'] for u in c['covers']}
    if all(any(u in covered for u in g) for g in main_criterion['needs']):
        return '检索到证据，但回答没有正确使用'
    return '没有检索到必要证据'


def quote(text):
    return '\n'.join('> ' + line if line else '>' for line in (text or '（无）').split('\n'))


def status_line(data):
    kind = '**离线自测（哈希向量 + 占位回答），不是实验结果**' if data['offline'] else '真实运行'
    line = f"> {data['run_id']} · {kind} · {data['date']} · 生成模型 {data['config']['generator']} · Embedding {data['config']['embed_model']}"
    if data.get('rescored'):
        line += f"\n> {data['rescored']['at']} 用保存的回答重新评分（未调用 API），修正评分器缺陷：{'；'.join(data['rescored']['fixes'])}"
    return line


def review_line(review):
    if not review:
        return '> 尚无逐条复核（review.json）；下表的“规则”和“LLM 辅助”可能误判，需要人工确认。'
    return f"> 复核：{review['reviewer']}，{review['date']}。{review.get('note', '')}"


def write_answers(path, data, gt, review=None):
    lines = ['# 主问题回答：A / B / C', '', status_line(data),
             '> 每组每题只生成 1 次；证据是按商品过滤后、在同一上下文预算内装入的片段。规则评分会漏判同义改写，LLM 辅助评分与生成同一模型，两者都只作参考。',
             review_line(review), '']
    for main in gt['main']:
        lines += [f"## {main['id']}", '', f"问题：{main['question']}", '']
        for a in [a for a in data['answers'] if a['main'] == main['id']]:
            rule = sum(c['rule'] for c in a['criteria'])
            judge = '—' if not a['judge'] else sum(bool(c['judge']) for c in a['criteria'])
            tokens, v = a['tokens'] or {}, verdicts(review, a)
            checked = f" · **复核 {sum(x['pass'] for x in v.values())}/{len(v)}**" if v else ''
            lines += [f"### {a['stage']}｜{STAGES[a['stage']][2]}", '',
                      f"状态：{a['status']}{checked} · 规则评分 {rule}/{len(a['criteria'])} · LLM 辅助 {judge}/{len(a['criteria'])} · "
                      f"需人工复核 {sum(c['review'] for c in a['criteria'])} 条 · 上下文 {len(a['context'])} 段约 {a['context_tokens']} Token · "
                      f"实际输入/输出 Token {tokens.get('prompt', '—')}/{tokens.get('output', '—')}", '',
                      '**用户可见回答**', '', quote(a['text']), '',
                      '| 要点 | 复核结论 | 归因（按复核） | 规则 | LLM 辅助 |', '| --- | --- | --- | --- | --- |']
            for c, mc in zip(a['criteria'], main['criteria']):
                x = v.get(c['id'])
                final = x['pass'] if x else c['rule']
                lines.append(f"| {c['id']} {c['text']} | {YES[x['pass']] + ' ' + x['reason'] if x else '待复核'} | {attribution(mc, final, a)} | "
                             f"{YES[c['rule']]} {c['rule_detail']} | {YES[c['judge']]} {c['judge_reason'] or ''} |")
            trace = a['trace']
            lines += ['', f"禁止断言（规则）：{'；'.join(a['errors']) or '未发现'}"]
            if a['judge']:
                v = '；'.join(f"{x.get('forbidden', '')}：{x.get('quote', '')}" for x in a['judge']['violations']) or '未发现'
                u = '；'.join(f"{x.get('quote', '')}（{x.get('reason', '')}）" for x in a['judge']['unsupported']) or '未发现'
                lines += [f'禁止断言（LLM 辅助）：{v}', f'无依据陈述（LLM 辅助）：{u}']
            lines += [f"可追溯：引用 {', '.join(f'S{n}' for n in trace['cited']) or '无'}；无效引用 {trace['invalid'] or '无'}；"
                      f"回答提到但上下文里没有的关键事实 {trace['untraceable'] or '无'}", '', '**引用的证据**', '']
            cited = set(trace['cited'])
            for c in a['context']:
                if c['n'] in cited:
                    lines += [f"- **[S{c['n']}]** {c['label']}　覆盖证据单元：{', '.join(c['covers']) or '无'}", '', quote(c['text']), '']
            rest = [c for c in a['context'] if c['n'] not in cited]
            if rest:
                lines += ['未被引用的上下文片段：', *[f"- [S{c['n']}] {c['label']}　覆盖：{', '.join(c['covers']) or '无'}" for c in rest], '']
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def ranks(r):
    return ' / '.join('—' if x is None else str(x) for x in r['first_ranks'])


def passed(v):
    return f"{sum(x['pass'] for x in v.values())}/{len(v)}" if v else '待复核'


def write_report(path, data, gt, review=None):
    cfg, ids = data['config'], [q['id'] for q in gt['queries']] + [m['id'] for m in gt['main']]
    by = {(r['stage'], r['mode'], r['query']): r for r in data['retrieval']}
    queries = {q['id']: q for q in gt['queries']}
    queries.update({m['id']: dict(id=m['id'], type='主问题', text=m['question'], required=m['required']) for m in gt['main']})
    lines = ['# ShopMate 商品证据 RAG 对照实验报告', '', status_line(data),
             f"> 检索查询 {len(ids)} 道（{len(gt['queries'])} 道检索测试 + {len(gt['main'])} 道主问题），主问题每组回答 1 次。样本很小，只用于发现差异和问题，不宣称统计显著。", '',
             '## 一、实验配置', '', '| 项目 | 设置 |', '| --- | --- |',
             f"| 语料 | 登记表中可作证据的官方 HTML {len(data['sources'])} 份（哈希与登记表一致 {sum(s['sha256_ok'] for s in data['sources'])} 份），三组相同 |",
             f"| Embedding | {cfg['embed_model']}，{cfg['embed_dim']} 维，文档 RETRIEVAL_DOCUMENT / 查询 RETRIEVAL_QUERY，L2 归一化，FAISS IndexFlatIP |",
             f"| 生成 | {cfg['generator']}，{cfg['generation']}；三组同一回答 Prompt（sha {cfg['system_prompt_sha']}） |",
             f"| LLM 辅助评分 | {cfg['judge']} |",
             f"| 检索 | Top-{cfg['top_k']} 计算指标；上下文按排名装入，预算约 {cfg['context_budget']} 估计 Token（含来源标签） |",
             f"| A 切分 | 固定窗口 {cfg['a_window']['tokens']} 估计 Token，重叠 {cfg['a_window']['overlap']} |",
             f"| B/C 切分 | DOM 结构递归切分，片段上限 {cfg['b_chunk']['max_tokens']}，小于 {cfg['b_chunk']['merge_below']} 的相邻片段合并，脚注附正文上限 {cfg['b_chunk']['footnote_cap_chars']} 字符 |",
             f"| C 融合 | BM25（k1={cfg['bm25']['k1']}, b={cfg['bm25']['b']}，英文按词、中文按相邻两字）+ 向量，RRF k={cfg['rrf_k']} |",
             f"| 商品过滤 | 两种设置：按问题涉及的商品 ID 过滤（主设置，回答用）/ 全库检索（看型号混淆）；C 的两路都先过滤再融合 |",
             f"| API 调用 | Embedding {data['api']['embedding_calls']} 次（新向量 {data['api']['embedded_texts']} 条，缓存命中 {data['api']['cache_hits']} 条，限流等待 {len(data['api']['rate_limit_waits'])} 次）；生成和评审 {data['api']['generation_calls']} 次 |",
             f"| 版本 | 代码 {data['versions']['commit']}{'（有未提交改动）' if data['versions']['uncommitted'] else ''}；google-genai {data['versions']['genai']}；faiss {data['versions']['faiss']}；Ground Truth sha {data['versions']['ground_truth']} |", '',
             '## 二、方法与控制变量', '',
             '- **三组相同：** 原始资料、证据单元与评分规则、查询原句、Embedding 模型、生成模型和回答 Prompt、Top-K、上下文预算、商品过滤方式。',
             '- **A → B 只改切分：** B 解析 DOM，去掉链接密集的导航，按区块递归切分、去重，把脚注和正文标记互相关联，检索文本加标题路径。两组都带登记表里的文件级元数据（商品、来源、地区），检索文本都以商品名开头。',
             '- **B → C 只改检索：** 同一份 B 片段，再加 BM25，用 RRF 融合两路排名。',
             '- **证据覆盖判定：** 片段必须完整包含证据单元的原文（小写、去空白后匹配）且来源正确；被切断的不算。回答侧以规则评分为主，LLM 辅助评分仅作参考，两者不一致的标“需人工复核”。', '',
             '## 三、切分结果', '', '| 方案 | 片段数 | 平均估计 Token | 脚注片段 | 带正文-脚注关联 | 原文中存在、但没有任何片段完整包含的证据单元 |', '| --- | --- | --- | --- | --- | --- |']
    for s, st in data['chunks'].items():
        lines.append(f"| {s} | {st['chunks']} | {st['mean_tokens']} | {st['footnotes']} | {st['linked']} | {', '.join(data['split_units'][s]) or '无'} |")
    lines += ['', '## 四、检索结果', '']
    for mode, label in MODES.items():
        lines += [f'### {label}', '', '| 阶段 | Hit@1 | Recall@5 均值 | 完整召回（Top-5） | 上下文召回均值 | Top-5 中其他商品片段 | 首位是其他商品 |', '| --- | --- | --- | --- | --- | --- | --- |']
        for stage in STAGES:
            m = summarize(data['retrieval'], stage, mode)
            lines.append(f"| {stage} | {m['hit1']}/{m['queries']} | {m['recall']} | {m['full']}/{m['queries']} | {m['context_recall']} | {m['wrong_top5']} | {m['top1_wrong']} |")
        lines.append('')
    types_ = list(dict.fromkeys(q['type'] for q in queries.values()))
    lines += ['### 按题型（按商品过滤，Recall@5 均值 / 完整召回）', '', '| 题型 | 题数 | A | B | C |', '| --- | --- | --- | --- | --- |']
    for t in types_:
        qids = [q for q in ids if queries[q]['type'] == t]
        cells = []
        for stage in STAGES:
            m = summarize(data['retrieval'], stage, 'filtered', qids)
            cells.append(f"{m['recall']} / {m['full']}")
        lines.append(f"| {t} | {len(qids)} | {' | '.join(cells)} |")
    lines += ['', '### 逐题：每组必要证据的首个命中排名（按商品过滤；“—”表示整个范围内都没有完整包含它的片段）', '',
              '| 题目 | 类型 | 查询 | A | B | C |', '| --- | --- | --- | --- | --- | --- |']
    for q in ids:
        lines.append(f"| {q} | {queries[q]['type']} | {queries[q]['text']} | {' | '.join(ranks(by[(s, 'filtered', q)]) for s in STAGES)} |")
    lines += ['', '## 五、主问题回答', '', '完整回答、引用证据和逐条评分理由见 [answers.md](answers.md)。', review_line(review), '']
    agree = dict(rule=0, judge=0, total=0)
    for main in gt['main']:
        rows = [a for a in data['answers'] if a['main'] == main['id']]
        lines += [f"### {main['id']}", '', '| 阶段 | 状态 | 复核 | 规则评分 | LLM 辅助 | 禁止断言（规则） | 上下文缺少的关键事实 | 上下文 |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
        for a in rows:
            v = verdicts(review, a)
            for c in a['criteria']:
                if c['id'] in v:
                    agree['total'] += 1
                    agree['rule'] += c['rule'] == v[c['id']]['pass']
                    agree['judge'] += c['judge'] == v[c['id']]['pass']
            lines.append(f"| {a['stage']} | {a['status']} | {passed(v)} | "
                         f"{sum(c['rule'] for c in a['criteria'])}/{len(a['criteria'])} | "
                         f"{'—' if not a['judge'] else sum(bool(c['judge']) for c in a['criteria'])}/{len(a['criteria'])} | "
                         f"{len(a['errors'])} | {', '.join(a['trace']['untraceable']) or '无'} | {len(a['context'])} 段 / {a['context_tokens']} |")
        lines += ['', '| 要点（复核结论 · 归因） | A | B | C |', '| --- | --- | --- | --- |']
        for i, c in enumerate(main['criteria']):
            cells = []
            for a in rows:
                x = verdicts(review, a).get(c['id'])
                final = x['pass'] if x else a['criteria'][i]['rule']
                cells.append(f"{YES[final]} {attribution(c, final, a)}{'' if x else '（规则，待复核）'}")
            lines.append(f"| {c['id']} {c['text']} | {' | '.join(cells)} |")
        lines.append('')
    if agree['total']:
        lines += [f"与复核结论一致的比例：规则 {agree['rule']}/{agree['total']}，LLM 辅助 {agree['judge']}/{agree['total']}。", '']
    lines += ['## 六、阶段差异与失败案例（自动列出）', '']
    for before, after in (('A', 'B'), ('B', 'C')):
        better, worse = [], []
        for q in ids:
            x, y = by[(before, 'filtered', q)], by[(after, 'filtered', q)]
            key = lambda r: (r['recall'], r['hit1'], -min([v for v in r['first_ranks'] if v] or [999]))
            (better if key(y) > key(x) else worse if key(y) < key(x) else []).append(f"{q}（{ranks(x)} → {ranks(y)}）")
        lines += [f'- **{before} → {after} 变好：** {"；".join(better) or "无"}', f'- **{before} → {after} 变差：** {"；".join(worse) or "无"}']
    lines += ['', '按商品过滤时 Top-5 没有完整召回的查询：', '']
    for stage in STAGES:
        miss = []
        for q in ids:
            r = by[(stage, 'filtered', q)]
            if not r['full']:
                lost = [' 或 '.join(g) for g, rank in zip(queries[q]['required'], r['first_ranks']) if not rank or rank > data['config']['top_k']]
                miss.append(f"{q} 缺 {'、'.join(lost)}")
        lines.append(f"- **{stage}：** {'；'.join(miss) or '无'}")
    analysis = path.parent / 'analysis.md'
    lines += ['', '## 七、分析与结论', '', analysis.read_text(encoding='utf-8').strip() if analysis.exists() else '（尚未撰写：需根据本次运行的实际结果人工分析。）', '']
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
