FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /service

COPY pyproject.toml ./
COPY app ./app
COPY server.py ./

RUN pip install --no-cache-dir .

CMD ["sh", "-c", "uvicorn server:api --host 0.0.0.0 --port ${PORT:-8080}"]
