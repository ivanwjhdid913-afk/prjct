"""Keep optional analysis metadata separate from immutable physical conditions."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('saved_scenarios', sa.Column('analysis_settings', postgresql.JSONB(none_as_null=True), nullable=True))
    op.create_check_constraint('saved_scenario_analysis_size', 'saved_scenarios',
                               "analysis_settings IS NULL OR (jsonb_typeof(analysis_settings) = 'object' "
                               "AND octet_length(analysis_settings::text) <= 4096)")


def downgrade():
    connection = op.get_bind()
    connection.execute(sa.text('LOCK TABLE saved_scenarios IN ACCESS EXCLUSIVE MODE'))
    if connection.scalar(sa.text('SELECT EXISTS (SELECT 1 FROM saved_scenarios '
                                 'WHERE format_version = 4 OR analysis_settings IS NOT NULL)')):
        raise RuntimeError('Cannot downgrade: saved analysis settings or format-4 scenarios exist. '
                           'Preserve or export these records first.')
    op.drop_constraint('saved_scenario_analysis_size', 'saved_scenarios', type_='check')
    op.drop_column('saved_scenarios', 'analysis_settings')
