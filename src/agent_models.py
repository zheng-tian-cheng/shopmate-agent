from typing import Literal
from pydantic import Field, model_validator
from .models import Model, ConditionState, Change, Rejected, FieldName


class HistoryMessage(Model):
    role: Literal['user', 'assistant']
    text: str = Field(max_length=6000)
    productRefs: list[str] = Field(default_factory=list, max_length=15)
    viewedProductId: str | None = None


class ChatRequest(Model):
    message: str = Field(min_length=1, max_length=2000)
    state: ConditionState
    viewedProductId: str | None = None
    history: list[HistoryMessage] = Field(default_factory=list, max_length=30)

    @model_validator(mode='after')
    def nonblank(self):
        if not self.message.strip():
            raise ValueError('消息不能为空')
        return self


class SelectCategory(Model):
    category: Literal['headphones', 'unsupported', 'unclear']


class UpdateConditions(Model):
    changes: list[Change] = Field(min_length=1, max_length=8)


class NoArgs(Model):
    pass


class GetProduct(Model):
    product_id: str = Field(min_length=1, max_length=100)


class RetrieveEvidence(Model):
    product_ids: list[str] = Field(min_length=1, max_length=3)
    question: str = Field(min_length=1, max_length=300)


class Respond(Model):
    text: str = Field(min_length=1, max_length=3000)
    recommend_ids: list[str] = Field(default_factory=list, max_length=3)
    product_refs: list[str] = Field(default_factory=list, max_length=15)


class ToolStatus(Model):
    name: str
    status: Literal['ok', 'rejected']
    message: str | None = None


class ChatRecommendation(Model):
    productId: str
    softMatched: list[FieldName]  # 前端据此生成卡片上的“符合条件”理由


class EvidenceRef(Model):
    """回答引用的官网资料：编号与正文中的 [S…] 对应，可追溯到来源登记表和页面位置。"""
    ref: str
    productId: str
    sourceId: str
    source: str
    region: str
    position: str
    url: str | None = None


class ChatResponse(Model):
    reply: str
    state: ConditionState
    applied: list[Change]
    rejected: list[Rejected]
    recommendations: list[ChatRecommendation] | None = None
    matchCount: int | None = None
    productRefs: list[str]
    compareIds: list[str] | None = None
    tools: list[ToolStatus]
    evidence: list[EvidenceRef] | None = None
    mode: Literal['gemini'] = 'gemini'


class ChatFailure(Model):
    code: str
    message: str
    retryable: bool


class ChatErrorResponse(Model):
    error: ChatFailure
