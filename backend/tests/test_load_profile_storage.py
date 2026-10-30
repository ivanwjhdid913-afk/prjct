"""Profiles survive immutable storage and portable-file validation."""
import copy
import json
import subprocess
import sys

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import engine
from app.scenarios import ScenarioCreate, persist
from app.scenario_versions import FORMAT_VERSION, MODEL_ID


def conditions(profile=False):
    value = dict(river_flow_m3_s=10., effluent_flow_m3_s=.1, background_mg_l=10.,
                 effluent_mg_l=100., velocity_m_s=.25, dispersion_m2_s=5., duration_hours=4.,
                 length_m=500., reach_id=None, source_distance_m=0., load_mode='continuous',
                 load_duration_hours=None)
    if profile:
        value.update(load_mode='profile', load_intervals=[
            dict(start_hours=.25, end_hours=1., effluent_mg_l=110.123456789),
            dict(start_hours=1., end_hours=2., effluent_mg_l=2.)])
    return value


def document(version=2, profile=True):
    return dict(name='График', format_version=version, model_id=MODEL_ID, geometry_mode='synthetic',
                geometry_version='synthetic-wgs84-meridian-v1', geometry_sha256=None,
                downstream_geometry_sha256=None, reach_id=None, reach_name='Синтетический участок',
                geometry_source={}, conditions=conditions(profile))


@pytest.mark.anyio
async def test_v1_without_intervals_roundtrips_unchanged(client):
    sent = document(1, False)
    response = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert response.status_code == 200, response.text
    assert response.json()['document'] == sent
    assert response.json()['compatibility']['compatible']


@pytest.mark.anyio
async def test_new_profile_library_and_file_snapshot(client, session):
    assert FORMAT_VERSION == 2
    sent = document()
    payload = {key: sent[key] for key in ('name', 'format_version', 'model_id', 'geometry_version', 'geometry_sha256', 'conditions')}
    response = await client.post('/api/v1/scenarios', json=payload)
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved['load_mode'] == 'profile' and saved['compatibility']['compatible']
    assert saved['conditions'] == sent['conditions']
    fetched = (await client.get('/api/v1/scenarios/' + saved['id'])).json()
    assert fetched['conditions'] == sent['conditions']
    validated = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert validated.status_code == 200, validated.text
    assert validated.json()['document'] == sent
    assert (await client.get('/api/v1/scenarios')).json()['items'][0]['load_mode'] == 'profile'
    assert session.scalar(text('SELECT octet_length(conditions::text) FROM saved_scenarios WHERE id=:id'), {'id': saved['id']}) < 4096


@pytest.mark.anyio
async def test_v2_explicit_field_and_v1_profile_guards(client):
    for sent in [document(2, False), document(1, True)]:
        response = await client.post('/api/v1/scenario-files/validate', json=sent)
        assert response.status_code == 422, response.text
    sent = document(2, False)
    sent['conditions']['load_intervals'] = None
    assert (await client.post('/api/v1/scenario-files/validate', json=sent)).status_code == 200


@pytest.mark.anyio
async def test_twelve_intervals_fit_limits_and_do_not_mutate_profile(client):
    sent = document()
    sent['conditions']['load_intervals'] = [dict(start_hours=i / 4, end_hours=(i + 1) / 4, effluent_mg_l=100. + i) for i in range(12)]
    original = copy.deepcopy(sent)
    assert len(json.dumps(sent).encode()) < 8192
    response = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert response.status_code == 200, response.text
    assert response.json()['document']['conditions'] == original['conditions']
    payload = {key: sent[key] for key in ('name', 'format_version', 'model_id', 'geometry_version', 'geometry_sha256', 'conditions')}
    response = await client.post('/api/v1/scenarios', json=payload)
    assert response.status_code == 201, response.text
    saved = response.json()
    sent['conditions']['load_intervals'][0]['effluent_mg_l'] = 999.
    fetched = (await client.get('/api/v1/scenarios/' + saved['id'])).json()
    assert fetched['conditions'] == original['conditions']


@pytest.mark.anyio
@pytest.mark.parametrize('version', [1, 2])
@pytest.mark.parametrize('mode', ['continuous', 'finite'])
async def test_legacy_modes_keep_versioned_library_snapshot(client, version, mode):
    sent = document(version, False)
    sent['conditions'].update(load_mode=mode, load_duration_hours=1. if mode == 'finite' else None)
    if version == 2:
        sent['conditions']['load_intervals'] = None
    payload = {key: sent[key] for key in ('name', 'format_version', 'model_id', 'geometry_version', 'geometry_sha256', 'conditions')}
    response = await client.post('/api/v1/scenarios', json=payload)
    assert response.status_code == 201, response.text
    assert response.json()['conditions'] == sent['conditions']
    assert response.json()['format_version'] == version


@pytest.mark.anyio
async def test_unknown_format_legacy_preview_remains_readable_and_incompatible(client):
    sent = document(3, False)
    response = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert response.status_code == 200, response.text
    assert response.json()['document'] == sent
    assert not response.json()['compatibility']['compatible']
    assert any('формата' in reason for reason in response.json()['compatibility']['reasons'])


def test_0004_preserves_legacy_rows_and_blocks_destructive_profile_downgrade():
    # The global conftest permits this only inside run_tests.py's disposable DB.
    ids = []
    try:
        with Session(engine) as db:
            sent = document(1, False)
            payload = {key: sent[key] for key in ('name', 'format_version', 'model_id', 'geometry_version', 'geometry_sha256', 'conditions')}
            legacy = persist(ScenarioCreate.model_validate(payload), db)
            ids.append(str(legacy.id))
        subprocess.run([sys.executable, '-m', 'alembic', 'downgrade', '0003'], check=True)
        with engine.connect() as connection:
            assert connection.scalar(text('SELECT conditions FROM saved_scenarios WHERE id=:id'), {'id': ids[0]}) == sent['conditions']
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', 'head'], check=True)
        with Session(engine) as db:
            sent = document()
            payload = {key: sent[key] for key in ('name', 'format_version', 'model_id', 'geometry_version', 'geometry_sha256', 'conditions')}
            profile = persist(ScenarioCreate.model_validate(payload), db)
            ids.append(str(profile.id))
        downgrade = subprocess.run([sys.executable, '-m', 'alembic', 'downgrade', '0003'], text=True, capture_output=True)
        assert downgrade.returncode != 0
        assert 'saved load profiles exist' in downgrade.stderr
        with engine.connect() as connection:
            assert connection.scalar(text('SELECT version_num FROM alembic_version')) == '0004'
            assert connection.scalar(text('SELECT conditions FROM saved_scenarios WHERE id=:id'), {'id': ids[1]}) == sent['conditions']
            assert connection.scalar(text('SELECT count(*) FROM saved_scenarios')) == 2
    finally:
        with engine.begin() as connection:
            for scenario_id in ids:
                connection.execute(text('DELETE FROM saved_scenarios WHERE id=:id'), {'id': scenario_id})
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', 'head'], check=True)
