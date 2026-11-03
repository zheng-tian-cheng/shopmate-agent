"""RAG 对照实验的语料与两种切分方式。

语料：登记表（data/rag/sources_manifest.json）中可作证据、本地有原文的官方 HTML。三组实验共用同一份。

A 普通切分：去掉 script/style 等不可见内容后取 <body> 全部文字，按固定长度切窗（约 150 个估计 Token，重叠 25 个；
  按 Token 而不是字符计长度，避免中文页面的片段比英文大几倍）。
  不识别标题和区块，不去重，不处理导航菜单，也不建立正文与脚注的关联。
B 结构化切分：按 DOM 结构切分（思路同按 AST 节点切代码，换成 HTML 解析）：
  1. 去掉导航、站点页脚等链接密集区块；商品内容里的脚注列表（如华为的 <footer class="footer-list">）没有链接，会保留。
  2. 区块不超过上限就整块成片段；超过就按子区块递归拆，叶子区块再按换行和编号拆；相邻小片段合并。
  3. 页面为不同屏幕重复渲染的相同内容去重。
  4. 脚注（Remarks 编号条目、list-noteN）单独成片段，并和正文标记（<sup>1</sup>、³）双向关联：
     正文片段附上所引脚注，脚注片段注明对应的正文。
两种方式的片段都带文件级元数据（商品、来源、地区），它们来自登记表而不是 HTML 解析；
用于检索的文本都以商品名开头，B 另加标题路径。这样 A/B 的差别只在切分和结构处理。
"""
from dataclasses import asdict, dataclass, field
import hashlib
import json
from pathlib import Path
import re
from bs4 import BeautifulSoup, NavigableString, Tag

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'data/rag/sources_manifest.json'
PRODUCTS = {p['id']: p for p in json.loads((ROOT / 'data/products.json').read_text(encoding='utf-8'))['products']}
SOURCE_TYPE = {'official_spec_page': '官网规格页', 'official_product_page': '官网产品页', 'official_press_release': '官方新闻稿'}

A_TOKENS, A_OVERLAP = 150, 25  # 估计 Token：固定窗口大小和重叠
B_MAX, B_SMALL = 160, 40      # 估计 Token：片段上限；小于 B_SMALL 的相邻片段尝试合并
FOOTNOTE_CAP = 600            # 附到正文片段上的脚注最多字符数

INVISIBLE = ['script', 'style', 'noscript', 'svg', 'template', 'iframe']
BLOCK = {'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer',
         'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
         'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'ul'}
CJK = re.compile(r'[㐀-鿿]')
SUPERSCRIPT = re.compile('[⁰¹²³⁴⁵⁶⁷⁸⁹]+')
MARKER = re.compile(r'\[\^(\d{1,2})\]')
NUMBERED = re.compile(r'^(\d{1,2})[.、．]\s*\S')
REMARKS_HEAD = re.compile(r'^(remarks?|notes?|注释?|备注|说明)\s*[:：]?\s*$', re.I)


def est_tokens(text):
    """粗略的 Token 估计（汉字按 1 个，其余字符 4 个算 1 个），只用来让三组实验的片段大小和上下文预算可比。"""
    cjk = len(CJK.findall(text))
    return cjk + (len(text) - cjk) / 4


def norm(text):
    """匹配证据时用：小写并去掉全部空白，避免不同切分方式的空格、换行差异影响判断。"""
    return re.sub(r'\s+', '', text).lower()


@dataclass
class Chunk:
    id: str
    scheme: str
    product_id: str
    source_id: str
    region: str
    source_type: str
    text: str          # 给模型看、判断证据覆盖的正文
    index_text: str    # 用于 Embedding 和 BM25 的文本
    position: str      # A：字符区间；B：标题路径或脚注编号
    kind: str = 'text'
    links: list = field(default_factory=list)

    def label(self):
        name = PRODUCTS[self.product_id]['displayName']
        return f'商品：{name}（{self.product_id}）｜来源：{self.source_id}，{SOURCE_TYPE.get(self.source_type, self.source_type)}，{self.region}｜位置：{self.position}'


def sources():
    """可作证据、本地有原文的 HTML 来源；顺带核对文件哈希是否与登记表一致。"""
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    out = []
    for e in manifest['sources']:
        path = ROOT / (e.get('local_path') or '')
        if not str(path).endswith('.html') or not e.get('usable_as_evidence') or not path.exists():
            continue
        data = path.read_bytes()
        out.append(dict(e, html=data.decode('utf-8', errors='replace'), sha256_ok=hashlib.sha256(data).hexdigest() == e.get('sha256')))
    return out


def meta(entry):
    return dict(product_id=entry['product_id'], source_id=entry['source_id'], region=entry['region_version'], source_type=entry['source_type'])


def index_prefix(entry):
    return PRODUCTS[entry['product_id']]['displayName']


# —— A：普通切分 ——
def plain_text(html):
    soup = BeautifulSoup(html, 'html.parser')
    for t in soup(INVISIBLE):
        t.decompose()
    lines = [line.strip() for line in (soup.body or soup).get_text('\n').split('\n')]
    return '\n'.join(line for line in lines if line)


def chunk_plain(entry):
    text, out, start = plain_text(entry['html']), [], 0
    weight = [1 if CJK.match(ch) else 0.25 for ch in text]  # 与 est_tokens 一致
    while start < len(text):
        end, used = start, 0
        while end < len(text) and used + weight[end] <= A_TOKENS:
            used += weight[end]
            end += 1
        piece = text[start:end]
        out.append(Chunk(id=f"A:{entry['source_id']}:{len(out)}", scheme='A', **meta(entry), text=piece,
                         index_text=f'{index_prefix(entry)}\n{piece}', position=f'字符 {start}–{end}'))
        if end >= len(text):
            break
        back, overlap = end, 0
        while back > start + 1 and overlap < A_OVERLAP:
            back -= 1
            overlap += weight[back]
        start = back
    return out


# —— B：结构化切分 ——
def prepare(html):
    soup = BeautifulSoup(html, 'html.parser')
    for t in soup(INVISIBLE + ['nav', 'button', 'select', 'input']):
        t.decompose()
    for sup in soup('sup'):
        mark = sup.get_text(strip=True)
        sup.replace_with(f'[^{mark}]' if mark.isdigit() else mark)
    for br in soup('br'):
        br.replace_with('\n')
    for s in soup.find_all(string=SUPERSCRIPT):
        s.replace_with(SUPERSCRIPT.sub(lambda m: f"[^{m.group(0).translate(str.maketrans('⁰¹²³⁴⁵⁶⁷⁸⁹', '0123456789'))}]", s))
    # 链接密集的区块是导航、菜单和站点页脚；商品脚注列表不含链接，不受影响
    for el in soup.find_all(['header', 'footer', 'div', 'ul', 'ol', 'section', 'aside']):
        if el.decomposed:
            continue
        text = el.get_text(' ', strip=True)
        linked = sum(len(a.get_text(' ', strip=True)) for a in el.find_all('a'))
        if len(text) >= 20 and linked / len(text) > 0.6:
            el.decompose()
    return soup.body or soup


WORDY = re.compile(r'[\w㐀-鿿]')


def text_of(node):
    """区块文字：合并空白，去掉不含文字和数字的行（模板留下的“[”“]”“|”等）。"""
    raw = node.get_text(' ') if isinstance(node, Tag) else str(node)
    lines = [re.sub(r'[ \t\r\f\v ]+', ' ', line).strip() for line in raw.split('\n')]
    return '\n'.join(line for line in lines if WORDY.search(line))


def has_blocks(el):
    return any(isinstance(c, Tag) and c.name in BLOCK for c in el.children)


def heading_level(el):
    if re.fullmatch(r'h[1-6]', el.name):
        return int(el.name[1])
    classes = ' '.join(el.get('class', []))
    if re.search(r'(^|[\s_-])(title|heading)([\s_-]|$)', classes) and not has_blocks(el) and len(text_of(el)) <= 60:
        return 4
    return None


def footnote_class(el):
    m = re.search(r'(?:^|[\s_-])(?:list-)?note-?(\d{1,2})(?:\s|$)', ' '.join(el.get('class', []))) if isinstance(el, Tag) else None
    return int(m.group(1)) if m else None


def split_leaf(text):
    """过长的叶子区块：按换行拆，编号条目各自开始一段；整行仍过长时按句子拆。开头是“Remarks:”这类标题时，编号条目视为脚注。"""
    lines = text.split('\n')
    remarks = bool(lines) and bool(REMARKS_HEAD.match(lines[0]))
    if remarks:
        lines = lines[1:]
    pieces = []
    for line in lines:
        if est_tokens(line) <= B_MAX:
            pieces.append(line)
        else:
            sentences, cur = re.split(r'(?<=[。！？.!?])\s*', line), ''
            for s in sentences:
                if cur and est_tokens(cur + ' ' + s) > B_MAX:
                    pieces.append(cur)
                    cur = s
                else:
                    cur = f'{cur} {s}'.strip()
            if cur:
                pieces.append(cur)
    parts, cur = [], []
    for line in pieces:
        starts = NUMBERED.match(line)
        if cur and (starts or est_tokens(' '.join(cur + [line])) > B_MAX):
            parts.append(cur)
            cur = []
        cur.append(line)
    if cur:
        parts.append(cur)
    out = []
    for p in parts:
        text = '\n'.join(p)
        m = NUMBERED.match(text)
        out.append((text, int(m.group(1)) if remarks and m else None, 'Remarks' if remarks else None))
    return out


def segments(body):
    """按 DOM 递归产生 (标题路径, 文本, 脚注编号)。"""
    out, heads = [], []

    def path():
        return [h for _, h in heads]

    def walk(node):
        if type(node) is NavigableString:  # 注释、声明等其他字符串类型不是正文
            t = text_of(node)
            if t:
                out.append(dict(path=path(), text=t, note=None))
            return
        if not isinstance(node, Tag):
            return
        t = text_of(node)
        if not t:
            return
        level = heading_level(node)
        if level:
            heads[:] = [h for h in heads if h[0] < level] + [(level, t.replace('\n', ' '))]
            return
        note = footnote_class(node)
        if note is not None and est_tokens(t) <= B_MAX * 2:
            out.append(dict(path=path(), text=t, note=note))
            return
        if est_tokens(t) <= B_MAX:
            out.append(dict(path=path(), text=t, note=None))
            return
        if not has_blocks(node):
            for text, number, head in split_leaf(t):
                out.append(dict(path=path() + ([head] if head else []), text=text, note=number))
            return
        for child in node.children:
            walk(child)

    walk(body)
    return out


def merge_small(segs):
    out = []
    for s in segs:
        prev = out[-1] if out else None
        if (prev and prev['note'] is None and s['note'] is None and prev['path'] == s['path']
                and min(est_tokens(prev['text']), est_tokens(s['text'])) < B_SMALL
                and est_tokens(prev['text'] + ' ' + s['text']) <= B_MAX):
            prev['text'] = f"{prev['text']}\n{s['text']}"
        else:
            out.append(dict(s))
    return out


def chunk_structured(entry, scheme='B', keep_spec_groups=False):
    """keep_spec_groups：官网规格页不合并相邻小片段，每个规格组（如“蓝牙”“续航”）单独成段。
    针对实验 Bad Case 3（Air4 规格页的型号、音质、蓝牙被合并，编码被稀释）；默认关闭，实验 A/B/C 保持原行为。"""
    segs = segments(prepare(entry['html']))
    segs = [dict(s) for s in segs] if keep_spec_groups and entry['source_type'] == 'official_spec_page' else merge_small(segs)
    seen, kept = set(), []
    for s in segs:
        key = norm(MARKER.sub('', s['text']))
        if len(key) < 4 or key in seen:  # 太短的碎片和重复渲染的内容
            continue
        seen.add(key)
        kept.append(s)
    notes = {}
    for s in kept:
        if s['note'] is not None:
            notes.setdefault(s['note'], s)
    chunks = []
    for s in kept:
        is_note = s['note'] is not None
        position = (' › '.join(s['path']) + ' › ' if s['path'] else '') + (f"注 {s['note']}" if is_note else '正文')
        chunks.append(dict(seg=s, chunk=Chunk(id=f"{scheme}:{entry['source_id']}:{len(chunks)}", scheme=scheme, **meta(entry), text=s['text'],
                                                index_text='', position=position, kind='footnote' if is_note else 'body')))
    by_note = {id(c['seg']): c['chunk'] for c in chunks}
    for c in chunks:
        if c['seg']['note'] is not None:
            continue
        for n in dict.fromkeys(int(x) for x in MARKER.findall(c['seg']['text'])):
            target = notes.get(n)
            if not target or target is c['seg']:
                continue
            note_chunk = by_note[id(target)]
            note_text = NUMBERED.sub(lambda m: m.group(0)[len(m.group(1)) + 1:], target['text'], count=1).strip()
            c['chunk'].text += f'\n（注 {n}：{note_text[:FOOTNOTE_CAP]}）'
            c['chunk'].links.append(note_chunk.id)
            if c['chunk'].id not in note_chunk.links:
                note_chunk.links.append(c['chunk'].id)
                if not note_chunk.position.endswith('）'):
                    lead = MARKER.sub('', c['seg']['text']).replace('\n', ' ')[:50]
                    note_chunk.position += f'（对应正文：{lead}）'
    out = []
    for c in chunks:
        ch = c['chunk']
        heading = ' › '.join(c['seg']['path'])
        ch.index_text = f"{index_prefix(entry)}{'｜' + heading if heading else ''}\n{ch.text}"
        if ch.kind == 'footnote' and '对应正文' in ch.position:
            ch.index_text = f"{index_prefix(entry)}｜{ch.position}\n{ch.text}"
        out.append(ch)
    return out


def build(scheme, keep_spec_groups=False):
    """A、B 为实验方案；B+ 是产品接入用的 B（规格页按规格组切分，其余与 B 相同）。"""
    if scheme == 'A':
        return [c for e in sources() for c in chunk_plain(e)]
    return [c for e in sources() for c in chunk_structured(e, scheme, keep_spec_groups or scheme == 'B+')]


def save(chunks, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(json.dumps(asdict(c), ensure_ascii=False) for c in chunks) + '\n', encoding='utf-8')
