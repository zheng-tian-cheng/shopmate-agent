import json
from pathlib import Path
import pytest
from src.conditions import empty_state, update_conditions
from src.models import ConditionState
from src.tools import search_products

CONTRACT = json.loads((Path(__file__).resolve().parents[1] / 'contracts/condition-cases.json').read_text())


@pytest.mark.parametrize('case', CONTRACT['applyCases'], ids=lambda c: c['name'])
def test_apply_contract(case):
    state = empty_state()
    rejected = []
    for step in case['steps']:
        result = update_conditions(state, step['changes'], step['origin'])
        state = result['state']
        ConditionState.model_validate(state)
        rejected.extend(c['change']['op'] for c in result['rejected'])
    assert state['conditions'] == case['expect']['conditions']
    assert state['dismissed'] == case['expect']['dismissed']
    assert rejected == case['expect']['rejectedOps']


@pytest.mark.parametrize('case', CONTRACT['searchCases'], ids=lambda c: c['name'])
def test_search_contract(case):
    state = dict(empty_state(), conditions=case['conditions'])
    assert [m['product']['id'] for m in search_products(state, case['products'])['matches']] == case['expectIds']
