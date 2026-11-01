import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app import app
from src.conditions import empty_state

client = TestClient(app)
data = json.loads((Path(__file__).resolve().parents[1] / 'data/products.json').read_text())


def test_catalog_is_exact_formal_dataset():
    r = client.get('/api/products')
    assert r.status_code == 200
    assert len(r.json()['products']) == 15
    assert r.json() == {'products': data['products'], 'sources': data['sources']}


@pytest.mark.parametrize('product', data['products'], ids=lambda p: p['id'])
def test_detail_exact(product):
    assert client.get('/api/products/' + product['id']).json() == product


def test_missing_and_reserve():
    for id in ['not-a-product'] + [p['id'] for p in data['reserve']]:
        assert client.get('/api/products/' + id).status_code == 404
        assert client.post('/api/products/compare', json={'product_ids': [data['products'][0]['id'], id]}).status_code == 404


def test_budget_anc_and_update():
    changes = [dict(op='set', field='budget', kind='hard', value=300), dict(op='set', field='anc', kind='hard', value=True)]
    result = client.post('/api/conditions/apply', json=dict(state=empty_state(), changes=changes, origin='ui')).json()
    state = client.post('/api/conditions/apply', json=dict(state=result['state'], changes=[dict(op='update', field='budget', value=200)], origin='interpreter')).json()['state']
    assert state['conditions'][1] == result['state']['conditions'][1]
    result = client.post('/api/products/search', json={'state': state})
    assert result.status_code == 200
    expected = sorted((p for p in data['products'] if p['priceCny'] is not None and p['priceCny'] <= 200 and p['anc'] is True), key=lambda p: (p['priceCny'], p['id']))
    assert [m['product'] for m in result.json()['matches']] == expected


def test_compare_preserves_measurements():
    products = data['products'][:2]
    result = client.post('/api/products/compare', json={'product_ids': [p['id'] for p in products]})
    assert result.status_code == 200
    assert result.json()['products'] == products


@pytest.mark.parametrize('change', [dict(op='confirm', field='anc'), dict(op='set', field='budget', kind='hard', value=-1), dict(op='set', field='anc', kind='hard', value='true'), dict(op='explode', field='budget'), dict(op='set', field='bogus', value=1, kind='hard')])
def test_invalid_change_rejected(change):
    result = client.post('/api/conditions/apply', json=dict(state=empty_state(), changes=[change], origin='interpreter'))
    assert result.status_code == 200  # per-change rejection is the shared contract
    assert result.json()['state'] == empty_state()
    assert result.json()['rejected'][0]['reason']


@pytest.mark.parametrize('body', [{}, {'state': {}}, {'state': dict(empty_state(), conditions=[dict(field='budget', kind='hard', status='confirmed', source='user', value=True)])}])
def test_bad_request(body):
    assert client.post('/api/products/search', json=body).status_code == 422


@pytest.mark.parametrize('ids', [[], ['x'], ['x', 'x'], ['x', 'y', 'z']])
def test_bad_comparison(ids):
    assert client.post('/api/products/compare', json={'product_ids': ids}).status_code == 422


def test_docs_and_cors():
    assert client.get('/docs').status_code == 200
    r = client.options('/api/products/search', headers={'Origin': 'http://localhost:3000', 'Access-Control-Request-Method': 'POST'})
    assert r.headers['access-control-allow-origin'] == 'http://localhost:3000'


def test_search_inclusion_and_empty():
    r = client.post('/api/products/search', json={'state': empty_state(), 'query': {'wearing': '头戴式'}})
    assert all(m['product']['wearingStyle'] == '头戴式' for m in r.json()['matches'])
    state = dict(empty_state(), conditions=[dict(field='budget', status='confirmed', kind='hard', source='user', value=1)])
    assert client.post('/api/products/search', json={'state': state}).json()['matches'] == []


def test_health():
    assert client.get('/api/health').json() == {'status': 'ok', 'products': 15}


def test_unexpected_error_has_explanation(monkeypatch):
    import app as app_module
    def boom(*args, **kwargs):
        raise RuntimeError('boom')
    monkeypatch.setattr(app_module, 'search_products', boom)
    r = TestClient(app, raise_server_exceptions=False).post('/api/products/search', json={'state': empty_state()})
    assert r.status_code == 500
    assert r.json() == {'detail': '商品服务内部错误，请稍后重试。'}

