FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
RUN groupadd --system datasage \
    && useradd --system --gid datasage --home-dir /app datasage
COPY requirements.lock ./
RUN pip install --no-cache-dir --no-deps -r requirements.lock
COPY --chown=datasage:datasage app ./app
COPY --chown=datasage:datasage vendor ./vendor
USER datasage
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=3)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
