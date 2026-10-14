from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Mirrors backend-node/src/config.ts: one validated settings object,
    read once, nothing else touches os.environ directly.
    """

    model_config = SettingsConfigDict(env_prefix="", case_sensitive=True)

    PROFILER_PORT: int = 8001
    LOG_LEVEL: str = "info"


settings = Settings()
