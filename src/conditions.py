"""Pure condition transitions. Every change is independently accepted or rejected.

Each rejection carries a code:
- invalid: the caller used the tool wrongly (wrong kind for a field, malformed value, op not allowed).
  The model can correct it; users only need to know which request was not recorded.
- rule: a business rule refused a well-formed change; the reason is written for users.
"""
from copy import deepcopy
import math

FIELDS = ('budget', 'anc', 'wearingStyle', 'scene')
STYLES = ('入耳式', '半入耳式', '头戴式')
ALLOWED = {'interpreter': ('set', 'update', 'remove', 'suggest', 'ask'),
           'ui': ('set', 'update', 'remove', 'confirm', 'dismiss', 'resolve'),
           'page': ('set',), 'system': ('suggest',)}


def empty_state(category='headphones'):
    return dict(schemaVersion=1, category=category, conditions=[], dismissed=[])


def kind_allowed(field, kind):
    return kind == 'scene' if field == 'scene' else kind in ('hard', 'soft')


def invalid(reason):
    return ('invalid', reason)


def rule(reason):
    return ('rule', reason)


def value_problem(field, value):
    if field == 'budget':
        if type(value) not in (int, float) or not math.isfinite(value):
            return invalid('预算需为数字')
        return None if 0 < value <= 100000 else rule('预算需大于 0 且不超过 100000 元')
    if field == 'anc':
        return None if type(value) is bool else invalid('主动降噪条件只能是“要”或“不要”')
    if field == 'wearingStyle':
        if not isinstance(value, dict) or not isinstance(value.get('exclude'), list):
            return invalid('佩戴方式条件格式不正确')
        items = value['exclude']
        if any(x not in STYLES for x in items) or len(set(items)) != len(items):
            return rule('佩戴方式不在支持范围内')
        return None if 0 < len(items) < 3 else rule('至少排除一种佩戴方式，且不能全部排除')
    if field == 'scene':
        if not isinstance(value, str):
            return invalid('使用场景需为文字')
        return None if value.strip() and len(value) <= 30 else rule('使用场景需为 1–30 个字')
    return invalid('不支持的条件字段')


def value_error(field, value):
    problem = value_problem(field, value)
    return problem[1] if problem else None


def check_change(state, c, origin):
    """None when the change is accepted, otherwise (code, reason)."""
    op, field = c.get('op'), c.get('field')
    if op not in ALLOWED.get(origin, ()):
        return invalid(f'{origin}不能执行“{op}”操作')
    if field not in FIELDS:
        return invalid('不支持的条件字段')
    if state['category'] != 'headphones' and field not in ('budget', 'scene'):
        return rule('请先选择支持这个条件的品类')
    current = next((x for x in state['conditions'] if x['field'] == field), None)
    status = current['status'] if current else None
    if op in ('set', 'suggest'):
        if op == 'suggest':
            if not isinstance(c.get('reason'), str) or not c['reason'].strip():
                return invalid('系统建议必须说明理由')
            if current and status != 'suggested':
                return rule('已有你设置或待确认的条件，系统建议不覆盖')
            if field in state['dismissed']:
                return rule('你已忽略过这条建议，本次选购不再提出')
        if not kind_allowed(field, c.get('kind')):
            return invalid('条件类别与字段不匹配')
        return value_problem(field, c.get('value'))
    if op == 'update':
        return value_problem(field, c.get('value')) if status == 'confirmed' else invalid('没有已生效的条件可以修改')
    if op == 'remove':
        return None if current else rule('没有可以取消的条件')
    if op == 'ask':
        if status == 'confirmed':
            return invalid('已有生效的条件，应直接修改而不是重新询问')
        if not isinstance(c.get('question'), str) or not c['question'].strip() or not isinstance(c.get('rawText'), str) or not isinstance(c.get('options'), list) or len(c['options']) < 2:
            return invalid('待确认项需要问题和至少两个选项')
        for o in c['options']:
            if not isinstance(o, dict) or not isinstance(o.get('label'), str) or not kind_allowed(field, o.get('kind')):
                return invalid('条件类别与字段不匹配')
            if problem := value_problem(field, o.get('value')):
                return problem
    if op == 'confirm':
        if status != 'suggested':
            return rule('没有可以采纳的建议')
        if 'kind' in c and not kind_allowed(field, c['kind']):
            return invalid('条件类别与字段不匹配')
    if op == 'dismiss':
        return None if status == 'suggested' else rule('没有可以忽略的建议')
    if op == 'resolve':
        if status != 'pending':
            return rule('没有待确认的问题')
        return None if type(c.get('option')) is int and 0 <= c['option'] < len(current['options']) else invalid('选项不存在')
    return None


def update_conditions(state, changes, origin):
    # Validate callers of the service as well as HTTP callers.
    from .models import ConditionState
    state = ConditionState.model_validate(state).model_dump(exclude_unset=True)
    state = deepcopy(state)
    applied, rejected = [], []
    for c in changes:
        if problem := check_change(state, c, origin):
            code, reason = problem
            rejected.append(dict(change=c, reason=reason, code=code))
            continue
        field, op = c['field'], c['op']
        current = next((x for x in state['conditions'] if x['field'] == field), None)
        source = 'page' if origin == 'page' else 'user'
        if op in ('remove', 'dismiss'):
            state['conditions'] = [x for x in state['conditions'] if x['field'] != field]
            if op == 'dismiss':
                state['dismissed'].append(field)
        else:
            if op in ('set', 'update', 'suggest'):
                item = dict(field=field, status='suggested' if op == 'suggest' else 'confirmed',
                            kind=current['kind'] if op == 'update' else c['kind'],
                            source='system' if op == 'suggest' else source, value=deepcopy(c['value']))
                if op == 'suggest':
                    item['reason'] = c['reason']
            elif op == 'ask':
                item = dict(field=field, status='pending', kind=None, source='user', question=c['question'], rawText=c['rawText'], options=deepcopy(c['options']))
            elif op == 'confirm':
                item = dict(current, status='confirmed', kind=c.get('kind', current['kind']))
            else:
                option = current['options'][c['option']]
                item = dict(field=field, status='confirmed', kind=option['kind'], source='user', value=deepcopy(option['value']))
            if current:
                state['conditions'][state['conditions'].index(current)] = item
            else:
                state['conditions'].append(item)
        applied.append(c)
    return dict(state=state, applied=applied, rejected=rejected)
