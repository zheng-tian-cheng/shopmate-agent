"""评测对照与迭代报告：只读已有运行记录，不调用 API。

    .venv/bin/python -m tests.eval_report compare eval/runs/B0-20261102-233030 eval/runs/<新版本目录>
    .venv/bin/python -m tests.eval_report iteration [--new eval/runs/<新版本目录>]

三类证据分开写：B0 原始评测（不改历史数据）→ RAG 技术实验（A/B/C）→ 检索回归与 RAG 集成后的产品评测。
报告只写分数、状态、来源和片段 ID、评审备注，不含厂商原文和模型完整回答，默认输出到 eval/reports/。
自动检查只用于定位；分数以各运行目录 scores.csv 的人工（或标明的 AI 初评）为准。
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from tests import eval_run as ev

ROOT = ev.ROOT
B0 = ROOT / 'eval/runs/B0-20261102-233030'
EXPERIMENT = ROOT / 'experiments/rag/results/20261103-011256'
REPORTS = ROOT / 'eval/reports'
YES = {True: '通过', False: '不通过', None: '待评分'}


def score_text(group, row):
    keys = ('c1', 'c2', 'c3', 'c4') if group == 'task' else ('s1', 's2', 's3')
    values = [row.get(k, '') for k in keys]
    if any(v == '' for v in values):
        return '待评分'
    total = sum(int(v) for v in values)
    return f"{'/'.join(values)}（{total}/{4 if group == 'task' else 6}）"


def outcome(group, entry, row):
    if not entry:
        return '未运行'
    if entry['status'] != 'ok':
        return ev.STATUS[entry['status']]
    v = ev.verdict(group, row)
    return YES[None] if v is None else YES[bool(v) and not row.get('severe')]


def tools_used(entry):
    names = [r['call'] for t in entry['turns'] if t['kind'] == 'chat' for q in t['requests'] for r in q.get('output', []) if 'call' in r]
    return '、'.join(dict.fromkeys(names)) or '无'


def feedback(entry):
    return sum(f.get('text', '').startswith(ev.FEEDBACK) or ('error' in f.get('response', {}) if isinstance(f.get('response'), dict) else False)
               for t in entry['turns'] if t['kind'] == 'chat' for q in t['requests'] for f in q['fed'])


def old_hash(path, session):
    """旧版本的文件哈希：有记录用记录；没记录但已提交、运行时又没有未提交改动的，按那次提交里的版本推算。"""
    if path in session['sha256']:
        return session['sha256'][path], ''
    dirty = any(path.startswith(line[3:].strip().strip('"')) for line in session['uncommitted'])
    blob = subprocess.run(['git', 'show', f"{session['commit']}:{path}"], cwd=ROOT, capture_output=True)
    if blob.returncode == 0 and not dirty:
        return hashlib.sha256(blob.stdout).hexdigest()[:16], '（按提交推算）'
    return None, '未记录（当时未跟踪或尚不存在）'


def code_diff(old_session, new_hashes):
    rows = []
    for path in sorted(set(old_session['sha256']) | set(new_hashes)):
        (a, how), b = old_hash(path, old_session), new_hashes.get(path)
        rows.append(f"| {path} | {(a or '') + how} | {b or '—'} | {'无法比较' if a is None else '相同' if a == b else '不同'} |")
    return rows


def current_hashes():
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest()[:16] for p in ev.HASHED if (ROOT / p).exists()}


def compare(old, new):
    od, nd, os_, ns = ev.load(old), ev.load(new), ev.read_scores(old), ev.read_scores(new)
    lines = [f"# {od['version']} 与 {nd['version']} 逐题对照", '',
             f"> {old.name} → {new.name} · 自动生成，只读运行记录 · 分数取自各自的 scores.csv（评审人见 reviewer 列）；自动检查只用于定位，不代替评分。", '',
             '## 版本差异（实际代码与数据，不能把全部变化都归因于 RAG）', '', '| 文件 | 旧版本 | 新版本 | 是否变化 |', '| --- | --- | --- | --- |',
             *code_diff(od['sessions'][-1], nd['sessions'][-1]['sha256']), '',
             f"模型：{od['sessions'][-1]['model']} → {nd['sessions'][-1]['model']}；google-genai：{od['sessions'][-1]['genai']} → {nd['sessions'][-1]['genai']}；"
             f"代码提交：{od['sessions'][-1]['commit']} → {nd['sessions'][-1]['commit']}（两边是否有未提交改动：{bool(od['sessions'][-1]['uncommitted'])} / {bool(nd['sessions'][-1]['uncommitted'])}）", '',
             '## 汇总（三类分开统计）', '', ev.summary([old, new]), '',
             '## 逐题', '', '| 题目 | 类别 | 旧：结果 | 旧：分数 | 新：结果 | 新：分数 | 新版本工具调用 | 校验或工具退回 | 回答引用的证据 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    keys = list(dict.fromkeys(od['plan'] + nd['plan']))
    for key in keys:
        case = key.split('#')[0]
        group = ev.ITEMS[case]['group']
        oe, ne = od['entries'].get(key), nd['entries'].get(key)
        cited = [e['ref'] + ' ' + e['sourceId'] for t in (ne or {}).get('turns', []) for e in t.get('evidence') or []]
        lines.append(f"| {key} | {ev.GROUPS[group]} | {outcome(group, oe, os_.get(key, {}))} | {score_text(group, os_.get(key, {}))} | "
                     f"{outcome(group, ne, ns.get(key, {}))} | {score_text(group, ns.get(key, {}))} | {tools_used(ne) if ne else '—'} | "
                     f"{feedback(ne) if ne else '—'} | {'、'.join(cited) or '无'} |")
    lines += ['', '## 自动检查、失败原因与待复核', '']
    for key in keys:
        case = key.split('#')[0]
        ne, row_o, row_n = nd['entries'].get(key), os_.get(key, {}), ns.get(key, {})
        hints = ev.flags(ev.ITEMS[case], ne['turns']) if ne else ['未运行']
        lines += [f"### {key}", '', f"- 旧版本备注：{row_o.get('note') or '无'}（严重错误 {row_o.get('severe') or '无'}；评审 {row_o.get('reviewer') or '未填'}）",
                  f"- 新版本备注：{row_n.get('note') or '无'}（严重错误 {row_n.get('severe') or '无'}；评审 {row_n.get('reviewer') or '待人工复核'}）",
                  *[f'- 自动：{h}' for h in hints], '']
    return '\n'.join(lines)


def experiment_section():
    data = json.loads((EXPERIMENT / 'run.json').read_text(encoding='utf-8'))
    review = json.loads((EXPERIMENT / 'review.json').read_text(encoding='utf-8'))
    from experiments.rag.run import summarize
    lines = ['| 阶段 | Hit@1 | Recall@5 均值 | Top-5 完整召回 | 上下文召回 | RAG-02 复核 | RAG-05 复核 |', '| --- | --- | --- | --- | --- | --- | --- |']
    for stage, label in (('A', 'A 普通切分 + 向量'), ('B', 'B 结构化切分 + 向量'), ('C', 'C 结构化 + BM25 + RRF')):
        m = summarize(data['retrieval'], stage, 'filtered')
        verdict = {main: review['answers'][f'{main}/{stage}'] for main in ('RAG-02', 'RAG-05')}
        cells = [f"{sum(v['pass'] for v in verdict[x].values())}/{len(verdict[x])}" for x in ('RAG-02', 'RAG-05')]
        lines.append(f"| {label} | {m['hit1']}/{m['queries']} | {m['recall']} | {m['full']}/{m['queries']} | {m['context_recall']} | {cells[0]} | {cells[1]} |")
    return lines


def latest_regression():
    found = sorted((ROOT / 'experiments/rag/results').glob('regression-*/run.json'))
    return (found[-1].parent, json.loads(found[-1].read_text(encoding='utf-8'))) if found else (None, None)


def regression_section():
    path, data = latest_regression()
    if not data:
        return ['尚未运行：`.venv/bin/python -m experiments.rag.regression`（只读缓存，0 次 API 调用）。']
    from experiments.rag.regression import totals
    lines = [f"最新一次：`{path.relative_to(ROOT)}`（{data['date']}，Embedding 调用 {data['api_calls']} 次）。已知用例回归：修复参考过这些查询，不能证明泛化。", '',
             '| 方案 | Hit@1 | Recall@5 均值 | Top-5 完整召回 | 上下文召回 | RAG-02 上下文召回 | RAG-05 上下文召回 |', '| --- | --- | --- | --- | --- | --- | --- |']
    for v in data['variants']:
        if v['status'] != 'ok':
            lines.append(f"| {v['name']} | {v['status']} | | | | | |")
            continue
        t, by = totals(v['rows']), {r['query']: r for r in v['rows']}
        lines.append(f"| {v['name']} | {t['hit1']}/{t['n']} | {t['recall']} | {t['full']}/{t['n']} | {t['context_recall']} | "
                     f"{by['RAG-02']['context_recall']:.2f} | {by['RAG-05']['context_recall']:.2f} |")
    return lines


def iteration(new=None):
    b0 = ev.tally(B0)
    lines = ['# ShopMate｜评测驱动的 RAG 迭代报告', '',
             '> 自动生成，只读历史记录（B0、A/B/C 实验结果不修改）。报告不含厂商原文和模型完整回答；逐题原文见各运行目录（本地，不进仓库）。', '',
             '**证据链：** B0 发现 Bad Case → A/B/C 技术对照 → 选定 B 并修复跨商品检索 → 接入 ShopMate → 检索回归（17 道）与产品回归（9 项）。', '',
             '## 一、原始 B0（证明原 Agent 的问题，历史数据不修改）', '', f"运行目录 `{B0.relative_to(ROOT)}`，评分为 AI 初评，待人工复核。", '',
             ev.summary([B0]), '', '| 题目 | 结果 | 分数 | 严重错误 | 评审备注 |', '| --- | --- | --- | --- | --- |']
    data, scores = ev.load(B0), ev.read_scores(B0)
    for key in data['plan']:
        group, row = ev.ITEMS[key.split('#')[0]]['group'], scores.get(key, {})
        lines.append(f"| {key} | {outcome(group, data['entries'].get(key), row)} | {score_text(group, row)} | {row.get('severe') or '无'} | {row.get('note') or ''} |")
    lines += ['', '## 二、RAG 技术实验（证明切分方式对检索的影响，以及为什么选 B）', '',
              f"运行目录 `{EXPERIMENT.relative_to(ROOT)}`，17 道查询、按商品过滤；回答复核为 Claude 逐条复核（待用户确认）。", '', *experiment_section(), '',
              '选择 B 而不是 C：C 的 Recall@5 只比 B 高 0.03，Hit@1 反而更低，两道主问题的复核得分与 B 完全相同；BM25 用中文双字切分对英文资料几乎没有信号，'
              '还会在全库检索时拉来别家的中文页面。B 带来了唯一从检索传导到回答的改善（RAG-05 写出平均值口径和频段）。详见实验目录的 analysis.md。', '',
              '## 三、修复跨商品检索后的检索回归（17 道固定查询）', '', *regression_section(), '',
              '## 四、RAG 集成后的产品评测（9 项固定用例）', '']
    if new:
        trials = [d for d in sorted((ROOT / 'eval/runs').glob(f"{ev.load(new)['version']}-*")) if d.resolve() != new.resolve() and (d / 'run.json').exists()]
        lines += [f"完整批次目录 `{new.relative_to(ROOT) if new.is_relative_to(ROOT) else new}`；逐题对照另见 compare 输出。", '', ev.summary([B0, new]), '']
        if trials:
            lines += ['同版本的其他运行（试运行，单独保留，不计入上表）：' + '；'.join(f"`{d.name}`（{'、'.join(ev.load(d)['plan'])}）" for d in trials), '']
        new_scores, new_data = ev.read_scores(new), ev.load(new)
        lines += ['| 题目 | B0 结果 | B0 分数 | RAG1 结果 | RAG1 分数 | RAG1 检索 T1/T2 | RAG1 失败归因 |', '| --- | --- | --- | --- | --- | --- | --- |']
        for k in data['plan']:
            group, row = ev.ITEMS[k.split('#')[0]]['group'], new_scores.get(k, {})
            retrieval = f"{row.get('r1')}/{row.get('r2')}" if row.get('r1') else '—'
            lines.append(f"| {k} | {outcome(group, data['entries'].get(k), scores.get(k, {}))} | {score_text(group, scores.get(k, {}))} | "
                         f"{outcome(group, new_data['entries'].get(k), row)} | {score_text(group, row)} | {retrieval} | {row.get('cause') or '—'} |")
        lines.append('')
    else:
        lines += ['**待测。** 需要真实 Gemini：`.venv/bin/python -m tests.eval_run run --version RAG1`。运行和评分完成后，用 `--new` 重新生成本报告。', '',
                  '对照模板（运行后自动填写）：', '', '| 题目 | B0 结果 | B0 分数 | 新版本结果 | 新版本分数 | 回答引用的证据 | 变化与原因 |', '| --- | --- | --- | --- | --- | --- | --- |',
                  *[f"| {k} | {outcome(ev.ITEMS[k.split('#')[0]]['group'], data['entries'].get(k), scores.get(k, {}))} | {score_text(ev.ITEMS[k.split('#')[0]]['group'], scores.get(k, {}))} | 待测 | 待测 | 待测 | 待测 |"
                    for k in data['plan']], '']
    analysis = new / 'analysis.md' if new else None
    if analysis and analysis.exists():
        lines += [analysis.read_text(encoding='utf-8').strip(), '']
    lines += ['## 五、B0 之后的实际代码差异（不能把全部变化都归因于 RAG）', '', '| 文件 | B0 | 当前 | 是否变化 |', '| --- | --- | --- | --- |',
              *code_diff(data['sessions'][-1], current_hashes()), '',
              '`data/products.json`、`src/conditions.py`、`src/tools.py` 与 B0 相同：商品事实、条件规则和筛选排序没有改动。'
              '变化集中在 Agent（新增证据检索工具、回复校验允许引用证据中的数值）、提示词（证据回答结构）、证据检索模块与实验切分代码（B+ 规格分组选项）。', '',
              '## 六、状态清单', '',
              '| 状态 | 内容 |', '| --- | --- |',
              '| 已实现 | 证据检索工具接入 Agent 与聊天界面（来源列表）；按商品均衡检索与去重；B+ 规格分组切分；引用数字校验；17 道检索回归；恢复的产品评测器及证据检查；本报告生成 |',
              '| 离线测试通过 | 以运行 `pytest`、`npm test` 时的输出为准（见交付说明） |',
              f"| 真实模型测试通过 | {'见第四节' if new else '无：RAG 集成后的产品评测尚未运行'} |",
              '| 待人工复核 | B0 的 AI 初评；A/B/C 实验的 Claude 复核；新版本的全部评分 |',
              f"| 尚未完成 | {'B+ 规格分组的向量缓存（`python -m src.evidence --build`）' if any(v['status'] != 'ok' for v in (latest_regression()[1] or {}).get('variants', [])) else ''}；"
              '说明书 PDF 与第三方评测摘录未接入证据语料（RAG-01/03/04 的必要来源不在语料中）；新版本的真实评测与评分 |']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='评测对照与迭代报告（只读，不调用 API）')
    sub = parser.add_subparsers(dest='command', required=True)
    c = sub.add_parser('compare', help='两个运行目录逐题对照')
    c.add_argument('old', type=Path)
    c.add_argument('new', type=Path)
    c.add_argument('--out', type=Path)
    i = sub.add_parser('iteration', help='B0 → A/B/C → 回归的完整迭代报告')
    i.add_argument('--new', type=Path, help='RAG 集成后的产品评测目录')
    i.add_argument('--out', type=Path, default=REPORTS / 'rag-iteration-report.md')
    args = parser.parse_args()
    text = compare(args.old, args.new) if args.command == 'compare' else iteration(args.new)
    out = args.out or REPORTS / f'compare-{args.old.name}-vs-{args.new.name}.md'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text + '\n', encoding='utf-8')
    print(f'已写入 {out}')


if __name__ == '__main__':
    main()
