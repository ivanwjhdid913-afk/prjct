"""Persist immutable, versioned scenario conditions without calculation results."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'saved_scenarios',
        sa.Column('id', sa.Uuid(), primary_key=True),
        sa.Column('name', sa.String(120), nullable=False),
        sa.Column('format_version', sa.Integer(), nullable=False),
        sa.Column('model_id', sa.String(80), nullable=False),
        sa.Column('geometry_mode', sa.String(16), nullable=False),
        sa.Column('geometry_version', sa.String(64), nullable=False),
        sa.Column('geometry_sha256', sa.String(64), nullable=True),
        sa.Column('downstream_geometry_sha256', sa.String(64), nullable=True),
        sa.Column('reach_id', sa.String(80), nullable=True),
        sa.Column('reach_name', sa.String(200), nullable=False),
        sa.Column('load_mode', sa.String(16), nullable=False),
        sa.Column('conditions', JSONB(), nullable=False),
        sa.Column('geometry_source', JSONB(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint('length(trim(name)) BETWEEN 1 AND 120', name='saved_scenario_name'),
        sa.CheckConstraint("geometry_mode IN ('river', 'synthetic')", name='saved_scenario_geometry_mode'),
        sa.CheckConstraint("load_mode IN ('continuous', 'finite')", name='saved_scenario_load_mode'),
        sa.CheckConstraint('format_version > 0', name='saved_scenario_format'),
        sa.CheckConstraint("jsonb_typeof(conditions) = 'object' AND octet_length(conditions::text) <= 4096",
                           name='saved_scenario_conditions_size'),
        sa.CheckConstraint("jsonb_typeof(geometry_source) = 'object' AND octet_length(geometry_source::text) <= 2048",
                           name='saved_scenario_source_size'),
    )
    op.create_index('ix_saved_scenarios_created_at', 'saved_scenarios', ['created_at'])


def downgrade():
    op.drop_table('saved_scenarios')
