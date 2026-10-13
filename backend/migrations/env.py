from alembic import context

from app.db import engine
from app.models import Base


def include_name(name, type_, parent_names):
    # PostGIS owns additional tables; only compare tables managed by this app.
    if type_ == "table":
        return name in Base.metadata.tables
    return True


with engine.connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata, include_name=include_name)
    with context.begin_transaction():
        context.run_migrations()
