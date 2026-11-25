import asyncio
import json
import time
from pathlib import Path
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from src.agent import get_model
from google.genai import types


CASES = [
    ("T01", "300元以内的耳机", "upper", [300]),
    ("T02", "500元以上的耳机", "lower", [500]),
    ("T03", "200到400元的耳机", "range", [200, 400]),
    ("T04", "300元左右的耳机", "approx", [300]),
    ("T05", "推荐一款降噪耳机", "none", []),
    ("T06", "预算不要超过一千元", "upper", [1000]),
    ("T07", "两三百块钱的耳机", "range", [200, 300]),
    ("T08", "至少150元，最多350元", "range", [150, 350]),
    ("T09", "预算从500元降低到300元以内", "upper", [300]),
    ("T10", "推荐蓝牙5.3的耳机", "none", []),
]

PROMPT = """
你是购物需求解析器，只提取用户当前的预算意图。

type的可选值：
upper：预算上限
lower：预算下限
range：价格区间
approx：近似预算
none：没有预算要求

amounts为人民币数值列表。
区间按照从低到高排列。
没有预算时返回空列表。
商品型号和技术参数不是预算。
只返回JSON，不要解释。
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "type": {
            "type": "string",
            "enum": ["upper", "lower", "range", "approx", "none"]
        },
        "amounts": {
            "type": "array",
            "items": {"type": "number"}
        }
    },
    "required": ["type", "amounts"],
    "additionalProperties": False
}


class BudgetResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["upper", "lower", "range", "approx", "none"]
    amounts: list[float]


async def predict(model, provider, question):
    if provider == "ollama":
        response = await model.client.post(
            f"{model.base_url}/api/chat",
            json={
                "model": model.model,
                "messages": [
                    {"role": "system", "content": PROMPT},
                    {"role": "user", "content": question}
                ],
                "format": SCHEMA,
                "stream": False,
                "think": False,
                "options": {
                    "temperature": 0,
                    "num_ctx": 4096,
                    "num_predict": 1024
                }
            },
            timeout=60
        )

        response.raise_for_status()
        return response.json()["message"]["content"]

    response = await model.connect().aio.models.generate_content(
        model=model.model,
        contents=question,
        config=types.GenerateContentConfig(
            system_instruction=PROMPT,
            temperature=0,
            response_mime_type="application/json",
            response_json_schema=SCHEMA,
            max_output_tokens=1024,
            thinking_config=types.ThinkingConfig(
                thinking_level="low"
            )
        )
    )

    return response.text


async def main():
    model = get_model()
    provider = getattr(model, "provider", "gemini")
    results = []

    print("MODEL:", model.model, flush=True)

    try:
        for case_id, question, kind, amounts in CASES:
            expected = {"type": kind, "amounts": amounts}
            start = time.perf_counter()
            actual = None
            raw = None
            error = None

            try:
                raw = await predict(model, provider, question)

                actual = BudgetResult.model_validate_json(
                    raw
                ).model_dump()

                status = "PASS" if actual == expected else "FAIL"

            except Exception as e:
                status = "ERROR"
                error = str(e)

            latency = time.perf_counter() - start

            results.append({
                "id": case_id,
                "question": question,
                "expected": expected,
                "actual": actual,
                "raw": raw,
                "status": status,
                "latency": latency,
                "error": error
            })

            print(
                case_id, status,
                actual,
                f"{latency:.2f}s",
                error or "",
                flush=True
            )

        total = len(results)
        passed = sum(r["status"] == "PASS" for r in results)
        errors = sum(r["status"] == "ERROR" for r in results)

        summary = {
            "provider": provider,
            "model": model.model,
            "total": total,
            "passed": passed,
            "errors": errors,
            "accuracy": passed / total,
            "avg_latency": sum(
                r["latency"] for r in results
            ) / total
        }

        print("\nSUMMARY:")
        print(json.dumps(summary, indent=2))

        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")

        path = Path(
            f"experiments/model_eval/results/{provider}-{timestamp}.json"
        )

        path.write_text(
            json.dumps(
                {"summary": summary, "results": results},
                ensure_ascii=False,
                indent=2
            ),
            encoding="utf-8"
        )

        print("SAVED:", path)

    finally:
        await model.close()


if __name__ == "__main__":
    asyncio.run(main())
