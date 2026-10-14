from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.logging_config import configure_logging, logger
from app.config import settings
from app.api import health, profile_stub

configure_logging()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info(f"datasage-profiler listening on port {settings.PROFILER_PORT}")
    yield


app = FastAPI(title="DataSage Profiler", version="0.1.0", lifespan=lifespan)

app.include_router(health.router)
# profile_stub.py already declares the full "/internal/profile" path, so no
# prefix is added here — adding one would double it up.
app.include_router(profile_stub.router, tags=["internal"])
