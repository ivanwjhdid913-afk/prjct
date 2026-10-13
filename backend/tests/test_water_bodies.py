from uuid import uuid4

import httpx
import pytest
from sqlalchemy import create_engine, delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import engine, get_session
from app.main import app
from app.models import WaterBody
from app.seed import seed_demo


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def session():
    # Every test rolls back its own transaction, including demo deletions.
    with engine.connect() as connection:
        transaction = connection.begin()
        with Session(bind=connection) as db:
            db.execute(delete(WaterBody))
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


@pytest.mark.anyio
async def test_empty_database_returns_empty_page(client):
    response = await client.get("/api/v1/water-bodies")
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0, "limit": 50, "offset": 0}


@pytest.mark.anyio
async def test_returns_actual_database_record_and_provenance(client, session):
    object_id = uuid4()
    session.add(WaterBody(id=object_id, name="Контрольный синтетический объект", kind="lake", is_synthetic=True))
    session.flush()
    response = await client.get("/api/v1/water-bodies")
    assert response.status_code == 200
    assert response.json()["items"] == [{
        "id": str(object_id), "name": "Контрольный синтетический объект", "kind": "lake", "is_synthetic": True,
    }]


@pytest.mark.anyio
async def test_pagination_is_stable_and_reports_total(client, session):
    seed_demo(session)
    first = (await client.get("/api/v1/water-bodies?limit=2")).json()
    second = (await client.get("/api/v1/water-bodies?limit=2&offset=2")).json()
    assert first["total"] == second["total"] == 3
    assert len(first["items"]) == 2
    assert len(second["items"]) == 1
    assert len({row["id"] for row in first["items"] + second["items"]}) == 3
    assert first == (await client.get("/api/v1/water-bodies?limit=2")).json()


@pytest.mark.anyio
@pytest.mark.parametrize("query", ["limit=0", "limit=101", "offset=-1", "limit=abc"])
async def test_rejects_invalid_pagination(client, query):
    assert (await client.get(f"/api/v1/water-bodies?{query}")).status_code == 422


@pytest.mark.anyio
async def test_unreachable_database_returns_safe_503(client):
    unavailable = create_engine(engine.url.set(port=1), connect_args={"connect_timeout": 1})
    def override_session():
        with Session(unavailable) as db:
            yield db
    app.dependency_overrides[get_session] = override_session
    try:
        response = await client.get("/api/v1/water-bodies")
        assert response.status_code == 503
        assert response.json() == {"detail": "База данных временно недоступна."}
    finally:
        unavailable.dispose()


def test_demo_seed_is_repeatable_and_preserves_existing_records(session):
    sentinel = WaterBody(name="Другой синтетический пример", kind="river", is_synthetic=True)
    session.add(sentinel)
    session.flush()
    assert seed_demo(session) == 3
    assert seed_demo(session) == 0
    assert session.scalar(select(func.count()).select_from(WaterBody)) == 4
    assert session.get(WaterBody, sentinel.id).name == "Другой синтетический пример"
    assert all(session.scalars(select(WaterBody.is_synthetic)))


@pytest.mark.parametrize("name,kind", [("", "river"), ("   ", "lake"), ("Пример", "ocean")])
def test_database_rejects_invalid_objects(session, name, kind):
    session.add(WaterBody(name=name, kind=kind, is_synthetic=True))
    with pytest.raises(IntegrityError):
        session.flush()


def test_migration_and_postgis_are_present(session):
    assert session.scalar(text("SELECT version_num FROM alembic_version")) == "0001"
    assert session.scalar(text("SELECT postgis_version()"))
