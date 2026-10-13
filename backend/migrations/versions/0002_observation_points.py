"""Add observation points with one optional WGS 84 geometry."""

from alembic import op
from geoalchemy2 import Geometry
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "observation_points",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("water_body_id", sa.Uuid(), sa.ForeignKey("water_bodies.id"), nullable=False),
        sa.Column("position", Geometry("POINT", srid=4326, spatial_index=False), nullable=True),
        sa.Column("is_synthetic", sa.Boolean(), nullable=False),
        sa.Column("coordinate_source", sa.String(500), nullable=False),
        sa.CheckConstraint("length(trim(name)) > 0", name="observation_point_name"),
        sa.CheckConstraint("length(trim(coordinate_source)) > 0", name="observation_point_source"),
        sa.CheckConstraint("position IS NULL OR (NOT ST_IsEmpty(position) AND "
                           "ST_X(position) BETWEEN -180 AND 180 AND ST_Y(position) BETWEEN -90 AND 90)",
                           name="observation_point_coordinates"),
    )
    op.create_index("ix_observation_points_water_body_id", "observation_points", ["water_body_id"])


def downgrade():
    op.drop_table("observation_points")
