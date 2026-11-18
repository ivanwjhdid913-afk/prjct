"""Store independent immutable river network conditions."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None

def upgrade():
    op.create_table('network_scenarios', sa.Column('id', sa.Uuid(), primary_key=True), sa.Column('name', sa.String(120), nullable=False), sa.Column('model_id', sa.String(80), nullable=False), sa.Column('format_version', sa.Integer(), nullable=False), sa.Column('conditions', postgresql.JSONB(), nullable=False), sa.Column('network_snapshot', postgresql.JSONB(), nullable=False), sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False), sa.CheckConstraint('length(trim(name)) > 0', name='network_scenario_name'), sa.CheckConstraint('format_version = 1', name='network_scenario_version'), sa.CheckConstraint("model_id = 'conservative-1d-network-v1'", name='network_scenario_model'), sa.CheckConstraint("jsonb_typeof(conditions) = 'object' AND octet_length(conditions::text) <= 8192", name='network_scenario_conditions'), sa.CheckConstraint("jsonb_typeof(network_snapshot) = 'object' AND octet_length(network_snapshot::text) <= 131072", name='network_scenario_snapshot'))
    op.create_index('ix_network_scenarios_created_at', 'network_scenarios', ['created_at'])

def downgrade():
    connection = op.get_bind()
    connection.execute(sa.text('LOCK TABLE network_scenarios IN ACCESS EXCLUSIVE MODE'))
    if connection.scalar(sa.text('SELECT EXISTS (SELECT 1 FROM network_scenarios)')):
        raise RuntimeError('Export saved network scenarios before downgrading')
    op.drop_table('network_scenarios')
