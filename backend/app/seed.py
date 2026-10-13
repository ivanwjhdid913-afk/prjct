"""Explicit, repeatable loading of fictional demonstration records."""

from uuid import UUID

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db import engine
from app.models import WaterBody

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


if __name__ == "__main__":
    with Session(engine) as session, session.begin():
        count = seed_demo(session)
    print(f"Добавлено синтетических объектов: {count}. Реальные данные не загружались.")
