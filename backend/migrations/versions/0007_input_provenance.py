"""Store the optional source passport on format-five snapshots."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('saved_scenarios', sa.Column('input_provenance', postgresql.JSONB(none_as_null=True), nullable=True))
    op.create_check_constraint('saved_scenario_input_provenance', 'saved_scenarios',
                               "(format_version <> 5 AND input_provenance IS NULL) OR "
                               "(format_version = 5 AND input_provenance IS NOT NULL "
                               "AND jsonb_typeof(input_provenance) = 'object' "
                               "AND octet_length(input_provenance::text) <= 4096)")


def downgrade():
    connection = op.get_bind()
    connection.execute(sa.text('LOCK TABLE saved_scenarios IN ACCESS EXCLUSIVE MODE'))
    if connection.scalar(sa.text('SELECT EXISTS (SELECT 1 FROM saved_scenarios '
                                 'WHERE format_version = 5 OR input_provenance IS NOT NULL)')):
        raise RuntimeError('Cannot downgrade: saved input provenance or format-5 scenarios exist. '
                           'Preserve or export these records first.')
    op.drop_constraint('saved_scenario_input_provenance', 'saved_scenarios', type_='check')
    op.drop_column('saved_scenarios', 'input_provenance')
