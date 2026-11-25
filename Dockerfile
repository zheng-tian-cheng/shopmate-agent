FROM python:3.13-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt requirements-rag.txt ./

RUN pip install --no-cache-dir \
    -r requirements.txt \
    -r requirements-rag.txt

COPY app.py .
COPY src/ ./src/
COPY data/ ./data/
COPY contracts/ ./contracts/

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
