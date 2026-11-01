"""LLM-ready catalog, search and comparison services. No network or session storage."""
import json
from pathlib import Path
from .models import Product, Source, ConditionState

DATA = json.loads((Path(__file__).resolve().parents[1] / 'data/products.json').read_text())
PRODUCTS = [Product.model_validate(p).model_dump() for p in DATA['products']]
SOURCES = {k: Source.model_validate(v).model_dump() for k, v in DATA['sources'].items()}


def get_product(product_id):
    for p in PRODUCTS:
        if p['id'] == product_id:
            return p
    raise KeyError(product_id)


def compare_products(product_ids):
    if len(product_ids) != 2 or len(set(product_ids)) != 2:
        raise ValueError('请选择两款不同商品')
    return {'products': [get_product(i) for i in product_ids]}


def price(p):
    return p.get('priceCny', p.get('price'))


def check(p, field, value):
    if field == 'budget':
        return None if price(p) is None else price(p) <= value
    if field == 'anc':
        return None if p['anc'] in (None, 'unknown') else p['anc'] == value
    if field == 'wearingStyle':
        return None if p['wearingStyle'] in (None, 'unknown') else p['wearingStyle'] not in value['exclude']
    return True


def evaluate_product(p, state):
    failures, matched, notes = [], [], []
    for c in state['conditions']:
        if c['status'] != 'confirmed' or c['kind'] == 'scene':
            continue
        result = check(p, c['field'], c['value'])
        if c['kind'] == 'hard' and result is not True:
            failures.append(dict(field=c['field'], reason='not-satisfied' if result is False else 'no-price' if c['field'] == 'budget' else 'unknown'))
        elif c['kind'] == 'soft':
            if c['field'] == 'budget':
                if price(p) is not None and price(p) > c['value']:
                    excess = round(price(p) - c['value'], 2)
                    notes.append(f'超出参考预算 ¥{int(excess) if excess.is_integer() else format(excess, ".2f")}')
            elif result is True:
                matched.append(c['field'])
    if price(p) is None:
        notes.append('价格待核验')
    if p['anc'] in (None, 'unknown'):
        notes.append('降噪资料缺失')
    return dict(eligible=state['category'] == 'headphones' and not failures, failures=failures, softMatched=matched, notes=notes)


def search_products(state, products=None, query=None):
    state = ConditionState.model_validate(state).model_dump(exclude_unset=True)
    products = PRODUCTS if products is None else products
    evaluations = {p['id']: evaluate_product(p, state) for p in products}
    matches = [dict(product=p, evaluation=evaluations[p['id']]) for p in products if evaluations[p['id']]['eligible']]
    target = next((c['value'] for c in state['conditions'] if c['status'] == 'confirmed' and c['field'] == 'budget' and c['kind'] == 'soft'), None)
    def amount(p):
        return float('inf') if price(p) is None else price(p)
    matches.sort(key=lambda m: (-len(m['evaluation']['softMatched']), abs(amount(m['product']) - target) if target is not None else amount(m['product']), amount(m['product']), m['product']['id']))
    if query:
        def accepts(p):
            text = ''.join(f"{p['brand']} {p['displayName']} {p['model']}".lower().split())
            return (not query['anc'] or p['anc'] is True) and (not query['wearing'] or p['wearingStyle'] == query['wearing']) and (query['budgetMax'] is None or price(p) is not None and price(p) <= query['budgetMax']) and all(''.join(t.split()).lower() in text for t in query['terms'])
        matches = [m for m in matches if accepts(m['product'])]
        if query['budgetNear'] is not None:
            matches.sort(key=lambda m: (abs(amount(m['product']) - query['budgetNear']), amount(m['product']), m['product']['id']))
    return dict(matches=matches, evaluations=evaluations)
