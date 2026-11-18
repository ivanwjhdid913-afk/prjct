import pytest

from app.river_network import MODEL_ID, pilot_definition


@pytest.mark.anyio
async def test_immutable_network_conditions_roundtrip(client):
    conditions=pilot_definition()["defaults"]
    body=dict(name="Сетевой контроль",model_id=MODEL_ID,format_version=1,conditions=conditions)
    saved=await client.post("/api/v1/river-networks/scenarios",json=body)
    assert saved.status_code==201,saved.text
    value=saved.json()
    assert value["conditions"]==conditions
    assert value["network_snapshot"]["geometry_sha256"]==conditions["geometry_sha256"]
    loaded=await client.get("/api/v1/river-networks/scenarios/"+value["id"])
    assert loaded.json()==value
    listed=await client.get("/api/v1/river-networks/scenarios")
    assert value in listed.json()["items"]
    assert (await client.put("/api/v1/river-networks/scenarios/"+value["id"],json=body)).status_code==405


@pytest.mark.anyio
async def test_network_storage_rejects_stale_geometry(client):
    conditions=pilot_definition()["defaults"]
    conditions["geometry_sha256"]="0"*64
    response=await client.post("/api/v1/river-networks/scenarios",json=dict(name="Stale",model_id=MODEL_ID,format_version=1,conditions=conditions))
    assert response.status_code==409


@pytest.mark.anyio
async def test_network_reload_checks_source_origin_snapshot(client,monkeypatch):
    import app.network_scenarios as storage
    conditions=pilot_definition()["defaults"]
    response=await client.post("/api/v1/river-networks/scenarios",json=dict(name="Origin",model_id=MODEL_ID,format_version=1,conditions=conditions))
    assert response.status_code==201
    network=storage.load_network()
    network["metadata"]["test_origin_change"]="changed"
    monkeypatch.setattr(storage,"load_network",lambda _:network)
    assert (await client.get("/api/v1/river-networks/scenarios/"+response.json()["id"])).status_code==409
