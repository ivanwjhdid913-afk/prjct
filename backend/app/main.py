from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import WaterBody

app = FastAPI(title="Water observations", version="0.1.0")


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
