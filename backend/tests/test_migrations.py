import subprocess
import sys
from uuid import uuid4

from sqlalchemy import text

from app.db import engine


def test_0002_downgrade_and_upgrade_preserve_water_bodies():
    # conftest permits only the disposable database created by run_tests.py.
    body_id = uuid4()
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO water_bodies (id,name,kind,is_synthetic) VALUES (:id,'Миграционный пример','lake',true)"), {"id": body_id})
    try:
        subprocess.run([sys.executable, "-m", "alembic", "downgrade", "0001"], check=True)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT to_regclass('observation_points')")) is None
            assert connection.scalar(text("SELECT name FROM water_bodies WHERE id=:id"), {"id": body_id}) == "Миграционный пример"
        subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT count(*) FROM observation_points")) == 0
            assert connection.scalar(text("SELECT name FROM water_bodies WHERE id=:id"), {"id": body_id}) == "Миграционный пример"
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM water_bodies WHERE id=:id"), {"id": body_id})


def test_0003_upgrade_preserves_catalog_and_observation_points():
    body_id, point_id = uuid4(), uuid4()
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO water_bodies (id,name,kind,is_synthetic) VALUES (:id,'Проверка сохранности','river',true)"), {'id': body_id})
        connection.execute(text("INSERT INTO observation_points (id,name,water_body_id,position,is_synthetic,coordinate_source) VALUES (:id,'Контрольная точка',:body,NULL,true,'Тест миграции')"), {'id': point_id, 'body': body_id})
    try:
        subprocess.run([sys.executable, '-m', 'alembic', 'downgrade', '0002'], check=True)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT to_regclass('saved_scenarios')")) is None
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', 'head'], check=True)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT name FROM water_bodies WHERE id=:id"), {'id': body_id}) == 'Проверка сохранности'
            assert connection.scalar(text("SELECT name FROM observation_points WHERE id=:id"), {'id': point_id}) == 'Контрольная точка'
            assert connection.scalar(text('SELECT count(*) FROM saved_scenarios')) == 0
    finally:
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', 'head'], check=True)
        with engine.begin() as connection:
            connection.execute(text('DELETE FROM observation_points WHERE id=:id'), {'id': point_id})
            connection.execute(text('DELETE FROM water_bodies WHERE id=:id'), {'id': body_id})
