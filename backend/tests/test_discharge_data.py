"""Contract checks for source evidence, without applying it to any model."""
from copy import deepcopy
import json

import httpx
import pytest
from pydantic import ValidationError

from app.discharge_data import Catalog, DATA_PATH, load_catalog
from app.main import app
from app.db import get_session


MATRIX_KEYS = (
    'outfall_position', 'channel', 'river_flow', 'effluent_flow', 'background',
    'substance_load', 'time_regime', 'velocity_dispersion', 'observations',
)


@pytest.fixture
def valid_catalog():
    return {
        'format_version': 1, 'checked_on': '2026-10-30',
        'sources': [{
            'id': 'source', 'title': 'Test document', 'publisher': 'Test publisher',
            'url': 'https://example.org/document', 'published_on': None,
            'publication_note': 'Publication day not stated.', 'checked_on': '2026-10-30',
            'document_id': 'document-1', 'sha256': None,
            'acquisition': 'Open the document URL.', 'redistribution': 'Link only.',
        }],
        'items': [{
            'id': 'object', 'name': 'Test facility', 'kind': 'Treatment works',
            'location_description': 'Test location', 'receiver': None,
            'receiver_note': 'Receiver not established.',
            'discharge_summary': 'No confirmed outfall.', 'coordinates': None,
            'evidence': [{
                'source_id': 'source', 'locator': 'p. 1', 'statement': 'Test evidence.',
                'period': '2022', 'quantity': None, 'conversion': None,
            }],
            'missing': ['Outfall position'], 'readiness': 'insufficient',
            'readiness_reason': 'Outfall and flow missing.',
            'prepared_reach': {'status': 'not_established', 'reach_id': None,
                               'explanation': 'No verified outfall position.'},
            'matrix': {key: {'status': 'missing', 'note': 'Not reported.', 'source_ids': []}
                       for key in MATRIX_KEYS},
        }],
    }


def test_explicit_unknown_values_remain_null(valid_catalog):
    catalog = Catalog.model_validate(valid_catalog)
    assert catalog.items[0].coordinates is None
    assert catalog.items[0].evidence[0].quantity is None
    assert catalog.sources[0].published_on is None


@pytest.mark.parametrize('change', [
    lambda d: d.update(format_version=True),
    lambda d: d.update(format_version=2),
    lambda d: d.update(checked_on='2026-02-30'),
    lambda d: d.update(checked_on='30.10.2026'),
    lambda d: d.update(extra='unrecognised'),
    lambda d: d['sources'][0].update(url='javascript:alert(1)'),
    lambda d: d['sources'][0].update(url='https://user:secret@example.org/'),
    lambda d: d['sources'][0].update(url='https://example.org/\nattack'),
    lambda d: d['sources'][0].update(sha256='wrong'),
    lambda d: d['sources'][0].update(publication_note='  '),
    lambda d: d['sources'][0].update(published_on='2027-01-01'),
    lambda d: d['sources'][0].update(checked_on='2026-10-31'),
    lambda d: d['sources'].append(deepcopy(d['sources'][0])),
    lambda d: d['items'].append(deepcopy(d['items'][0])),
    lambda d: d['items'][0]['evidence'][0].update(source_id='absent'),
    lambda d: d['items'][0]['evidence'][0].update(period='unknown'),
    lambda d: d['items'][0]['evidence'][0].update(period='2023–2022'),
    lambda d: d['items'][0]['evidence'][0].update(period='2022-12-01–2022-01-01'),
    lambda d: d['items'][0]['evidence'][0].update(period='2023 - 2022'),
    lambda d: d['items'][0]['evidence'][0].update(period='2026-12'),
    lambda d: d['items'][0]['evidence'][0].update(period='2026-10-31'),
    lambda d: d['items'][0]['matrix']['channel'].update(source_ids=['absent']),
    lambda d: d['items'][0]['matrix']['channel'].update(source_ids=['source', 'source']),
    lambda d: d['items'][0]['matrix'].pop('background'),
    lambda d: d['items'][0]['matrix'].update(unexpected={'status': 'missing', 'note': 'N', 'source_ids': []}),
    lambda d: d['items'][0]['matrix']['river_flow'].update(status='available'),
    lambda d: d['items'][0].update(readiness='ready'),
    lambda d: d['items'][0]['prepared_reach'].update(status='matched', reach_id='voronezh-zheltye-peski'),
    lambda d: d['items'][0]['prepared_reach'].update(reach_id='don-olkhovets'),
])
def test_rejects_invalid_or_inconsistent_catalog(valid_catalog, change):
    change(valid_catalog)
    with pytest.raises(ValidationError):
        Catalog.model_validate(valid_catalog)


@pytest.mark.parametrize('value', [float('inf'), float('nan'), -1, True, '127'])
def test_quantities_must_be_explicit_finite_nonnegative_numbers(valid_catalog, value):
    valid_catalog['items'][0]['evidence'][0]['quantity'] = {
        'parameter': 'Chloride', 'value': value, 'unit': 'мг/дм³',
        'basis': 'actual', 'scope': 'Monthly outlet concentration',
    }
    with pytest.raises(ValidationError):
        Catalog.model_validate(valid_catalog)


@pytest.mark.parametrize('field,value', [('unit', ''), ('basis', 'estimated'), ('scope', '')])
def test_quantities_require_units_basis_and_scope(valid_catalog, field, value):
    quantity = {'parameter': 'Chloride', 'value': 127, 'unit': 'мг/дм³',
                'basis': 'actual', 'scope': 'Monthly outlet concentration'}
    quantity[field] = value
    valid_catalog['items'][0]['evidence'][0]['quantity'] = quantity
    with pytest.raises(ValidationError):
        Catalog.model_validate(valid_catalog)


@pytest.mark.parametrize('field,value', [('longitude', 181), ('latitude', -91),
                                       ('longitude', float('nan')), ('kind', 'approximate')])
def test_coordinate_bounds_and_meaning(valid_catalog, field, value):
    coordinate = {'longitude': 39.6, 'latitude': 52.6, 'crs': 'EPSG:4326',
                  'kind': 'enterprise', 'description': 'Facility address only.',
                  'source_id': 'source', 'locator': 'p. 1'}
    coordinate[field] = value
    valid_catalog['items'][0]['coordinates'] = coordinate
    with pytest.raises(ValidationError):
        Catalog.model_validate(valid_catalog)


def test_enterprise_coordinate_does_not_establish_outfall_or_reach(valid_catalog):
    valid_catalog['items'][0]['coordinates'] = {
        'longitude': 39.6, 'latitude': 52.6, 'crs': 'EPSG:4326', 'kind': 'enterprise',
        'description': 'Facility address only.', 'source_id': 'source', 'locator': 'p. 1',
    }
    catalog = Catalog.model_validate(valid_catalog)
    assert catalog.items[0].coordinates.kind == 'enterprise'
    valid_catalog['items'][0]['prepared_reach'].update(status='matched', reach_id='voronezh-zheltye-peski')
    with pytest.raises(ValidationError):
        Catalog.model_validate(valid_catalog)


def test_checked_in_catalog_has_traceable_research_and_no_automatic_scenario():
    raw = json.loads(DATA_PATH.read_text(encoding='utf-8'))
    catalog = load_catalog()
    assert 3 <= len(catalog.items) <= 5
    assert catalog.model_dump(mode='json') == raw
    for source in catalog.sources:
        assert source.document_id and source.acquisition and source.redistribution
    for item in catalog.items:
        assert item.evidence and item.missing and item.readiness_reason
        assert item.readiness == 'insufficient'
        assert item.coordinates is None
        assert item.prepared_reach.status != 'matched'
        assert set(item.matrix) == set(MATRIX_KEYS)
    serialized = json.dumps(raw)
    assert '"conditions"' not in serialized and '"simulation"' not in serialized


def test_documentary_values_keep_periods_units_scope_and_basis_separate():
    catalog = load_catalog()
    rvk = next(item for item in catalog.items if item.id == 'rvk-lipetsk-cosk')
    chlorides = [e for e in rvk.evidence if e.quantity
                 and e.quantity.parameter == 'Хлориды: концентрация на выходе ЦОСК']
    assert [e.quantity.value for e in chlorides] == [127, 147, 130, 143, 114, 104.6, 98, 122, 109, 112, 137, 115]
    months = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
              'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
    assert [e.period for e in chlorides] == ['2022, ' + month for month in months]
    for evidence in chlorides:
        assert evidence.quantity.unit == 'мг/дм³' and evidence.quantity.basis == 'actual'
        assert evidence.source_id == 'city-schema-p47'
        assert 'с. 47' in evidence.locator and 'строка 18' in evidence.locator
        assert '1 мг/дм³ = 1 мг/л' in evidence.conversion
    normative = [e for e in rvk.evidence if e.quantity and e.quantity.basis == 'permitted']
    assert len(normative) == 1
    assert normative[0].quantity.value == 136.5 and normative[0].quantity.unit == 'мг/дм³'
    assert normative[0].source_id == 'city-schema-p47' and normative[0].period == '2022'
    incoming = next(e for e in rvk.evidence if e.quantity and e.quantity.value == 112.7)
    assert incoming.quantity.unit == 'тыс. м³/сут' and incoming.quantity.basis == 'actual'
    assert incoming.period == '2022' and incoming.source_id == 'city-schema-p47'
    assert 'Вход' in incoming.quantity.scope and 'не расход' in incoming.quantity.scope
    nlmk = next(item for item in catalog.items if item.id == 'nlmk-lipetsk')
    closure = next(e for e in nlmk.evidence if e.source_id == 'nlmk-2025')
    assert closure.period == '2025-07-03' and closure.quantity is None
    assert not any(e.quantity and e.quantity.value == 0 for e in nlmk.evidence)
    lgek = next(item for item in catalog.items if item.id == 'lgek-semenovka-historical')
    assert lgek.receiver == 'р. Семёновка' and lgek.name.startswith('АО «ЛГЭК»')


@pytest.mark.anyio
async def test_catalog_endpoint_is_read_only_and_independent_of_database():
    def database_must_not_be_used():
        raise AssertionError('Catalog must not query a database')
    app.dependency_overrides[get_session] = database_must_not_be_used
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.get('/api/v1/discharge-data')
            assert response.status_code == 200
            assert response.json() == load_catalog().model_dump(mode='json')
            for method in ['POST', 'PUT', 'PATCH', 'DELETE']:
                assert (await client.request(method, '/api/v1/discharge-data', json={})).status_code == 405
    finally:
        app.dependency_overrides.clear()
