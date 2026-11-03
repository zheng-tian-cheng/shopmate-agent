"""评分：检索指标、回答规则评分、可追溯检查和失败归因。

规则评分是确定性的主评分，用正则检查参考要点和禁止断言，会漏判同义改写，所以另附 LLM 辅助评分；
两者不一致的条目标“需人工复核”。LLM 评审与生成用同一个模型，存在自评偏差，不能当作无争议事实。
"""
import json
import re
from .corpus import norm


def covers(chunk, unit):
    """片段包含完整的证据单元（来源对、原文没被切断）。"""
    return chunk.source_id in unit['sources'] and re.search(unit['pattern'], norm(chunk.text)) is not None


def group_hit(chunks, group, units):
    return any(covers(c, units[u]) for c in chunks for u in group)


def retrieval_metrics(ranked, context, query, units, k):
    groups, top = query['required'], ranked[:k]
    first = []
    for g in groups:
        rank = next((r for r, c in enumerate(ranked, 1) if any(covers(c, units[u]) for u in g)), None)
        first.append(rank)
    wrong = [c for c in top if c.product_id not in query['products']]
    return dict(hit1=int(bool(ranked) and any(covers(ranked[0], units[u]) for g in groups for u in g)),
                recall=sum(group_hit(top, g, units) for g in groups) / len(groups),
                full=int(all(group_hit(top, g, units) for g in groups)),
                context_recall=sum(group_hit(context, g, units) for g in groups) / len(groups),
                wrong_product=len(wrong), top1_wrong=int(bool(ranked) and ranked[0].product_id not in query['products']),
                first_ranks=first)


# —— 回答规则 ——
SENTENCE = re.compile(r'[^。！？!?\n；;]+')
NEGATION = re.compile(r'不支持|不能|无法|没有|未列|未支持|并不|不具备|不提供|仅|只有|只支持|不包括|不含|不是|并非|不足以|得不出')


def sentences(text):
    return [s.strip() for s in SENTENCE.findall(text) if s.strip()]


def found(pattern, text):
    m = re.search(pattern, text, re.I | re.S)
    return m.group(0) if m else None


def rule_rag02(answer):
    low = answer.lower()
    checks = {}
    air4_lhdc = [s for s in sentences(answer) if re.search(r'lhdc', s, re.I) and re.search(r'air\s*4', s, re.I)
                 and not re.search(r'pro', s, re.I) and re.search(r'支持|可用|能用|可以', s) and not NEGATION.search(s)]
    codecs = all(x in low for x in ('aac', 'sbc', 'lhdc'))
    checks['C1'] = (codecs and not air4_lhdc, '同时提到 AAC、SBC、LHDC' if codecs else '缺少 AAC/SBC/LHDC 中的编码')
    m = found(r'(手机|设备|两端|双端|播放端|发送端|音源|两台|双方)[^。；\n]{0,24}(也|同样|都|需要|必须|要|均)[^。；\n]{0,12}支持[^。；\n]{0,6}lhdc'
              r'|lhdc[^。；\n]{0,20}(两端|双端|双方|两台|手机端)', answer)
    checks['C2'] = (bool(m), m or '没有说明手机端也需支持 LHDC')
    m = found(r'安卓[^。；\n]{0,30}(不一定|不代表|不足以|不能确定|无法确定|并非|不是所有|未必|不能保证|还不能|不够)|(并非|不是)(所有|每一?款)?安卓', answer)
    checks['C3'] = (bool(m), m or '没有指出“安卓”不足以确认兼容')
    m = found(r'(型号|机型)[^。]{0,40}(系统|coloros|版本)|(系统|coloros|版本)[^。]{0,40}(型号|机型)', answer)
    checks['C4'] = (bool(m), m or '没有请用户核对手机型号和系统版本')
    sound = found(r'(不一定|未必|不保证|不代表|不能保证|不等于|不意味着)[^。；\n]{0,20}(音质|听感|更好)|(音质|听感)[^。；\n]{0,20}(不一定|未必|不保证|不代表)', answer)
    region = found(r'地区|新加坡|菲律宾|海外|国行|global|区域|版本差异', answer)
    checks['C5'] = (bool(sound and region), f"音质边界：{sound or '无'}；地区版本：{region or '无'}")
    errors = [f'把 LHDC 说成 Air4 标准版也支持：{s}' for s in air4_lhdc]
    if found(r'(所有|任何|一般|普通)?安卓(手机)?(都|均)(能|可以|支持)[^。；\n]{0,10}lhdc', answer):
        errors.append('断言安卓手机都能用 LHDC')
    return checks, errors


def rule_rag05(answer):
    checks = {}
    avg = found(r'平均', answer)
    band = found(r'50\s*hz[^。；\n]{0,8}20\s*khz', answer)
    checks['D1'] = (bool(avg and band), f"平均：{avg or '无'}；频段：{band or '无'}")
    m = found(r'(最高|最大|至多|up\s*to|高达)[^。；\n]{0,12}49|49\s*db[^。；\n]{0,10}(最高|最大|上限)', answer)
    checks['D2'] = (bool(m), m or '没有说明一加 49dB 是最高值')
    m = found(r'(不能|无法|不可|不宜|不应)(直接|简单)?(比较|对比|相比|比)|口径不同|标准不同|测试条件不同|不可比|不是同一', answer)
    winner = [s for s in sentences(answer) if re.search(r'一加', s) and re.search(r'更强|强很多|明显更好|更好|胜出', s) and not NEGATION.search(s)]
    checks['D3'] = (bool(m) and not winner, m or '没有说明两个数字不能直接比较')
    errors = [f'断言一加更强：{s}' for s in winner]
    # 同一句提到 27dB 和“最大/最高”，却没提“平均”，也没有否定，视为把 27dB 当成最大值（如 B0：“通常是实验室条件下的最大降噪深度”）
    for s in sentences(answer):
        if re.search(r'27\s*db', s, re.I) and re.search(r'最大|最高|峰值', s) and '平均' not in s \
                and not re.search(r'(不是|并非|而非|不等于|并不是)[^，。；]{0,8}(最大|最高|峰值)', s):
            errors.append(f'把 27dB 说成最大值：{s}')
    return checks, errors


RULES = {'RAG-02': rule_rag02, 'RAG-05': rule_rag05}
KEY_FACTS = {'RAG-02': ['lhdc5.0', 'aac', 'sbc', 'coloros13.1', 'findx6', 'reno', '1mbps', '256kbps', 'etee1', 'etea1'],
             'RAG-05': ['27db', '49db', '50hz', '20khz', '华为实验室', '平均']}


def traceability(answer, context, main_id):
    """引用编号是否有效；回答里的关键事实是否出现在实际送入模型的片段里。"""
    groups = re.findall(r'\[(S\d+(?:\s*[,，、]\s*S?\d+)*)\]', answer)  # 支持 [S1]、[S1, S6] 两种写法
    cited = sorted({int(x) for g in groups for x in re.findall(r'\d+', g)})
    invalid = [n for n in cited if not 1 <= n <= len(context)]
    text, evidence = norm(answer), norm(' '.join(c.text for c in context))
    facts = [f for f in KEY_FACTS[main_id] if f in text]
    untraceable = [f for f in facts if f not in evidence]
    return dict(cited=cited, invalid=invalid, facts=facts, untraceable=untraceable)


def judge_prompt(main, answer, context):
    evidence = '\n\n'.join(f'[S{i}] {c.label()}\n{c.text}' for i, c in enumerate(context, 1))
    criteria = '\n'.join(f"- {c['id']}：{c['text']}" for c in main['criteria'])
    forbidden = '\n'.join(f'- {f}' for f in main['forbidden'])
    return f"""请作为严格的评审，判断下面的购物回答是否满足每条参考要点。只依据回答原文判断，不要替回答补充内容。
同时检查是否出现禁止断言，以及是否有在证据片段中找不到依据的事实陈述。

用户问题：{main['question']}

参考要点：
{criteria}

禁止断言：
{forbidden}

提供给回答者的证据片段：
{evidence}

待评回答：
{answer}

只输出 JSON：{{"criteria":[{{"id":"C1","pass":true,"quote":"回答中的依据原文","reason":"简短理由"}}],"violations":[{{"forbidden":"…","quote":"…"}}],"unsupported":[{{"quote":"…","reason":"…"}}]}}"""


def parse_judge(text):
    try:
        data = json.loads(re.sub(r'^```(?:json)?|```$', '', text.strip(), flags=re.M))
        return dict(criteria={c['id']: c for c in data.get('criteria', [])}, violations=data.get('violations', []), unsupported=data.get('unsupported', []))
    except (json.JSONDecodeError, AttributeError, TypeError, KeyError):
        return None


def attribute(main, criterion, passed, context, units):
    """未通过的要点归因：资料本身没有 / 没有检索到 / 检索到了但回答没用对。"""
    if passed:
        return '通过'
    if not criterion['needs']:
        return '资料未提供该信息（应说明未知或边界）'
    if all(group_hit(context, g, units) for g in criterion['needs']):
        return '检索到证据，但回答没有正确使用'
    return '没有检索到必要证据'
