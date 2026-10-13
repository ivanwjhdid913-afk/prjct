"""Create the water-body register and enable PostGIS."""

from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.create_table(
        "water_bodies",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("is_synthetic", sa.Boolean(), nullable=False),
        sa.CheckConstraint("kind IN ('river', 'lake', 'reservoir')", name="water_body_kind"),
        sa.CheckConstraint("length(trim(name)) > 0", name="water_body_name"),
    )


def downgrade():
    op.drop_table("water_bodies")
    # PostGIS may be shared with other tables; keep the extension.
