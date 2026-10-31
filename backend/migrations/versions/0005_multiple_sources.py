"""Permit explicit multi-source condition snapshots without rewriting legacy records."""
from alembic import op
import sqlalchemy as sa

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint('saved_scenario_load_mode', 'saved_scenarios', type_='check')
    op.create_check_constraint('saved_scenario_load_mode', 'saved_scenarios',
                               "load_mode IN ('continuous', 'finite', 'profile', 'multiple')")


def downgrade():
    connection = op.get_bind()
    connection.execute(sa.text('LOCK TABLE saved_scenarios IN ACCESS EXCLUSIVE MODE'))
    if connection.scalar(sa.text("SELECT EXISTS (SELECT 1 FROM saved_scenarios WHERE load_mode = 'multiple')")):
        raise RuntimeError('Cannot downgrade: saved multiple-source scenarios exist. Preserve or export these records first.')
    op.drop_constraint('saved_scenario_load_mode', 'saved_scenarios', type_='check')
    op.create_check_constraint('saved_scenario_load_mode', 'saved_scenarios',
                               "load_mode IN ('continuous', 'finite', 'profile')")
