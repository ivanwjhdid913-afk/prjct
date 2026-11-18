from math import fsum

import pytest


def test_network_solver_is_available():
    from app.river_network import solve
    assert callable(solve)


def synthetic(split=False):
    from app.river import MeasuredLine
    nodes = [{"id": "in", "coordinate": [39, 52]}, {"id": "end", "coordinate": [39.012, 52]}]
    points = [[39, 52], [39.006, 52], [39.012, 52]]
    reaches = [dict(id="whole", from_node="in", to_node="end", geometry=dict(type="LineString", coordinates=points))]
    if split:
        nodes.insert(1, dict(id="middle", coordinate=points[1]))
        reaches = [dict(id="first", from_node="in", to_node="middle", geometry=dict(type="LineString", coordinates=points[:2])),
                   dict(id="second", from_node="middle", to_node="end", geometry=dict(type="LineString", coordinates=points[1:]))]
    for reach in reaches:
        reach["length_m"] = MeasuredLine(reach["geometry"]["coordinates"]).length_m
    return dict(id="fixture", geometry_sha256="0"*64, nodes=nodes, reaches=reaches)


def conditions(network):
    from app.river_network import Inputs
    return Inputs.model_validate(dict(network_id=network["id"],geometry_sha256=network["geometry_sha256"],
        background_mg_l=10,duration_hours=.4,
        headwaters=[dict(node_id="in",flow_m3_s=8,concentration_mg_l=10)],
        hydraulics=[dict(reach_id=r["id"],velocity_m_s=.6,dispersion_m2_s=3) for r in network["reaches"]],
        source=dict(reach_id=network["reaches"][0]["id"],distance_m=0,flow_m3_s=2,concentration_mg_l=20,load_duration_hours=.1),
        provenance=dict(hydraulics="synthetic",load="synthetic")))


def test_source_water_and_mass_are_conserved_after_pulse():
    from app.river_network import solve
    network = synthetic()
    result = solve(conditions(network), network=network)
    assert result["reaches"][0]["flows_m3_s"] == [10] * len(result["reaches"][0]["distances_m"])
    assert result["nodes"][-1]["flow_m3_s"] == 10
    assert .1 in result["times_hours"]
    assert result["balance_kg"]["input"][-1] == pytest.approx(7.2,abs=1e-10)
    assert max(map(abs,result["balance_kg"]["residual"])) < 1e-10
    assert min(x for frame in result["reaches"][0]["concentrations_mg_l"] for x in frame) >= 10


def test_serial_interface_preserves_nonzero_dispersion():
    from app.river_network import solve
    whole, split = synthetic(), synthetic(True)
    a = solve(conditions(whole), network=whole, target_cell_m=whole["reaches"][0]["length_m"]/40)
    b = solve(conditions(split), network=split, target_cell_m=whole["reaches"][0]["length_m"]/40)
    assert len(a["reaches"][0]["distances_m"]) == sum(len(r["distances_m"]) for r in b["reaches"])
    assert a["times_hours"] == pytest.approx(b["times_hours"],abs=1e-12)
    for index, frame in enumerate(a["reaches"][0]["concentrations_mg_l"]):
        joined = [v for reach in b["reaches"] for v in reach["concentrations_mg_l"][index]]
        assert frame == pytest.approx(joined,abs=2e-9)


def test_source_uses_distinct_upstream_and_downstream_flows():
    from app.river_network import solve
    network = synthetic()
    inputs = conditions(network)
    inputs.source.distance_m = network["reaches"][0]["length_m"]/2
    inputs.source.concentration_mg_l = 0
    result=solve(inputs,network=network)
    assert set(result["reaches"][0]["flows_m3_s"]) == {8,10}
    assert result["balance_kg"]["input"][-1] == pytest.approx(-7.2,abs=1e-10)
    assert max(map(abs,result["balance_kg"]["residual"])) < 1e-10


def test_cycle_split_and_stale_geometry_are_rejected():
    from app.river_network import solve
    network=synthetic()
    inputs=conditions(network)
    inputs.geometry_sha256="1"*64
    with pytest.raises(ValueError,match="Геометрия"):
        solve(inputs,network=network)
    inputs.geometry_sha256="0"*64
    network["reaches"][0]["to_node"]="in"
    with pytest.raises(ValueError):
        solve(inputs,network=network)


@pytest.mark.parametrize("position",["start","middle","end"])
def test_background_stays_exact_and_source_water_continues(position):
    from app.river_network import solve
    network=synthetic()
    inputs=conditions(network)
    inputs.source.distance_m={"start":0,"middle":network["reaches"][0]["length_m"]/2,
                              "end":network["reaches"][0]["length_m"]}[position]
    inputs.source.concentration_mg_l=10
    result=solve(inputs,network=network)
    assert all(v==10 for reach in result["reaches"] for frame in reach["concentrations_mg_l"] for v in frame)
    assert all(v==0 for series in result["balance_kg"].values() for v in series)
    assert result["nodes"][-1]["flow_m3_s"]==10
    expected={10} if position=="start" else {8} if position=="end" else {8,10}
    assert set(result["reaches"][0]["flows_m3_s"])==expected


@pytest.mark.parametrize("position",["start","middle","end"])
def test_endpoint_source_mass_enters_once(position):
    from app.river_network import solve
    network=synthetic(True)
    inputs=conditions(network)
    length=network["reaches"][0]["length_m"]
    inputs.source.distance_m={"start":0,"middle":length/2,"end":length}[position]
    result=solve(inputs,network=network)
    assert result["balance_kg"]["input"][-1]==pytest.approx(7.2,abs=1e-10)
    assert max(map(abs,result["balance_kg"]["residual"]))<1e-10
    assert set(result["reaches"][-1]["flows_m3_s"])=={10}


def test_zero_source_is_transparent_to_the_mesh_and_diffusion():
    from app.river_network import solve
    network=synthetic()
    inputs=conditions(network)
    inputs.source.flow_m3_s=0
    inputs.headwaters[0].concentration_mg_l=20
    a=solve(inputs,network=network)
    inputs.source.distance_m=network["reaches"][0]["length_m"]*.37
    b=solve(inputs,network=network)
    assert a["reaches"]==b["reaches"]
    assert a["balance_kg"]==b["balance_kg"]


def test_confluence_steady_mix_and_inlet_mass():
    from app.river_network import solve,pilot_definition,Inputs
    options=pilot_definition()["defaults"]
    options["source"]["flow_m3_s"]=0
    options["headwaters"][0]["concentration_mg_l"]=20
    inputs=Inputs.model_validate(options)
    result=solve(inputs)
    junction=next(n for n in result["nodes"] if n["id"]=="confluence")
    assert junction["flow_m3_s"]==10
    assert junction["concentrations_mg_l"][-1]==pytest.approx(18,abs=1e-8)
    assert result["balance_kg"]["input"][-1]==pytest.approx(432,abs=1e-9)
    assert max(map(abs,result["balance_kg"]["residual"]))<1e-8


@pytest.mark.parametrize("change",["length","endpoint","duplicate","split","cycle","isolated"])
def test_topology_rejects_invalid_geometry_and_graph(change):
    from copy import deepcopy
    from app.river_network import topology
    network=synthetic(True)
    if change=="length":
        network["reaches"][0]["length_m"]+=1
    elif change=="endpoint":
        network["nodes"][0]["coordinate"]=[39,51]
    elif change=="duplicate":
        network["reaches"].append(deepcopy(network["reaches"][0]))
    elif change=="split":
        extra=deepcopy(network["reaches"][0]);extra["id"]="extra"
        network["reaches"].append(extra)
    elif change=="cycle":
        reach=deepcopy(network["reaches"][0])
        reach.update(id="reverse",from_node="middle",to_node="in")
        reach["geometry"]["coordinates"].reverse()
        network["reaches"].append(reach)
    else:
        network["nodes"].append(dict(id="alone",coordinate=[40,52]))
    with pytest.raises(ValueError):
        topology(network)


def test_network_resource_limits_are_checked_before_allocation():
    from app.river_network import solve,SimulationLimit
    network=synthetic()
    inputs=conditions(network)
    with pytest.raises(SimulationLimit):
        solve(inputs,network=network,target_cell_m=.1)
    with pytest.raises(SimulationLimit):
        solve(inputs,network=network,max_step_seconds=.001)


def control_and_peak(result):
    node=next(n for n in result["nodes"] if n["id"]=="confluence")
    reach=next(r for r in result["reaches"] if r["id"]=="voronezh-lower")
    centres=reach["distances_m"]
    right=next(k for k,x in enumerate(centres) if x>=80)
    fraction=(80-centres[right-1])/(centres[right]-centres[right-1])
    control=[row[right-1]*(1-fraction)+row[right]*fraction for row in reach["concentrations_mg_l"]]
    def peak(values):
        frame=max(range(len(values)),key=values.__getitem__)
        return values[frame],result["times_hours"][frame]*60
    return peak(node["concentrations_mg_l"]),peak(control),control


def test_space_and_time_refinement_at_fixed_physical_controls():
    from app.river_network import solve,Inputs,pilot_definition
    inputs=Inputs.model_validate(pilot_definition()["defaults"])
    def peaks(dx,dt):
        result=solve(inputs,target_cell_m=dx,max_step_seconds=dt,_max_steps=10000,_max_values=3000000)
        return [point[0] for point in control_and_peak(result)[:2]]
    space=[peaks(dx,2) for dx in (20,10,5)]
    time=[peaks(20,dt) for dt in (10,5,2.5)]
    for column in range(2):
        assert space[0][column]<space[1][column]<space[2][column]
        assert space[2][column]-space[1][column]<space[1][column]-space[0][column]
        assert time[0][column]>time[1][column]>time[2][column]
        assert time[1][column]-time[2][column]<.6*(time[0][column]-time[1][column])
    default=solve(inputs)
    reference=peaks(2.5,1)
    default_peaks=[point[0] for point in control_and_peak(default)[:2]]
    assert default_peaks==pytest.approx([13.9684956542,12.5496644804],abs=1e-8)
    assert reference==pytest.approx([14.0107385135,12.6578444489],abs=1e-8)


def test_verified_boundary_extension_sensitivity_before_the_fork():
    from copy import deepcopy
    from app.river import MeasuredLine
    from app.river_network import solve,Inputs,Hydraulics,pilot_definition
    pilot=pilot_definition()
    inputs=Inputs.model_validate(pilot["defaults"])
    baseline=solve(inputs)
    network=deepcopy(pilot["network"])
    extension=MeasuredLine(network["metadata"]["verified_extension"]["geometry"]["coordinates"])
    coordinates=extension.slice(0,extension.length_m-1)
    network["nodes"].append(dict(id="extended-outlet",coordinate=coordinates[-1]))
    network["reaches"].append(dict(id="extension",from_node="outlet",to_node="extended-outlet",
        length_m=extension.length_m-1,geometry=dict(type="LineString",coordinates=coordinates)))
    inputs.hydraulics.append(Hydraulics(reach_id="extension",velocity_m_s=.4,dispersion_m2_s=1))
    extended=solve(inputs,network=network,_max_values=1000000)
    a,b=control_and_peak(baseline),control_and_peak(extended)
    assert a[0]==b[0]
    max_difference=max(abs(x-y) for x,y in zip(a[2],b[2]))
    assert 1e-9<max_difference<3e-9


def test_negative_excess_mass_keeps_nonnegative_absolute_concentration():
    from app.river_network import solve
    network=synthetic()
    inputs=conditions(network)
    inputs.background_mg_l=111.1
    inputs.headwaters[0].concentration_mg_l=111.1
    inputs.source.concentration_mg_l=0
    result=solve(inputs,network=network)
    assert min(v for r in result["reaches"] for row in r["concentrations_mg_l"] for v in row)>=0
    assert result["balance_kg"]["input"][-1]==pytest.approx(-79.992,abs=1e-10)
    assert max(map(abs,result["balance_kg"]["residual"]))<1e-9


@pytest.mark.parametrize("field,value",[
    ("duration_hours",True),("background_mg_l",float("nan")),("duration_hours",0),
])
def test_invalid_scalar_inputs(field,value):
    from pydantic import ValidationError
    from app.river_network import Inputs,pilot_definition
    options=pilot_definition()["defaults"]
    options[field]=value
    with pytest.raises(ValidationError):
        Inputs.model_validate(options)


@pytest.mark.parametrize("reach_id",["voronezh-upstream","kuzminka-upstream","voronezh-below","voronezh-lower"])
def test_advertised_geodesic_endpoint_is_a_supported_source_position(reach_id):
    from app.river_network import Inputs,pilot_definition,solve
    pilot=pilot_definition()
    options=pilot["defaults"]
    reach=next(r for r in pilot["network"]["reaches"] if r["id"]==reach_id)
    options["source"].update(reach_id=reach_id,distance_m=reach["length_m"])
    result=solve(Inputs.model_validate(options))
    assert result["source_coordinate"]==reach["geometry"]["coordinates"][-1]
    assert result["balance_kg"]["input"][-1]==pytest.approx(13.5,abs=1e-10)
    assert max(map(abs,result["balance_kg"]["residual"]))<1e-10


@pytest.mark.parametrize("flow",[.1,.5,1])
def test_continuous_source_flow_weighted_confluence(flow):
    from app.river_network import Inputs,pilot_definition,solve
    inputs=Inputs.model_validate(pilot_definition()["defaults"])
    inputs.source.flow_m3_s=flow
    inputs.source.load_duration_hours=None
    result=solve(inputs)
    junction=next(n for n in result["nodes"] if n["id"]=="confluence")
    assert junction["flow_m3_s"]==10+flow
    assert junction["concentrations_mg_l"][-1]==pytest.approx((100+100*flow)/(10+flow),abs=1e-10)
    assert result["balance_kg"]["input"][-1]==pytest.approx(flow*90*5400*.001,abs=1e-8)
    assert max(map(abs,result["balance_kg"]["residual"]))<1e-9


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_network_api_contract_busy_and_resource_failures():
    from fastapi import FastAPI
    from httpx import AsyncClient,ASGITransport
    from app.river_network import router,_slot
    app=FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app),base_url="http://test") as client:
        pilot=(await client.get("/api/v1/river-networks/pilot")).json()
        inputs=pilot["defaults"]
        response=await client.post("/api/v1/river-networks/simulations",json=inputs)
        assert response.status_code==200,response.text
        result=response.json()
        assert result["inputs"]==inputs
        assert result["network"]==pilot["network"]
        assert result["times_hours"][-1]==1.5
        assert all(len(r["concentrations_mg_l"])==len(result["times_hours"]) for r in result["reaches"])
        with _slot:
            busy=await client.post("/api/v1/river-networks/simulations",json=inputs)
        assert busy.status_code==503
        assert busy.headers["retry-after"]=="2"
        inputs["duration_hours"]=24
        assert (await client.post("/api/v1/river-networks/simulations",json=inputs)).status_code==422
        assert (await client.post("/api/v1/river-networks/simulations",content=b" "*8193)).status_code==413


def test_source_at_shared_node_has_identical_water_and_mixing_from_either_reach():
    from app.river_network import Inputs,pilot_definition,solve
    pilot=pilot_definition()
    options=pilot["defaults"]
    upstream=next(r for r in pilot["network"]["reaches"] if r["id"]=="voronezh-upstream")
    options["source"].update(reach_id="voronezh-upstream",distance_m=upstream["length_m"],
                             flow_m3_s=1,load_duration_hours=None)
    before=solve(Inputs.model_validate(options))
    options["source"].update(reach_id="voronezh-below",distance_m=0)
    after=solve(Inputs.model_validate(options))
    a=next(n for n in before["nodes"] if n["id"]=="confluence")
    b=next(n for n in after["nodes"] if n["id"]=="confluence")
    assert a==b
    assert a["flow_m3_s"]==11
    assert a["concentrations_mg_l"][-1]==pytest.approx(200/11)
    for reach in before["reaches"]:
        assert reach==next(r for r in after["reaches"] if r["id"]==reach["id"])


def test_fixed_scale_spans_actual_saved_concentrations():
    from app.river_network import Inputs,pilot_definition,solve
    result=solve(Inputs.model_validate(pilot_definition()["defaults"]))
    values=[v for reach in result["reaches"] for row in reach["concentrations_mg_l"] for v in row]
    values.extend(v for node in result["nodes"] for v in node["concentrations_mg_l"])
    assert result["scale_mg_l"]==[min(values),max(values)]
    assert result["scale_mg_l"][1]<result["inputs"]["source"]["concentration_mg_l"]


def test_node_source_observable_switches_at_exact_event_without_losing_mass():
    from app.river_network import Inputs,pilot_definition,solve
    options=pilot_definition()["defaults"]
    options["source"].update(reach_id="voronezh-below",distance_m=0,flow_m3_s=1,load_duration_hours=.1)
    result=solve(Inputs.model_validate(options))
    event=result["times_hours"].index(.1)
    node=next(n for n in result["nodes"] if n["id"]=="confluence")
    assert node["concentrations_mg_l"][event-1]==pytest.approx(200/11)
    assert node["concentrations_mg_l"][event]==10
    assert result["balance_kg"]["input"][event]==pytest.approx(32.4,abs=1e-10)


def test_initial_node_observables_use_current_boundary_forcing():
    from app.river_network import Inputs,pilot_definition,solve
    options=pilot_definition()["defaults"]
    options["headwaters"][0]["concentration_mg_l"]=20
    options["source"].update(reach_id="voronezh-below",distance_m=0,flow_m3_s=1)
    result=solve(Inputs.model_validate(options))
    head=next(n for n in result["nodes"] if n["id"]=="main-inlet")
    node=next(n for n in result["nodes"] if n["id"]=="confluence")
    assert head["concentrations_mg_l"][0]==20
    # Incoming cells still contain background, while direct node input is active.
    assert node["concentrations_mg_l"][0]==pytest.approx(200/11)
    assert all(v==10 for r in result["reaches"] for v in r["concentrations_mg_l"][0])
    assert result["balance_kg"]["input"][0]==0
