from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import engine, get_session
from app.main import app
from app.models import WaterBody
from app.seed import seed_demo


@pytest.mark.anyio
async def test_empty_database_returns_empty_page(client):
    response = await client.get("/api/v1/water-bodies")
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0, "catalog_total": 0, "limit": 50, "offset": 0}


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
    assert session.scalar(text("SELECT version_num FROM alembic_version")) == "0004"
    assert session.scalar(text("SELECT postgis_version()"))


@pytest.mark.anyio
@pytest.mark.parametrize("query", ["реК", "  РЕК  ", "\tРеК\n", "УЧЕБНАЯ РЕКА"])
async def test_search_is_case_insensitive_and_trims_cyrillic(client, session, query):
    seed_demo(session)
    response = await client.get("/api/v1/water-bodies", params={"q": query})
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 1
    assert data["catalog_total"] == 3
    assert data["items"][0]["kind"] == "river"


@pytest.mark.anyio
@pytest.mark.parametrize("query", ["", "   \t\n"])
async def test_empty_search_does_not_filter(client, session, query):
    seed_demo(session)
    data = (await client.get("/api/v1/water-bodies", params={"q": query})).json()
    assert data["total"] == 3


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["river", "lake", "reservoir"])
async def test_each_kind_and_combined_search(client, session, kind):
    seed_demo(session)
    session.add(WaterBody(name="Другой синтетический пример", kind=kind, is_synthetic=True))
    session.flush()
    by_kind = (await client.get("/api/v1/water-bodies", params={"kind": kind})).json()
    assert by_kind["total"] == 2
    assert all(row["kind"] == kind for row in by_kind["items"])
    combined = (await client.get("/api/v1/water-bodies", params={"kind": kind, "q": "УЧЕБ"})).json()
    assert combined["total"] == 1
    assert combined["catalog_total"] == 4
    assert combined["items"][0]["kind"] == kind


@pytest.mark.anyio
@pytest.mark.parametrize("query", ["%", "_", "/", "\\"])
async def test_search_metacharacters_are_literal(client, session, query):
    session.add_all([
        WaterBody(name=f"Учебный {query} объект", kind="lake", is_synthetic=True),
        WaterBody(name="Учебный X объект", kind="lake", is_synthetic=True),
    ])
    session.flush()
    data = (await client.get("/api/v1/water-bodies", params={"q": query})).json()
    assert data["total"] == 1
    assert data["items"][0]["name"] == f"Учебный {query} объект"


@pytest.mark.anyio
async def test_cyrillic_yo_is_case_insensitive(client, session):
    session.add(WaterBody(name="Синтетическое озеро Ёлочное", kind="lake", is_synthetic=True))
    session.add(WaterBody(name="Другой синтетический объект", kind="lake", is_synthetic=True))
    session.flush()
    assert (await client.get("/api/v1/water-bodies", params={"q": "ёлОЧ"})).json()["total"] == 1


@pytest.mark.anyio
async def test_filtered_pagination_searches_entire_database(client, session):
    session.add_all([WaterBody(name=f"А пример {i:03}", kind="river", is_synthetic=True) for i in range(60)])
    session.add_all([WaterBody(name=f"Я озеро {i:03}", kind="lake", is_synthetic=True) for i in range(3)])
    session.flush()
    params = {"q": "ОЗЕРО", "kind": "lake", "limit": 2}
    first = (await client.get("/api/v1/water-bodies", params=params)).json()
    second = (await client.get("/api/v1/water-bodies", params={**params, "offset": 2})).json()
    assert first["catalog_total"] == second["catalog_total"] == 63
    assert first["total"] == second["total"] == 3
    assert len(first["items"]) == 2 and len(second["items"]) == 1
    assert len({row["id"] for row in first["items"] + second["items"]}) == 3


@pytest.mark.anyio
async def test_no_matches_is_distinct_from_empty_catalog(client, session):
    seed_demo(session)
    data = (await client.get("/api/v1/water-bodies", params={"q": "РЕКА", "kind": "lake"})).json()
    assert data["items"] == [] and data["total"] == 0 and data["catalog_total"] == 3
    session.execute(delete(WaterBody))
    empty = (await client.get("/api/v1/water-bodies", params={"q": "РЕКА", "kind": "lake"})).json()
    assert empty["items"] == [] and empty["catalog_total"] == 0


@pytest.mark.anyio
@pytest.mark.parametrize("params", [{"q": "я" * 121}, {"q": "\x00"}, {"kind": "ocean"}, {"kind": ""}, {"kind": "River"}])
async def test_invalid_search_parameters_are_rejected(client, params):
    assert (await client.get("/api/v1/water-bodies", params=params)).status_code == 422


@pytest.mark.anyio
async def test_maximum_search_length_is_accepted(client):
    assert (await client.get("/api/v1/water-bodies", params={"q": "я" * 120})).status_code == 200
