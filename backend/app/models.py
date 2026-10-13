from uuid import UUID, uuid4

from geoalchemy2 import Geometry, WKBElement
from sqlalchemy import Boolean, CheckConstraint, ForeignKey, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class WaterBody(Base):
    __tablename__ = "water_bodies"
    __table_args__ = (
        CheckConstraint("kind IN ('river', 'lake', 'reservoir')", name="water_body_kind"),
        CheckConstraint("length(trim(name)) > 0", name="water_body_name"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(16))
    is_synthetic: Mapped[bool] = mapped_column(Boolean)


class ObservationPoint(Base):
    __tablename__ = "observation_points"
    __table_args__ = (
        CheckConstraint("length(trim(name)) > 0", name="observation_point_name"),
        CheckConstraint("length(trim(coordinate_source)) > 0", name="observation_point_source"),
        CheckConstraint("position IS NULL OR (NOT ST_IsEmpty(position) AND "
                        "ST_X(position) BETWEEN -180 AND 180 AND ST_Y(position) BETWEEN -90 AND 90)",
                        name="observation_point_coordinates"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(200))
    water_body_id: Mapped[UUID] = mapped_column(ForeignKey("water_bodies.id"), index=True)
    position: Mapped[WKBElement | None] = mapped_column(Geometry("POINT", srid=4326, spatial_index=False))
    is_synthetic: Mapped[bool] = mapped_column(Boolean)
    coordinate_source: Mapped[str] = mapped_column(String(500))
