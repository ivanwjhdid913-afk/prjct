"""A bounded static cartographic catalog is separate from simulation topology."""
from copy import deepcopy
import json
import pytest
from app.regional_overview import validate_overview


def fixture_document():
    source = dict(id='osm',name='OpenStreetMap',url='https://www.openstreetmap.org/copyright',
                  license='ODbL-1.0',attribution='OSM contributors',obtained_on='2026-11-02',raw_sha256='a'*64)
    def feature(id, kind, geometry, reaches=None):
        return dict(type='Feature',properties=dict(id=id,name=id,kind=kind,source_id='osm',
            source_elements=[dict(type='relation',id=72169,version=1)],prepared_reach_ids=reaches or [],
            limitation='Cartography is not a connected computational network'),geometry=geometry)
    return dict(type='FeatureCollection',metadata=dict(format_version=1,name='Regional overview',
        obtained_on='2026-11-02',crs='EPSG:4326',coordinate_order='longitude, latitude',
        coverage_note='Selected subset, not inventory',sources=[source],preparation={}),features=[
        feature('region','boundary',dict(type='Polygon',coordinates=[[[38,52],[40,52],[40,54],[38,54],[38,52]]])),
        feature('river','river',dict(type='MultiLineString',coordinates=[[[38,52],[38.1,52.1]],[[38.5,52.5],[39,53]]]),['test-reach']),
        feature('lake','lake',dict(type='Polygon',coordinates=[[[39,52.5],[39.1,52.5],[39,52.6],[39,52.5]]])),
    ])


def test_valid_static_overview_retains_disconnected_parts_without_joining():
    document = fixture_document()
    before = deepcopy(document)
    assert validate_overview(document, {'test-reach'}) == before
    assert document == before
    assert len(document['features'][1]['geometry']['coordinates']) == 2


@pytest.mark.parametrize('change', ['nan','coordinate_order','ring','duplicate','missing_source','sha','unsafe_url',
    'bad_date','missing_boundary','two_boundaries','lake_reach','unknown_reach','bad_element','geometry_kind',
    'overflow_coordinate','malformed_source','boolean_version'])
def test_invalid_static_data_is_rejected_before_serving(change):
    value=fixture_document()
    if change=='nan': value['features'][1]['geometry']['coordinates'][0][0][0]=float('nan')
    if change=='overflow_coordinate': value['features'][1]['geometry']['coordinates'][0][0][0]=10**310
    if change=='malformed_source': value['features'][1]['properties']['source_id']=[]
    if change=='boolean_version': value['metadata']['format_version']=True
    if change=='coordinate_order': value['metadata']['coordinate_order']='latitude, longitude'
    if change=='ring': value['features'][0]['geometry']['coordinates'][0].pop()
    if change=='duplicate': value['features'].append(deepcopy(value['features'][1]))
    if change=='missing_source': value['features'][1]['properties']['source_id']='missing'
    if change=='sha': value['metadata']['sources'][0]['raw_sha256']='unverified'
    if change=='unsafe_url': value['metadata']['sources'][0]['url']='https://user:password@example.org/'
    if change=='bad_date': value['metadata']['obtained_on']='2026-02-31'
    if change=='missing_boundary': value['features'].pop(0)
    if change=='two_boundaries':
        other=deepcopy(value['features'][0]);other['properties']['id']='region2';value['features'].append(other)
    if change=='lake_reach': value['features'][2]['properties']['prepared_reach_ids']=['test-reach']
    if change=='unknown_reach': value['features'][1]['properties']['prepared_reach_ids']=['unknown']
    if change=='bad_element': value['features'][0]['properties']['source_elements'][0]['id']=float('inf')
    if change=='geometry_kind': value['features'][1]['geometry']={'type':'Polygon','coordinates':value['features'][0]['geometry']['coordinates']}
    with pytest.raises(ValueError): validate_overview(value, {'test-reach'})


@pytest.mark.anyio
async def test_saved_overview_endpoint_does_not_need_database_or_remote_download(client, monkeypatch):
    def forbidden(*args, **kwargs): raise AssertionError('Overview must not invoke a solver/download')
    import app.multiple_transport
    monkeypatch.setattr(app.multiple_transport,'simulate_multiple',forbidden)
    response=await client.get('/api/v1/regional-overview')
    assert response.status_code==200,response.text
    document=response.json()
    assert document['metadata']['format_version']==1
    assert len(document['features'])>10
    assert response.headers['etag']
    repeated=await client.get('/api/v1/regional-overview',headers={'If-None-Match':response.headers['etag']})
    assert repeated.status_code==304
