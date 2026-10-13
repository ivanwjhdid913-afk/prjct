"""Run integration tests in a newly created, disposable PostgreSQL database."""

import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

from sqlalchemy import create_engine, text

from app.db import database_url


def main():
    name = f"water_test_{uuid4().hex}"
    admin = create_engine(database_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
    env = {**os.environ, "POSTGRES_DB": name, "WATER_TEST_DB": name}
    created = False
    try:
        with admin.connect() as connection:
            connection.execute(text(f'CREATE DATABASE "{name}"'))
        created = True
        root = Path(__file__).parent
        for command in ([sys.executable, "-m", "alembic", "upgrade", "head"],
                        [sys.executable, "-m", "pytest", *sys.argv[1:]]):
            result = subprocess.run(command, cwd=root, env=env, check=False)
            if result.returncode:
                return result.returncode
        return 0
    finally:
        if created:
            with admin.connect() as connection:
                connection.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
