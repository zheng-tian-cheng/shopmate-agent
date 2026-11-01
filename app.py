"""ShopMate FastAPI 后端：商品数据、购买条件与筛选规则的唯一执行方。

启动（在项目根目录）：.venv/bin/python -m uvicorn app:app --reload --port 8000
接口文档：http://127.0.0.1:8000/docs
"""
import logging
import os
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from src.conditions import update_conditions
from src.models import (ApplyRequest, ApplyResponse, CatalogResponse, Product,
                        SearchRequest, SearchResponse, CompareRequest, CompareResponse)
from src.tools import PRODUCTS, SOURCES, get_product, search_products, compare_products

app = FastAPI(title='ShopMate', version='0.1.0')
app.add_middleware(CORSMiddleware, allow_origins=os.getenv('CORS_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000').split(','), allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])
log = logging.getLogger('shopmate')


# 未预料的异常也返回带说明的 JSON（前端据 detail 显示），细节只写入服务端日志
@app.exception_handler(Exception)
async def unexpected_error(request: Request, exc: Exception):
    log.exception('Unhandled error on %s %s', request.method, request.url.path)
    return JSONResponse(status_code=500, content={'detail': '商品服务内部错误，请稍后重试。'})


@app.get('/api/health')
def health():
    return {'status': 'ok', 'products': len(PRODUCTS)}


@app.get('/api/products', response_model=CatalogResponse)
def products():
    return dict(products=PRODUCTS, sources=SOURCES)


@app.post('/api/conditions/apply', response_model=ApplyResponse, response_model_exclude_unset=True)
def apply(request: ApplyRequest):
    return update_conditions(request.state.model_dump(exclude_unset=True), [c.model_dump(exclude_unset=True) for c in request.changes], request.origin)


@app.post('/api/products/search', response_model=SearchResponse)
def search(request: SearchRequest):
    return search_products(request.state.model_dump(exclude_unset=True), query=request.query.model_dump() if request.query else None)


@app.post('/api/products/compare', response_model=CompareResponse)
def compare(request: CompareRequest):
    try:
        return compare_products(request.product_ids)
    except KeyError as e:
        raise HTTPException(404, f'商品不存在：{e.args[0]}') from e


@app.get('/api/products/{product_id}', response_model=Product)
def detail(product_id: str):
    try:
        return get_product(product_id)
    except KeyError as e:
        raise HTTPException(404, f'商品不存在：{product_id}') from e
