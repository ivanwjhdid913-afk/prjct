"""Provenance is a condition snapshot, bound to the values and prepared geometry."""
from copy import deepcopy
import json
import subprocess
import sys

import pytest
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import engine
from app.river import prepared_reach
from app.scenario_files import ConditionsDocument
from app.scenarios import ScenarioCreate, conditions_compatibility, persist


def document():
    reach, line = prepared_reach('don-olkhovets')
    source = {
        'id': 'discharge', 'name': 'Сценарный источник', 'source_distance_m': line.distances[1],
        'effluent_flow_m3_s': .1, 'effluent_mg_l': 100., 'load_mode': 'continuous',
        'load_duration_hours': None, 'load_intervals': None,
    }
    river = {'river_flow_m3_s': 10., 'background_mg_l': 10., 'velocity_m_s': .25, 'dispersion_m2_s': 5., 'duration_hours': 2.5}
    fields = {key: {'basis': 'synthetic', 'source': 'Учебное допущение', 'value': value}
              for key, value in (river | {key: source[key] for key in ('source_distance_m', 'effluent_flow_m3_s', 'effluent_mg_l', 'load_mode')}).items()}
    for key, value in {'receiver': 'Дон', 'discharge_coordinates': line.point_at(source['source_distance_m']),
                       'source_distance_m': source['source_distance_m']}.items():
        fields[key] = {'basis': 'prepared_geometry', 'source': 'Подготовленная линия Дона', 'value': value}
    return {
        'name': 'Учебный сброс', 'format_version': 5, 'model_id': 'conservative-1d-lateral-inflow-v2',
        'geometry_mode': 'river', 'geometry_version': 'river-wgs84-v1', 'geometry_sha256': reach['metadata']['geometry_sha256'],
        'downstream_geometry_sha256': reach['metadata']['downstream_geometry_sha256'], 'reach_id': reach['id'],
        'reach_name': reach['name'], 'geometry_source': {}, 'conditions': river | {'reach_id': reach['id'], 'sources': [source]},
        'analysis_settings': {'points': [], 'threshold_mg_l': None},
        'input_provenance': {'schema_version': 1, 'passport_id': 'don-discharge-example', 'kind': 'synthetic', 'fields': fields},
    }


def save_payload(sent):
    return {key: value for key, value in sent.items() if key not in {'geometry_mode', 'reach_id', 'reach_name', 'geometry_source'}}


def compatible(document):
    return conditions_compatibility(**document.model_dump(exclude={'name', 'reach_name', 'geometry_source'}))


def test_format_five_shape_roundtrips_complete_provenance():
    sent = document()
    transfer = ConditionsDocument.model_validate(sent)
    assert transfer.model_dump(mode='json') == sent
    assert compatible(transfer).compatible
    record = ScenarioCreate.model_validate(save_payload(sent))
    assert record.model_dump(mode='json')['input_provenance'] == sent['input_provenance']


@pytest.mark.parametrize('change', [
    lambda sent: sent.pop('input_provenance'),
    lambda sent: sent.pop('analysis_settings'),
    lambda sent: sent['input_provenance'].update(schema_version=True),
    lambda sent: sent['input_provenance'].update(passport_id='Unverified/Id'),
    lambda sent: sent['input_provenance'].update(kind='measured'),
    lambda sent: sent['input_provenance']['fields'].pop('receiver'),
    lambda sent: sent['input_provenance']['fields'].update(extra={}),
    lambda sent: sent['input_provenance']['fields']['receiver'].update(source='\n'),
    lambda sent: sent['input_provenance']['fields']['receiver'].update(source='т' * 241),
    lambda sent: sent['input_provenance']['fields']['background_mg_l'].update(value=10.000001),
    lambda sent: sent['input_provenance']['fields']['duration_hours'].update(value='2.5'),
    lambda sent: sent['input_provenance']['fields']['velocity_m_s'].update(value=True),
    lambda sent: sent['input_provenance']['fields']['discharge_coordinates'].update(value=[-181, 52]),
    lambda sent: sent['conditions']['sources'][0].update(load_mode='finite', load_duration_hours=.1),
    lambda sent: sent['conditions']['sources'].append(deepcopy(sent['conditions']['sources'][0]) | {'id': 'second'}),
    lambda sent: sent.update(format_version=4),
])
def test_strict_field_shape_and_canonical_input_binding(change):
    sent = document()
    change(sent)
    with pytest.raises(ValidationError):
        ConditionsDocument.model_validate(sent)
    with pytest.raises(ValidationError):
        ScenarioCreate.model_validate(save_payload(sent))


def test_portable_mismatch_preserves_document_but_blocks_application():
    for field in ('geometry_sha256', 'downstream_geometry_sha256', 'coordinates'):
        sent = document()
        if field == 'coordinates':
            sent['input_provenance']['fields']['discharge_coordinates']['value'][0] += .0001
        else:
            sent[field] = '0' * 64
        transfer = ConditionsDocument.model_validate(sent)
        assert transfer.model_dump(mode='json') == sent
        assert not compatible(transfer).compatible


def test_utf8_size_is_checked_across_provenance_fields():
    sent = document()
    for field in sent['input_provenance']['fields'].values():
        field['source'] = 'Я' * 240
    with pytest.raises(ValidationError, match='4096 байт'):
        ConditionsDocument.model_validate(sent)


@pytest.mark.anyio
async def test_saved_record_has_full_provenance_and_rejects_mismatched_geometry(client):
    sent = document()
    for key in ('geometry_sha256', 'downstream_geometry_sha256', 'coordinates'):
        changed = save_payload(deepcopy(sent))
        if key == 'coordinates':
            changed['input_provenance']['fields']['discharge_coordinates']['value'][0] += .0001
        else:
            changed[key] = '0' * 64
        assert (await client.post('/api/v1/scenarios', json=changed)).status_code == 422
    missing_hash = save_payload(sent)
    missing_hash.pop('downstream_geometry_sha256')
    assert (await client.post('/api/v1/scenarios', json=missing_hash)).status_code == 422
    response = await client.post('/api/v1/scenarios', json=save_payload(sent))
    assert response.status_code == 201, response.text
    record = response.json()
    assert record['input_provenance'] == sent['input_provenance']
    assert record['compatibility']['compatible']
    assert 'input_provenance' not in record['conditions']
    assert (await client.get('/api/v1/scenarios/' + record['id'])).json() == record
    checked = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert checked.status_code == 200 and checked.json()['compatibility']['compatible']
    stale_file = sent | {'downstream_geometry_sha256': '0' * 64}
    blocked = await client.post('/api/v1/scenario-files/validate', json=stale_file)
    assert blocked.status_code == 200 and not blocked.json()['compatibility']['compatible']
    assert blocked.json()['document'] == stale_file
    legacy = save_payload(sent) | {'format_version': 4}
    legacy.pop('input_provenance')
    legacy.pop('downstream_geometry_sha256')
    older = await client.post('/api/v1/scenarios', json=legacy)
    assert older.status_code == 201 and 'input_provenance' not in older.json()


def test_migration_0007_enforces_shape_version_and_size_and_prevents_loss():
    identities = []
    try:
        sent = document()
        legacy = save_payload(sent) | {'format_version': 4}
        legacy.pop('input_provenance')
        legacy.pop('downstream_geometry_sha256')
        with Session(engine) as session:
            identity = persist(ScenarioCreate.model_validate(save_payload(sent)), session).id
            identities.append(identity)
            older_id = persist(ScenarioCreate.model_validate(legacy), session).id
            identities.append(older_id)
        for row_id, value in [(identity, None), (identity, []), (identity, {'oversized': 'я' * 2048}),
                              (older_id, sent['input_provenance'])]:
            with pytest.raises(IntegrityError), engine.begin() as connection:
                connection.execute(text('UPDATE saved_scenarios SET input_provenance=CAST(:value AS jsonb) WHERE id=:id'),
                                   {'id': row_id, 'value': None if value is None else json.dumps(value, ensure_ascii=False)})
        downgrade = [sys.executable, '-m', 'alembic', 'downgrade', '0006']
        rejected = subprocess.run(downgrade, text=True, capture_output=True)
        assert rejected.returncode != 0
        assert 'saved input provenance or format-5 scenarios exist' in rejected.stderr
        with engine.begin() as connection:
            assert connection.scalar(text('SELECT input_provenance FROM saved_scenarios WHERE id=:id'), {'id': identity}) == sent['input_provenance']
            connection.execute(text('DELETE FROM saved_scenarios WHERE id=:id'), {'id': identity})
        subprocess.run(downgrade, check=True)
        with engine.connect() as connection:
            assert connection.scalar(text('SELECT format_version FROM saved_scenarios WHERE id=:id'), {'id': older_id}) == 4
    finally:
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', 'head'], check=True)
        with engine.begin() as connection:
            for identity in identities:
                connection.execute(text('DELETE FROM saved_scenarios WHERE id=:id'), {'id': identity})
