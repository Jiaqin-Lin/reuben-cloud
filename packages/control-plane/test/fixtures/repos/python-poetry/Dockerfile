# fixture 自己的 Dockerfile —— 它就是 L2 的信号来源（推断只读它的 FROM，不复用它的步骤）。
FROM python:3.11-slim

WORKDIR /app
COPY pyproject.toml poetry.lock ./
RUN pip install --no-cache-dir poetry==1.8.3
COPY src ./src

CMD ["python", "-m", "app"]
