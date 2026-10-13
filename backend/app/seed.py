"""Explicit, repeatable loading of fictional demonstration records."""

from uuid import UUID

from geoalchemy2 import WKTElement
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db import engine
from app.models import ObservationPoint, WaterBody

DEMO_RECORDS = [
    {"id": UUID("e432f7c0-4cec-4583-9537-000000000001"), "name": "Учебная река № 1", "kind": "river", "is_synthetic": True},
    {"id": UUID("e432f7c0-4cec-4583-9537-000000000002"), "name": "Учебное озеро № 1", "kind": "lake", "is_synthetic": True},
    {"id": UUID("e432f7c0-4cec-4583-9537-000000000003"), "name": "Учебное водохранилище № 1", "kind": "reservoir", "is_synthetic": True},
]


def seed_demo(session: Session) -> int:
    inserted = session.scalars(
        insert(WaterBody).values(DEMO_RECORDS).on_conflict_do_nothing(index_elements=[WaterBody.id]).returning(WaterBody.id)
    ).all()
    return len(inserted)


def seed_points(session: Session) -> int:
    points = [
        (1, 0, "Учебная точка А", "POINT(39.25 52.75)"),
        (2, 0, "Учебная точка Б", "POINT(39.28 52.765)"),
        (3, 0, "Учебная точка без координат", None),
        (4, 1, "Учебная озёрная точка", "POINT(39.31 52.72)"),
    ]
    inserted = 0
    for number, parent_index, name, position in points:
        expected = DEMO_RECORDS[parent_index]
        parent = session.get(WaterBody, expected["id"])
        # Reserved IDs may have been repurposed: never attach examples to real records.
        if parent is None or not parent.is_synthetic or parent.name != expected["name"] or parent.kind != expected["kind"]:
            continue
        result = session.scalar(insert(ObservationPoint).values(
            id=UUID(f"f432f7c0-4cec-4583-9537-{number:012}"), name=name,
            water_body_id=parent.id, position=WKTElement(position, srid=4326) if position else None,
            is_synthetic=True,
            coordinate_source="Вымышленные демонстрационные координаты; положение на водном объекте не подтверждено."
            if position else "Синтетическая точка; координаты не задавались.",
        ).on_conflict_do_nothing(index_elements=[ObservationPoint.id]).returning(ObservationPoint.id))
        inserted += int(result is not None)
    return inserted


if __name__ == "__main__":
    with Session(engine) as session, session.begin():
        count = seed_demo(session)
        points_count = seed_points(session)
    print(f"Добавлено синтетических объектов: {count}, точек: {points_count}. Реальные данные не загружались.")
