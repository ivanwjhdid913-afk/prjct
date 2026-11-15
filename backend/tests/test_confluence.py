from json import dumps
from math import floor, fsum, hypot

from fastapi import FastAPI
import httpx
from pydantic import ValidationError
import pytest

from app import confluence as pilot


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    app = FastAPI()
    app.include_router(pilot.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as value:
        yield value


@pytest.mark.anyio
async def test_pilot_contract_and_geometry(client):
    response = await client.get("/api/v1/confluence/pilot")
    assert response.status_code == 200
    body = response.json()
    geometry = body["geometry"]
    assert geometry["id"] == "synthetic-confluence-v1"
    junction = [1000, 250]
    assert geometry["junction_m"] == junction
    for branch in geometry["branches"]:
        coordinates = branch["coordinates_m"]
        assert (coordinates[0] if branch["id"] == "out" else coordinates[-1]) == junction
        assert branch["length_m"] == pytest.approx(
            sum(hypot(x1 - x0, y1 - y0) for (x0, y0), (x1, y1) in zip(coordinates, coordinates[1:]))
        )

    response = await client.post("/api/v1/confluence/simulations", json=body["defaults"])
    assert response.status_code == 200
    result = response.json()
    assert result["model_id"] == "conservative-1d-confluence-v1"
    assert result["format_version"] == 1
    assert result["geometry"] == geometry
    assert list(result["concentrations_mg_l"]) == ["a", "b", "out"]
    assert result["flows_m3_s"] == {"a": 8, "b": 2, "out": 10}
    assert result["scale_mg_l"] == [10, 20]
    assert result["times_hours"][0] == 0
    assert result["times_hours"][-1] == 2.5
    for branch, frames in result["concentrations_mg_l"].items():
        assert len(frames) == len(result["times_hours"])
        assert all(len(frame) == result["grid"]["cells"][branch] for frame in frames)


def test_continuous_input_reaches_flow_weighted_asymptote():
    inputs = pilot.pilot_definition()["defaults"]
    inputs["branches"][0]["load_duration_minutes"] = None
    result = pilot.solve(pilot.Inputs.model_validate(inputs))
    assert result["junction_mg_l"]["a"][-1] == pytest.approx(20, abs=1e-7)
    assert result["junction_mg_l"]["b"][-1] == 10
    assert result["junction_mg_l"]["out"][-1] == pytest.approx(18, abs=1e-7)
    assert result["concentrations_mg_l"]["out"][-1][-1] == pytest.approx(18, abs=0.001)


def test_pulse_switch_is_exact_and_masses_balance():
    inputs = pilot.Inputs.model_validate(pilot.pilot_definition()["defaults"])
    result = pilot.solve(inputs, max_step_seconds=19)
    times = result["times_hours"]
    cutoff = times.index(0.25)
    assert all(a < b for a, b in zip(times, times[1:]))
    assert max((b - a) * 3600 for a, b in zip(times, times[1:])) <= 19 + 1e-9
    assert all(value == pytest.approx(72, abs=1e-10) for value in result["balance_kg"]["input"][cutoff:])
    assert result["balance_kg"]["output"][-1] == pytest.approx(72, abs=1e-5)
    assert result["balance_kg"]["stored"][-1] == pytest.approx(0, abs=1e-5)
    branches = result["branch_balance_kg"]
    assert branches["b"]["output"] == [0] * len(times)
    for index in range(len(times)):
        assert branches["out"]["input"][index] == pytest.approx(
            branches["a"]["output"][index] + branches["b"]["output"][index], abs=1e-10
        )
        assert result["balance_kg"]["stored"][index] == pytest.approx(
            sum(branches[branch]["stored"][index] for branch in branches), abs=1e-10
        )
    for balance in [result["balance_kg"], *branches.values()]:
        assert max(map(abs, balance["residual"])) < 1e-10


@pytest.mark.parametrize(("hours", "minutes"), [(0.12, 7.2), (0.17, 10.2), (4.1, 246), (8.2, 492)])
def test_pulse_can_end_exactly_at_fractional_horizon(hours, minutes):
    options = pilot.pilot_definition()["defaults"]
    options["duration_hours"] = hours
    options["branches"][0]["load_duration_minutes"] = minutes
    result = pilot.solve(pilot.Inputs.model_validate(options))
    assert result["times_hours"][-1] == hours
    assert all(a < b for a, b in zip(result["times_hours"], result["times_hours"][1:]))
    assert result["balance_kg"]["input"][-1] == pytest.approx(8 * 10 * minutes * 60 / 1000)
    options["branches"][0]["load_duration_minutes"] = None
    continuous = pilot.solve(pilot.Inputs.model_validate(options))
    assert result["times_hours"] == continuous["times_hours"]
    assert result["concentrations_mg_l"] == continuous["concentrations_mg_l"]


@pytest.mark.anyio
async def test_oversized_request_is_rejected_before_decoding_with_or_without_length(client):
    data = b" " * 9000 + b"{}"

    async def stream():
        for offset in range(0, len(data), 1024):
            yield data[offset:offset + 1024]

    for body in (data, stream()):
        response = await client.post("/api/v1/confluence/simulations", content=body,
                                     headers={"Content-Type": "application/json"})
        assert response.status_code == 413


def test_nonzero_anomalies_from_both_branches_are_combined_at_every_frame():
    inputs = pilot.pilot_definition()["defaults"]
    inputs["branches"][1].update(concentration_mg_l=4, load_duration_minutes=5)
    result = pilot.solve(pilot.Inputs.model_validate(inputs))
    assert result["branch_balance_kg"]["b"]["input"][-1] == pytest.approx(-3.6)
    assert result["balance_kg"]["input"][-1] == pytest.approx(68.4)
    assert result["balance_kg"]["output"][-1] == pytest.approx(68.4, abs=1e-5)
    junction = result["junction_mg_l"]
    mix = [0.8 * a + 0.2 * b for a, b in zip(junction["a"], junction["b"])]
    assert junction["out"] == pytest.approx(mix, abs=1e-12)
    assert any(value < 10 for frame in result["concentrations_mg_l"]["b"] for value in frame)
    assert all(4 <= value <= 20 for frames in result["concentrations_mg_l"].values() for frame in frames for value in frame)


def test_uniform_background_and_order_independent_inputs():
    inputs = pilot.pilot_definition()["defaults"]
    inputs["branches"][0]["concentration_mg_l"] = 10
    baseline = pilot.solve(pilot.Inputs.model_validate(inputs))
    inputs["branches"].reverse()
    assert pilot.solve(pilot.Inputs.model_validate(inputs)) == baseline
    assert all(value == 10 for frames in baseline["concentrations_mg_l"].values() for frame in frames for value in frame)
    assert all(value == 0 for series in baseline["balance_kg"].values() for value in series)
    impulse = pilot.pilot_definition()["defaults"]
    result = pilot.solve(pilot.Inputs.model_validate(impulse))
    impulse["branches"].reverse()
    assert pilot.solve(pilot.Inputs.model_validate(impulse)) == result


def test_convergence_under_independent_space_and_time_refinement():
    inputs = pilot.pilot_definition()["defaults"]
    inputs["duration_hours"] = 0.2
    inputs["branches"][0]["load_duration_minutes"] = 3
    for branch in inputs["branches"]:
        branch["dispersion_m2_s"] = 1
    inputs["downstream"]["dispersion_m2_s"] = 1
    inputs = pilot.Inputs.model_validate(inputs)

    def variance(target_cell_m, max_step_seconds):
        result = pilot.solve(inputs, target_cell_m=target_cell_m, max_step_seconds=max_step_seconds)
        profile = result["concentrations_mg_l"]["a"][-1]
        dx = result["geometry"]["branches"][0]["length_m"] / len(profile)
        weights = [value - inputs.background_mg_l for value in profile]
        cell_centres = [(index + 0.5) * dx for index in range(len(profile))]
        weight_sum = fsum(weights)
        centroid = fsum(w * x for w, x in zip(weights, cell_centres)) / weight_sum
        return fsum(w * (x - centroid) ** 2 for w, x in zip(weights, cell_centres)) / weight_sum

    # The plume stays within A. Its variance detects numerical dispersion without
    # interpolating profiles between differently sized finite volume cells.
    spatial_reference = variance(5, 2.5)
    spatial_error = [abs(variance(dx, 2.5) - spatial_reference) for dx in (40, 20, 10)]
    assert 0 < spatial_error[2] < 0.6 * spatial_error[1] < 0.36 * spatial_error[0]

    temporal_reference = variance(40, 1.875)
    temporal_error = [abs(variance(40, dt) - temporal_reference) for dt in (30, 15, 7.5)]
    assert 0 < temporal_error[2] < 0.6 * temporal_error[1] < 0.36 * temporal_error[0]


def test_peak_estimates_converge_at_the_node_and_downstream():
    options = pilot.pilot_definition()["defaults"]
    options["duration_hours"] = 1.15
    inputs = pilot.Inputs.model_validate(options)

    def peaks(dx, dt):
        result = pilot.solve(inputs, target_cell_m=dx, max_step_seconds=dt)
        # Evaluate the same physical section from adjacent cell means on each grid.
        spacing = result["geometry"]["branches"][2]["length_m"] / result["grid"]["cells"]["out"]
        position = 300 / spacing - 0.5
        index = floor(position)
        fraction = position - index
        downstream = [row[index] + fraction * (row[index + 1] - row[index])
                      for row in result["concentrations_mg_l"]["out"]]
        estimates = []
        for series in (result["junction_mg_l"]["out"], downstream):
            peak = max(range(len(series)), key=series.__getitem__)
            estimates.extend((series[peak], result["times_hours"][peak]))
        return estimates

    space = [peaks(dx, 5) for dx in (50, 25, 12.5, 10)]
    time = [peaks(50, dt) for dt in (30, 15, 7.5, 3.75)]
    for values in (space, time):
        for coarse, medium, fine, reference in zip(*values):
            assert abs(reference - coarse) >= abs(reference - medium) >= abs(reference - fine)
        assert all(row[1] < row[3] for row in values)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("duration_hours",), 0),
        (("duration_hours",), True),
        (("background_mg_l",), float("nan")),
        (("branches", 0, "id"), "b"),
        (("branches", 0, "flow_m3_s"), 0),
        (("branches", 0, "load_duration_minutes"), 0),
        (("branches", 0, "load_duration_minutes"), 150.1),
        (("branches", 0, "concentration_mg_l"), -0.1),
        (("downstream", "velocity_m_s"), "0.65"),
        (("downstream", "dispersion_m2_s"), -1),
        (("downstream", "unknown_setting"), 1),
    ],
)
def test_invalid_input_is_rejected(path, value):
    inputs = pilot.pilot_definition()["defaults"]
    target = inputs
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    with pytest.raises(ValidationError):
        pilot.Inputs.model_validate(inputs)


@pytest.mark.anyio
async def test_resource_limits_before_stepping(client):
    defaults = pilot.pilot_definition()["defaults"]
    inputs = pilot.Inputs.model_validate(defaults)
    with pytest.raises(pilot.SimulationLimit, match="cells"):
        pilot.solve(inputs, target_cell_m=0.1)
    with pytest.raises(pilot.SimulationLimit, match="steps"):
        pilot.solve(inputs, max_step_seconds=0.1)
    with pytest.raises(pilot.SimulationLimit, match="result"):
        pilot.solve(inputs, target_cell_m=10)

    defaults["duration_hours"] = 24
    defaults["downstream"]["velocity_m_s"] = 5
    response = await client.post("/api/v1/confluence/simulations", json=defaults)
    assert response.status_code == 422
    assert "steps" in response.json()["detail"]


@pytest.mark.anyio
async def test_busy_solver_returns_retry_status(client):
    with pilot._simulation_slot:
        response = await client.post("/api/v1/confluence/simulations", json=pilot.pilot_definition()["defaults"])
    assert response.status_code == 503
    assert response.headers["retry-after"] == "2"


@pytest.mark.anyio
async def test_nonfinite_json_input_has_serializable_validation_error(client):
    invalid = pilot.pilot_definition()["defaults"]
    invalid["background_mg_l"] = float("nan")
    response = await client.post(
        "/api/v1/confluence/simulations",
        content=dumps(invalid),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "background_mg_l"]
