from datetime import datetime
from uuid import UUID, uuid4

from geoalchemy2 import Geometry, WKBElement
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
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


class SavedScenario(Base):
    """Immutable input snapshots; geometry catalog entries intentionally have no FK."""
    __tablename__ = 'saved_scenarios'
    __table_args__ = (
        CheckConstraint('length(trim(name)) BETWEEN 1 AND 120', name='saved_scenario_name'),
        CheckConstraint("geometry_mode IN ('river', 'synthetic')", name='saved_scenario_geometry_mode'),
        CheckConstraint("load_mode IN ('continuous', 'finite')", name='saved_scenario_load_mode'),
        CheckConstraint('format_version > 0', name='saved_scenario_format'),
        CheckConstraint("jsonb_typeof(conditions) = 'object' AND octet_length(conditions::text) <= 4096",
                        name='saved_scenario_conditions_size'),
        CheckConstraint("jsonb_typeof(geometry_source) = 'object' AND octet_length(geometry_source::text) <= 2048",
                        name='saved_scenario_source_size'),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(120))
    format_version: Mapped[int] = mapped_column(Integer)
    model_id: Mapped[str] = mapped_column(String(80))
    geometry_mode: Mapped[str] = mapped_column(String(16))
    geometry_version: Mapped[str] = mapped_column(String(64))
    geometry_sha256: Mapped[str | None] = mapped_column(String(64))
    downstream_geometry_sha256: Mapped[str | None] = mapped_column(String(64))
    reach_id: Mapped[str | None] = mapped_column(String(80))
    reach_name: Mapped[str] = mapped_column(String(200))
    load_mode: Mapped[str] = mapped_column(String(16))
    conditions: Mapped[dict] = mapped_column(JSONB)
    geometry_source: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
