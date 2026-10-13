from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.db import engine, get_session
from app.main import app

from app.seed import DEMO_RECORDS, seed_demo


def add_point(session, body_id, geometry="SRID=4326;POINT(39.25 52.75)", name="Синтетическая точка"):
    point_id = uuid4()
    session.execute(text("""INSERT INTO observation_points
        (id, name, water_body_id, position, is_synthetic, coordinate_source)
        VALUES (:id, :name, :body, ST_GeomFromEWKT(:geometry), true, 'Вымышленные координаты')"""),
        {"id": point_id, "name": name, "body": body_id, "geometry": geometry})
    return str(point_id)


@pytest.mark.anyio
async def test_coordinates_parent_scope_detail_and_missing_position(client, session):
    seed_demo(session)
    body_id = DEMO_RECORDS[0]["id"]
    point_id = add_point(session, body_id)
    missing_id = add_point(session, body_id, None, "Без положения")
    add_point(session, DEMO_RECORDS[1]["id"])
    data = (await client.get(f"/api/v1/water-bodies/{body_id}/observation-points")).json()
    assert data["total"] == len(data["items"]) == 2
    assert {p["id"] for p in data["items"]} == {point_id, missing_id}
    detail = (await client.get(f"/api/v1/observation-points/{point_id}")).json()
    assert detail["geometry"] == {"type": "Point", "coordinates": [39.25, 52.75]}
    assert detail["water_body"]["id"] == str(body_id)
    assert detail["water_body_id"] == str(body_id)
    assert detail["is_synthetic"] is True
    assert detail["coordinate_source"] == "Вымышленные координаты"
    assert (await client.get(f"/api/v1/observation-points/{missing_id}")).json()["geometry"] is None


@pytest.mark.parametrize("geometry", [
    "SRID=4326;POINT(181 52)", "SRID=4326;POINT(-181 52)",
    "SRID=4326;POINT(39 91)", "SRID=4326;POINT(39 -91)",
    "SRID=4326;POINT EMPTY", "SRID=4326;POINT(NaN 52)",
    "SRID=3857;POINT(39 52)",
    "SRID=4326;POINT Z(39 52 1)", "SRID=4326;LINESTRING(39 52,40 53)",
])
def test_database_rejects_invalid_geometry(session, geometry):
    seed_demo(session)
    with pytest.raises(DBAPIError) as error:
        add_point(session, DEMO_RECORDS[0]["id"], geometry)
    assert error.value.orig.sqlstate in {"23514", "22023"}


@pytest.mark.parametrize("longitude,latitude", [(float("inf"), 52), (39, float("-inf")), (float("nan"), 52)])
def test_nonfinite_numeric_coordinates_are_rejected(session, longitude, latitude):
    seed_demo(session)
    point_id = add_point(session, DEMO_RECORDS[0]["id"])
    with pytest.raises(DBAPIError) as error:
        session.execute(text("UPDATE observation_points SET position=ST_SetSRID(ST_MakePoint(:x,:y),4326) WHERE id=:id"),
                        {"x": longitude, "y": latitude, "id": point_id})
    assert error.value.orig.sqlstate == "23514"


@pytest.mark.anyio
@pytest.mark.parametrize("geometry,expected", [
    ("SRID=4326;POINT(-180 -90)", [-180, -90]),
    ("SRID=4326;POINT(180 90)", [180, 90]),
    ("SRID=4326;POINT(52 39)", [52, 39]),
])
async def test_valid_bounds_and_no_automatic_coordinate_swapping(client, session, geometry, expected):
    seed_demo(session)
    point_id = add_point(session, DEMO_RECORDS[0]["id"], geometry)
    assert (await client.get(f"/api/v1/observation-points/{point_id}")).json()["geometry"]["coordinates"] == expected


def test_point_requires_existing_parent(session):
    with pytest.raises(DBAPIError) as error:
        add_point(session, uuid4())
    assert error.value.orig.sqlstate == "23503"


@pytest.mark.anyio
@pytest.mark.parametrize("path", ["water-bodies/{id}/observation-points", "observation-points/{id}"])
async def test_points_database_failure_is_safe_503(client, path):
    unavailable = create_engine(engine.url.set(port=1), connect_args={"connect_timeout": 1})
    def override_session():
        with Session(unavailable) as db:
            yield db
    app.dependency_overrides[get_session] = override_session
    try:
        response = await client.get("/api/v1/" + path.format(id=uuid4()))
        assert response.status_code == 503
        assert response.json() == {"detail": "База данных временно недоступна."}
    finally:
        unavailable.dispose()


def test_point_seed_is_repeatable_and_does_not_replace_modified_coordinates(session):
    from app.seed import seed_points
    seed_demo(session)
    assert seed_points(session) == 4
    first = session.execute(text("SELECT id FROM observation_points WHERE position IS NOT NULL ORDER BY id LIMIT 1")).scalar_one()
    session.execute(text("UPDATE observation_points SET position=ST_SetSRID(ST_MakePoint(41.25,53.75),4326), name='Изменённый пример' WHERE id=:id"), {"id": first})
    assert seed_points(session) == 0
    row = session.execute(text("SELECT name, ST_X(position), ST_Y(position) FROM observation_points WHERE id=:id"), {"id": first}).one()
    assert tuple(row) == ("Изменённый пример", 41.25, 53.75)
    assert session.scalar(text("SELECT count(*) FROM observation_points WHERE position IS NULL")) == 1


def test_point_seed_does_not_attach_to_repurposed_parent(session):
    from app.seed import seed_points
    seed_demo(session)
    session.execute(text("UPDATE water_bodies SET is_synthetic=false WHERE id=:id"), {"id": DEMO_RECORDS[0]["id"]})
    seed_points(session)
    assert session.scalar(text("SELECT count(*) FROM observation_points WHERE water_body_id=:id"), {"id": DEMO_RECORDS[0]["id"]}) == 0


@pytest.mark.anyio
async def test_existing_water_body_without_points_has_empty_collection(client, session):
    seed_demo(session)
    body_id = str(DEMO_RECORDS[0]["id"])
    response = await client.get(f"/api/v1/water-bodies/{body_id}/observation-points")
    assert response.status_code == 200
    assert response.json()["water_body"]["id"] == body_id
    assert response.json()["items"] == []
    assert response.json()["total"] == 0


@pytest.mark.anyio
@pytest.mark.parametrize("path", ["water-bodies/{id}/observation-points", "observation-points/{id}"])
async def test_unknown_and_malformed_ids(client, path):
    assert (await client.get("/api/v1/" + path.format(id=uuid4()))).status_code == 404
    assert (await client.get("/api/v1/" + path.format(id="not-a-uuid"))).status_code == 422
