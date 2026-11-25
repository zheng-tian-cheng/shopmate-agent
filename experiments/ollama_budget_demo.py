import asyncio
import json

from src.agent import get_model
from src.agent_models import UpdateConditions
from src.conditions import update_conditions
from src.tools import search_products

async def main():
    model = get_model()

    schema = {
        "type": "object",
        "properties": {
            "budget": {
                "type": "number",
                "minimum": 1
            }
        },
        "required": ["budget"],
        "additionalProperties": False
    }

    try:
        response = await model.client.post(
            f"{model.base_url}/api/chat",
            json={
                "model": model.model,
                "messages": [
                    {
                        "role": "system",
                        "content": "提取用户明确提出的预算上限，返回JSON。"
                    },
                    {
                        "role": "user",
                        "content": "帮我推荐300元以内的蓝牙耳机"
                    }
                ],
                "format": schema,
                "stream": False,
                "think": False,
                "options": {
                    "temperature": 0,
                    "num_predict": 128
                }
            },
            timeout=60
        )

        response.raise_for_status()

        data = json.loads(
            response.json()["message"]["content"]
        )

        print("MODEL OUTPUT:", data)

        # 验证本次测试的语义提取结果
        assert data["budget"] == 300, "预算提取错误"

        args = UpdateConditions.model_validate({
            "changes": [{
                "op": "set",
                "field": "budget",
                "kind": "hard",
                "value": data["budget"]
            }]
        })

        state = {
            "schemaVersion": 1,
            "category": "headphones",
            "conditions": [],
            "dismissed": []
        }

        result = update_conditions(
            state,
            [
                c.model_dump(exclude_unset=True)
                for c in args.changes
            ],
            "interpreter"
        )

        assert not result["rejected"], result["rejected"]

        state = result["state"]
        print("STATE:", state)

        matches = search_products(state)["matches"]

        print("MATCH COUNT:", len(matches))
        print("\nRECOMMENDATIONS:")

        for item in matches[:3]:
            product = item["product"]
            assert product["priceCny"] <= data["budget"]
            print(product["id"], product["priceCny"])

        print("\nSUCCESS")

    finally:
        await model.close()

if __name__ == "__main__":
    asyncio.run(main())
