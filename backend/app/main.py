import json
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import ObservationPoint, WaterBody
from app.simulation import router as simulation_router
from app.scenarios import router as scenarios_router

app = FastAPI(title="Water observations", version="0.1.0")
app.include_router(simulation_router)
app.include_router(scenarios_router)


class WaterBodyView(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    kind: Literal["river", "lake", "reservoir"]
    is_synthetic: bool


class WaterBodyPage(BaseModel):
    items: list[WaterBodyView]
    total: int
    catalog_total: int
    limit: int
    offset: int


@app.get("/api/v1/water-bodies", response_model=WaterBodyPage)
def list_water_bodies(
    session: Annotated[Session, Depends(get_session)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str, Query(max_length=120, pattern=r"^[^\x00]*$")] = "",
    kind: Literal["river", "lake", "reservoir"] | None = None,
):
    try:
        conditions = []
        if search := q.strip():
            conditions.append(WaterBody.name.icontains(search, autoescape=True))
        if kind is not None:
            conditions.append(WaterBody.kind == kind)
        count = select(func.count()).select_from(WaterBody)
        catalog_total = session.scalar(count)
        total = session.scalar(count.where(*conditions)) if conditions else catalog_total
        objects = session.scalars(
            select(WaterBody).where(*conditions).order_by(WaterBody.name, WaterBody.id).limit(limit).offset(offset)
        ).all()
        return WaterBodyPage(
            items=[WaterBodyView.model_validate(item) for item in objects],
            total=total,
            catalog_total=catalog_total,
            limit=limit,
            offset=offset,
        )
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="База данных временно недоступна.") from None


class PointGeometry(BaseModel):
    type: Literal["Point"] = "Point"
    coordinates: tuple[float, float]  # GeoJSON: longitude, latitude in EPSG:4326.


class ObservationPointView(BaseModel):
    id: UUID
    name: str
    water_body_id: UUID
    geometry: PointGeometry | None
    is_synthetic: bool
    coordinate_source: str


class ObservationPointCollection(BaseModel):
    water_body: WaterBodyView
    items: list[ObservationPointView]
    total: int


class ObservationPointDetail(ObservationPointView):
    water_body: WaterBodyView


def point_view(point: ObservationPoint, geometry: str | None) -> ObservationPointView:
    return ObservationPointView(
        id=point.id, name=point.name, water_body_id=point.water_body_id,
        geometry=json.loads(geometry) if geometry else None,
        is_synthetic=point.is_synthetic, coordinate_source=point.coordinate_source,
    )


@app.get("/api/v1/water-bodies/{water_body_id}/observation-points", response_model=ObservationPointCollection)
def list_observation_points(water_body_id: UUID, session: Annotated[Session, Depends(get_session)]):
    try:
        body = session.get(WaterBody, water_body_id)
        if body is None:
            raise HTTPException(status_code=404, detail="Водный объект не найден.")
        rows = session.execute(select(ObservationPoint, func.ST_AsGeoJSON(ObservationPoint.position, 15))
                               .where(ObservationPoint.water_body_id == water_body_id)
                               .order_by(ObservationPoint.name, ObservationPoint.id)).all()
        items = [point_view(point, geometry) for point, geometry in rows]
        # The initial map always receives the complete collection, never a hidden first page.
        return ObservationPointCollection(water_body=WaterBodyView.model_validate(body), items=items, total=len(items))
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="База данных временно недоступна.") from None


@app.get("/api/v1/observation-points/{point_id}", response_model=ObservationPointDetail)
def get_observation_point(point_id: UUID, session: Annotated[Session, Depends(get_session)]):
    try:
        row = session.execute(select(ObservationPoint, func.ST_AsGeoJSON(ObservationPoint.position, 15), WaterBody)
                              .join(WaterBody, ObservationPoint.water_body_id == WaterBody.id)
                              .where(ObservationPoint.id == point_id)).first()
        if row is None:
            raise HTTPException(status_code=404, detail="Точка наблюдения не найдена.")
        point, geometry, body = row
        return ObservationPointDetail(**point_view(point, geometry).model_dump(), water_body=WaterBodyView.model_validate(body))
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="База данных временно недоступна.") from None
