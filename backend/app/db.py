import os

from sqlalchemy import URL, create_engine
from sqlalchemy.orm import Session


def database_url() -> URL:
    return URL.create(
        "postgresql+psycopg",
        username=os.getenv("POSTGRES_USER", "water"),
        password=os.environ["POSTGRES_PASSWORD"],
        host=os.getenv("POSTGRES_HOST", "127.0.0.1"),
        port=int(os.getenv("POSTGRES_PORT", "55432")),
        database=os.getenv("POSTGRES_DB", "water"),
    )


engine = create_engine(database_url(), pool_pre_ping=True, connect_args={"connect_timeout": 3})


def get_session():
    with Session(engine) as session:
        yield session
