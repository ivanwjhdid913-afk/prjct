"""Analysis metadata extends snapshots without changing physical inputs or model identity."""
import copy
import json
import subprocess
import sys

import pytest
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import engine
from app.scenarios import ScenarioCreate, persist
from app.scenario_files import ConditionsDocument
from test_multiple_source_storage import document as multiple_document, payload as physical_payload
from test_scenario_files import document as legacy_document


def analysis_settings():
    return dict(points=[dict(id='above', name='Выше второго источника', segment_index=35),
                        dict(id='below', name='Ниже второго источника', segment_index=49),
                        dict(id='end', name='Конец участка', segment_index=99)], threshold_mg_l=10.2)


def document():
    return multiple_document() | dict(format_version=4, analysis_settings=analysis_settings())


def payload(sent):
    return physical_payload(sent) | {'analysis_settings': sent['analysis_settings']}


def test_analysis_models_accept_format4_separate_from_unchanged_physical_conditions():
    sent = document()
    parsed = ScenarioCreate.model_validate(payload(sent))
    assert parsed.format_version == 4
    assert parsed.model_id == 'conservative-1d-lateral-inflow-v2'
    assert parsed.conditions.model_dump(mode='json') == sent['conditions']
    assert parsed.analysis_settings.model_dump(mode='json') == sent['analysis_settings']
    assert ConditionsDocument.model_validate(sent).model_dump(mode='json') == sent


@pytest.mark.anyio
async def test_format4_library_and_file_roundtrip_do_not_run_solver(client, monkeypatch):
    import app.multiple_simulation
    def forbidden(*args, **kwargs):
        raise AssertionError('Saving and validating analysis must not run the physical model')
    monkeypatch.setattr(app.multiple_simulation, 'simulate_multiple', forbidden)
    sent = document()
    original = copy.deepcopy(sent)
    checked = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert checked.status_code == 200, checked.text
    assert checked.json() == dict(document=sent, compatibility=dict(compatible=True, reasons=[]))
    saved = await client.post('/api/v1/scenarios', json=payload(sent))
    assert saved.status_code == 201, saved.text
    saved = saved.json()
    assert saved['format_version'] == 4 and saved['model_id'] == original['model_id']
    assert saved['conditions'] == original['conditions']
    assert saved['analysis_settings'] == original['analysis_settings']
    sent['analysis_settings']['points'][0]['name'] = 'Изменённый черновик'
    loaded = await client.get('/api/v1/scenarios/' + saved['id'])
    assert loaded.json() == saved


@pytest.mark.anyio
@pytest.mark.parametrize('threshold', [None, 0., 1e300])
async def test_threshold_null_zero_and_large_finite_value_are_distinct_valid_values(client, threshold):
    sent = document()
    sent['analysis_settings']['threshold_mg_l'] = threshold
    saved = await client.post('/api/v1/scenarios', json=payload(sent))
    assert saved.status_code == 201, saved.text
    assert saved.json()['analysis_settings']['threshold_mg_l'] == threshold


@pytest.mark.parametrize('settings', [
    None, {}, {'points': [], 'threshold_mg_l': -1}, {'points': [], 'threshold_mg_l': True},
    {'points': [], 'threshold_mg_l': '0'}, {'points': [], 'threshold_mg_l': float('inf')},
    {'points': [], 'threshold_mg_l': float('nan')},
    {'points': [], 'threshold_mg_l': None, 'hidden': 1},
    *[{'points': [dict(id='p', name='Точка', segment_index=value)], 'threshold_mg_l': None}
      for value in (-1, 100, 35.5, True, '35')],
    *[{'points': [dict(id='p', name=value, segment_index=0)], 'threshold_mg_l': None}
      for value in ('', ' ', 'я' * 81, 'Точка\x00', 'Точка\x85')],
    *[{'points': [dict(id=value, name='Точка', segment_index=0)], 'threshold_mg_l': None}
      for value in ('', 'я', 'x' * 65, 'a b')],
    {'points': [dict(id=f'p{i}', name='Точка', segment_index=i) for i in range(6)], 'threshold_mg_l': None},
    {'points': [dict(id='same', name='Точка', segment_index=i) for i in range(2)], 'threshold_mg_l': None},
    {'points': [dict(id=f'p{i}', name='Точка', segment_index=0) for i in range(2)], 'threshold_mg_l': None},
])
def test_analysis_settings_are_explicit_strict_and_bounded(settings):
    sent = document() | {'analysis_settings': settings}
    with pytest.raises(ValidationError):
        ScenarioCreate.model_validate(payload(sent))
    with pytest.raises(ValidationError):
        ConditionsDocument.model_validate(sent)


@pytest.mark.anyio
async def test_format4_requires_explicit_analysis_and_multiple_model(client):
    sent = document()
    sent.pop('analysis_settings')
    assert (await client.post('/api/v1/scenarios', json=physical_payload(sent))).status_code == 422
    assert (await client.post('/api/v1/scenario-files/validate', json=sent)).status_code == 422
    old = legacy_document() | dict(format_version=4, analysis_settings=analysis_settings())
    assert (await client.post('/api/v1/scenario-files/validate', json=old)).status_code == 422
    assert (await client.post('/api/v1/scenarios', json=payload(old))).status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize('version', [1, 2, 3])
async def test_old_formats_keep_their_model_and_export_omission(client, version):
    sent = multiple_document() if version == 3 else legacy_document()
    sent['format_version'] = version
    if version == 2:
        sent['conditions']['load_intervals'] = None
    checked = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert checked.status_code == 200, checked.text
    assert checked.json()['compatibility']['compatible']
    assert checked.json()['document'] == sent | {'name': sent['name'].strip()}
    assert 'analysis_settings' not in checked.json()['document']
    sent['analysis_settings'] = None
    checked = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert checked.status_code == 200, checked.text
    assert checked.json()['document']['analysis_settings'] is None
    sent['analysis_settings'] = analysis_settings()
    assert (await client.post('/api/v1/scenario-files/validate', json=sent)).status_code == 422


@pytest.mark.anyio
async def test_request_and_physical_size_limits_are_unchanged(client):
    sent = payload(document())
    encoded = json.dumps(sent, ensure_ascii=False).encode('utf-8')
    exact = encoded + b' ' * (8192 - len(encoded))
    headers = {'Content-Type': 'application/json'}
    assert (await client.post('/api/v1/scenarios', content=exact, headers=headers)).status_code == 201
    assert (await client.post('/api/v1/scenarios', content=exact + b' ', headers=headers)).status_code == 413


def test_0006_nullable_jsonb_bound_and_downgrade_guard_preserve_records():
    ids = []
    try:
        with Session(engine) as db:
            saved = persist(ScenarioCreate.model_validate(payload(document())), db)
            ids.append(str(saved.id))
        # Either condition independently prevents dropping data or format support.
        for version, settings in [(4, None), (3, analysis_settings()), (4, analysis_settings())]:
            with engine.begin() as connection:
                connection.execute(text('UPDATE saved_scenarios SET format_version=:version, '
                                        'analysis_settings=CAST(:settings AS jsonb) WHERE id=:id'),
                                   {'version': version, 'settings': json.dumps(settings) if settings is not None else None,
                                    'id': ids[0]})
            rejected = subprocess.run([sys.executable, '-m', 'alembic', 'downgrade', '0005'], text=True, capture_output=True)
            assert rejected.returncode != 0
            assert 'saved analysis settings or format-4 scenarios exist' in rejected.stderr
        with engine.connect() as connection:
            assert connection.scalar(text('SELECT version_num FROM alembic_version')) == '0006'
            stored = connection.scalar(text('SELECT analysis_settings FROM saved_scenarios WHERE id=:id'), {'id': ids[0]})
            assert stored == analysis_settings()
            assert connection.scalar(text("SELECT is_nullable FROM information_schema.columns WHERE table_name='saved_scenarios' AND column_name='analysis_settings'")) == 'YES'
            constraint = connection.scalar(text("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='saved_scenario_analysis_size'"))
            assert '4096' in constraint and 'octet_length' in constraint
        for invalid in [{'oversized': 'я' * 2048}, []]:
            with pytest.raises(IntegrityError), engine.begin() as connection:
                connection.execute(text('UPDATE saved_scenarios SET analysis_settings=CAST(:settings AS jsonb) WHERE id=:id'),
                                   {'settings': json.dumps(invalid, ensure_ascii=False), 'id': ids[0]})
        with engine.begin() as connection:
            connection.execute(text('DELETE FROM saved_scenarios WHERE id=:id'), {'id': ids[0]})
        ids.clear()
        subprocess.run([sys.executable, '-m', 'alembic', 'downgrade', '0005'], check=True)
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', 'head'], check=True)
    finally:
        with engine.begin() as connection:
            for identity in ids:
                connection.execute(text('DELETE FROM saved_scenarios WHERE id=:id'), {'id': identity})
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', 'head'], check=True)
