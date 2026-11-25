"""Ollama adapter for the existing Agent tool loop."""

import json
import os

import httpx
from google.genai import types

from . import agent_config as config


class OllamaModel:

    provider = "ollama"

    def __init__(self, declarations):
        self.model = os.getenv("OLLAMA_MODEL", "qwen3:1.7b")
        self.base_url = os.getenv(
            "OLLAMA_BASE_URL", "http://localhost:11434"
        ).rstrip("/")

        self.client = httpx.AsyncClient(
            timeout=config.MODEL_REQUEST_TIMEOUT_SECONDS,
            trust_env=False,
        )

        self.tools = [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters_json_schema,
                },
            }
            for tool in declarations
        ]

    def convert_messages(self, contents):
        messages = [
            {
                "role": "system",
                "content": config.SYSTEM_PROMPT,
            }
        ]

        for content in contents:
            role = (
                "assistant" if content.role == "model"
                else "user"
            )

            texts = []
            calls = []

            for part in content.parts or []:
                if part.function_response:
                    result = part.function_response
                    messages.append({
                        "role": "tool",
                        "tool_name": result.name,
                        "content": json.dumps(
                            result.response,
                            ensure_ascii=False,
                        ),
                    })

                elif part.function_call:
                    call = part.function_call
                    item = {
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": call.args or {},
                        },
                    }
                    if call.id:
                        item["id"] = call.id
                    calls.append(item)

                elif part.text and not part.thought:
                    texts.append(part.text)

            if texts or calls:
                message = {
                    "role": role,
                    "content": "\\n".join(texts),
                }
                if calls:
                    message["tool_calls"] = calls

                messages.append(message)

        return messages

    async def generate(self, contents):
        from .agent import ChatError

        payload = {
            "model": self.model,
            "messages": self.convert_messages(contents),
            "tools": self.tools,
            "stream": False,
            "think": False,
            "options": {
                "num_ctx": int(os.getenv("OLLAMA_NUM_CTX", "8192")),
                "num_predict": 3000,
                "temperature": 0,
            },
        }

        try:
            response = await self.client.post(
                f"{self.base_url}/api/chat",
                json=payload,
            )
            response.raise_for_status()

        except httpx.TimeoutException:
            raise ChatError(
                "MODEL_TIMEOUT", "Ollama 推理超时", 504
            ) from None

        except httpx.HTTPStatusError as exc:
            raise ChatError(
                "OLLAMA_UNAVAILABLE",
                f"Ollama 请求失败：HTTP {exc.response.status_code}",
                502,
            ) from None

        except httpx.TransportError:
            raise ChatError(
                "NETWORK", "无法连接 Ollama 服务", 503
            ) from None

        data = response.json()
        message = data["message"]
        parts = []

        if message.get("content"):
            parts.append(
                types.Part(text=message["content"])
            )

        for call in message.get("tool_calls") or []:
            function = call["function"]

            parts.append(
                types.Part(
                    function_call=types.FunctionCall(
                        id=call.get("id"),
                        name=function["name"],
                        args=function.get("arguments") or {},
                    )
                )
            )

        return types.GenerateContentResponse(
            candidates=[
                types.Candidate(
                    content=types.Content(
                        role="model",
                        parts=parts,
                    ),
                    finish_reason=(
                        types.FinishReason.MAX_TOKENS
                        if data.get("done_reason") == "length"
                        else types.FinishReason.STOP
                    ),
                )
            ],
            usage_metadata=types.GenerateContentResponseUsageMetadata(
                prompt_token_count=data.get("prompt_eval_count"),
                candidates_token_count=data.get("eval_count"),
            ),
        )

    async def close(self):
        await self.client.aclose()
