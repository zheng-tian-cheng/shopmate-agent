"""HTTP/data models; nulls and separate measurement scopes are preserved."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator
from .conditions import FIELDS, kind_allowed, value_error


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


FieldName = Literal['budget', 'anc', 'wearingStyle', 'scene']
Kind = Literal['hard', 'soft', 'scene']
Style = Literal['入耳式', '半入耳式', '头戴式']


class Option(Model):
    label: str
    kind: Kind
    value: JsonValue


class ActiveCondition(Model):
    field: FieldName
    status: Literal['confirmed', 'suggested']
    kind: Kind
    source: Literal['user', 'page', 'system']
    value: JsonValue
    reason: str | None = None

    @model_validator(mode='after')
    def valid(self):
        if not kind_allowed(self.field, self.kind) or value_error(self.field, self.value):
            raise ValueError('条件类别或值不合法')
        if self.status == 'suggested' and (self.source != 'system' or not self.reason or not self.reason.strip()):
            raise ValueError('建议必须来自系统并说明理由')
        return self


class PendingCondition(Model):
    field: FieldName
    status: Literal['pending']
    kind: None
    source: Literal['user']
    question: str = Field(min_length=1)
    rawText: str
    options: list[Option] = Field(min_length=2)

    @model_validator(mode='after')
    def valid(self):
        if not self.question.strip() or any(not kind_allowed(self.field, o.kind) or value_error(self.field, o.value) for o in self.options):
            raise ValueError('待确认问题或选项不合法')
        return self


Condition = Annotated[ActiveCondition | PendingCondition, Field(discriminator='status')]


class ConditionState(Model):
    schemaVersion: Literal[1]
    category: Literal['headphones'] | None
    conditions: list[Condition]
    dismissed: list[FieldName]

    @model_validator(mode='after')
    def valid(self):
        fields = [c.field for c in self.conditions]
        if len(set(fields)) != len(fields) or len(set(self.dismissed)) != len(self.dismissed):
            raise ValueError('条件或忽略列表重复')
        if self.category is None and any(f not in ('budget', 'scene') for f in fields):
            raise ValueError('条件不适用于当前品类')
        return self


class Change(Model):
    # Semantic errors are rejected per change, preserving the contract's partial application.
    op: str
    field: str
    kind: str | None = None
    value: JsonValue = None
    reason: str | None = None
    question: str | None = None
    rawText: str | None = None
    options: list[Option] | None = None
    option: int | None = None


class ApplyRequest(Model):
    state: ConditionState
    changes: list[Change]
    origin: Literal['interpreter', 'ui', 'page', 'system']


class Rejected(Model):
    change: Change
    reason: str
    code: Literal['invalid', 'rule']  # 见 conditions.py：调用方式不对 / 业务规则不允许


class ApplyResponse(Model):
    state: ConditionState
    applied: list[Change]
    rejected: list[Rejected]


class Battery(Model):
    scope: Literal['single', 'total', 'unspecified']
    anc: Literal['off', 'on', 'unspecified']
    hours: float


class Weight(Model):
    scope: Literal['earbud', 'total', 'unspecified']
    grams: float


class OfficialLink(Model):
    label: str
    url: str


class Source(Model):
    title: str | None
    publisher: str
    kind: Literal['official', 'media']
    url: str
    publishedAt: str | None
    accessedAt: str
    supports: str


class Product(Model):
    id: str
    brand: str
    model: str
    displayName: str
    wearingStyle: Style | None
    anc: bool | None
    ancSpec: str | None
    priceCny: float | None
    priceType: str | None
    priceConditions: str
    priceVerifiedAt: str | None
    battery: list[Battery]
    batteryConditions: str | None
    weight: list[Weight]
    weightNote: str | None
    bluetooth: str | None
    officialLink: OfficialLink | None
    fieldSources: dict[str, list[str]]
    notes: list[str]


class CatalogResponse(Model):
    products: list[Product]
    sources: dict[str, Source]


class Query(Model):
    anc: bool = False
    wearing: Style | None = None
    budgetMax: float | None = Field(default=None, ge=0, le=100000)
    budgetNear: float | None = Field(default=None, ge=0, le=100000)
    terms: list[str] = Field(default_factory=list)


class SearchRequest(Model):
    state: ConditionState
    query: Query | None = None


class Failure(Model):
    field: FieldName
    reason: Literal['not-satisfied', 'unknown', 'no-price']


class Evaluation(Model):
    eligible: bool
    failures: list[Failure]
    softMatched: list[FieldName]
    notes: list[str]


class Match(Model):
    product: Product
    evaluation: Evaluation


class SearchResponse(Model):
    matches: list[Match]
    evaluations: dict[str, Evaluation]


class CompareRequest(Model):
    product_ids: list[str] = Field(min_length=2, max_length=2)

    @model_validator(mode='after')
    def distinct(self):
        if self.product_ids[0] == self.product_ids[1]:
            raise ValueError('请选择两款不同商品')
        return self


class CompareResponse(Model):
    products: list[Product] = Field(min_length=2, max_length=2)
