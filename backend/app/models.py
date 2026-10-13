from uuid import UUID, uuid4

from sqlalchemy import Boolean, CheckConstraint, String
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
