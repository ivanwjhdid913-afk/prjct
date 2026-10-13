import os
import re

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

# Refuse direct pytest against the working database, before importing the app.
test_database = os.environ.get("WATER_TEST_DB", "")
if not re.fullmatch(r"water_test_[0-9a-f]{32}", test_database) or os.environ.get("POSTGRES_DB") != test_database:
    raise pytest.UsageError("Use python run_tests.py: tests require a separate disposable database.")

from app.db import engine, get_session
from app.main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def session():
    with engine.connect() as connection:
        transaction = connection.begin()
        assert connection.scalar(text("SELECT current_database()")) == test_database
        with Session(bind=connection) as db:
            def override_session():
                yield db
            app.dependency_overrides[get_session] = override_session
            try:
                yield db
            finally:
                app.dependency_overrides.clear()
        if transaction.is_active:
            transaction.rollback()


@pytest.fixture
async def client(session):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as value:
        yield value
