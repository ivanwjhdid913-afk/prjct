"""Conservative 1-D transport on the three synthetic reaches of the confluence pilot."""

from dataclasses import dataclass
from math import ceil, fsum, hypot, inf, isfinite, nextafter, ulp
from threading import Lock
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, model_validator


class TransportInputs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    velocity_m_s: float = Field(strict=True, ge=0.05, le=5, allow_inf_nan=False)
    dispersion_m2_s: float = Field(strict=True, ge=0, le=100, allow_inf_nan=False)


class UpstreamInputs(TransportInputs):
    id: Literal["a", "b"]
    flow_m3_s: float = Field(strict=True, ge=0.1, le=100, allow_inf_nan=False)
    concentration_mg_l: float = Field(strict=True, ge=0, le=10_000, allow_inf_nan=False)
    load_duration_minutes: float | None = Field(strict=True, gt=0, le=1440, allow_inf_nan=False)


class Inputs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    background_mg_l: float = Field(strict=True, ge=0, le=10_000, allow_inf_nan=False)
    duration_hours: float = Field(strict=True, gt=0, le=24, allow_inf_nan=False)
    branches: list[UpstreamInputs] = Field(min_length=2, max_length=2)
    downstream: TransportInputs

    @model_validator(mode="after")
    def validate_branches(self):
        if {branch.id for branch in self.branches} != {"a", "b"}:
            raise ValueError("Supply one upstream branch a and one upstream branch b")
        # The hours-to-minutes conversion can round an exact endpoint down by one ulp.
        horizon_minutes = nextafter(self.duration_hours * 60, inf)
        for branch in self.branches:
            duration = branch.load_duration_minutes
            if duration is not None and (duration / 60 == 0 or duration > horizon_minutes):
                raise ValueError("Each pulse must have a positive duration within the simulation")
        self.branches = sorted(self.branches, key=lambda branch: branch.id)
        return self


_COORDINATES_M = {
    "a": ((0, 950), (300, 550), (700, 250), (1000, 250)),
    "b": ((0, -500), (400, -200), (700, -150), (1000, 250)),
    "out": ((1000, 250), (1400, 250), (1700, 650), (2100, 350), (2500, 350)),
}
_LENGTHS_M = {
    branch: fsum(hypot(x1 - x0, y1 - y0) for (x0, y0), (x1, y1) in zip(points, points[1:]))
    for branch, points in _COORDINATES_M.items()
}
_DEFAULTS = Inputs(
    background_mg_l=10,
    duration_hours=2.5,
    branches=[
        UpstreamInputs(id="a", flow_m3_s=8, velocity_m_s=0.6, dispersion_m2_s=3,
                       concentration_mg_l=20, load_duration_minutes=15),
        UpstreamInputs(id="b", flow_m3_s=2, velocity_m_s=0.55, dispersion_m2_s=2,
                       concentration_mg_l=10, load_duration_minutes=None),
    ],
    downstream=TransportInputs(velocity_m_s=0.65, dispersion_m2_s=5),
)
_MAX_CELLS = 1_200
_MAX_STEPS = 2_500
_MAX_RESULT_VALUES = 450_000
_MAX_RESPONSE_BYTES = 12 * 1024 * 1024
_MAX_REQUEST_BYTES = 8192
_KG_PER_M3_MG_L = 0.001


def _geometry_payload() -> dict:
    return {
        "id": "synthetic-confluence-v1",
        "branches": [
            {"id": branch, "length_m": _LENGTHS_M[branch], "coordinates_m": [list(point) for point in points]}
            for branch, points in _COORDINATES_M.items()
        ],
        "junction_m": list(_COORDINATES_M["out"][0]),
    }


def pilot_definition() -> dict:
    return {"geometry": _geometry_payload(), "defaults": _DEFAULTS.model_dump()}


class SimulationLimit(ValueError):
    """The requested discretization would exceed the pilot resource budget."""


@dataclass(frozen=True)
class _GridBranch:
    cells: int
    dx_m: float
    flow_m3_s: float
    velocity_m_s: float
    dispersion_m2_s: float

    @property
    def stable_step_seconds(self) -> float:
        # Positive coefficients for upwind advection plus centred interior diffusion.
        return 0.9 / (self.velocity_m_s / self.dx_m + 2 * self.dispersion_m2_s / self.dx_m**2)

    @property
    def volume_m3(self) -> float:
        return self.flow_m3_s / self.velocity_m_s * self.dx_m

    @property
    def dispersive_coefficient_m3_s(self) -> float:
        return self.flow_m3_s / self.velocity_m_s * self.dispersion_m2_s / self.dx_m


@dataclass
class _MassHistory:
    input: list[float]
    output: list[float]
    stored: list[float]
    residual: list[float]

    @classmethod
    def initialized(cls):
        return cls([0.0], [0.0], [0.0], [0.0])

    def record(self, input_kg: float, output_kg: float, stored_kg: float) -> None:
        self.input.append(input_kg)
        self.output.append(output_kg)
        self.stored.append(stored_kg)
        self.residual.append(fsum((input_kg, -output_kg, -stored_kg)))

    def integrate(self, input_kg: float, output_kg: float, stored_kg: float) -> None:
        self.record(self.input[-1] + input_kg, self.output[-1] + output_kg, stored_kg)


def _make_grid(
    flows: dict[str, float],
    transport: dict[str, TransportInputs],
    target_cell_m: float,
) -> dict[str, _GridBranch]:
    if target_cell_m < fsum(_LENGTHS_M.values()) / _MAX_CELLS:
        raise SimulationLimit("The requested grid would exceed the pilot limit for cells")
    cells = {branch: max(2, ceil(length / target_cell_m)) for branch, length in _LENGTHS_M.items()}
    if sum(cells.values()) > _MAX_CELLS:
        raise SimulationLimit("The requested grid would exceed the pilot limit for cells")
    return {
        branch: _GridBranch(
            count, _LENGTHS_M[branch] / count, flows[branch],
            transport[branch].velocity_m_s, transport[branch].dispersion_m2_s,
        )
        for branch, count in cells.items()
    }


def _schedule(
    grid: dict[str, _GridBranch],
    cutoffs_hours: dict[str, float],
    duration_hours: float,
    max_step_seconds: float,
) -> list[tuple[float, float, int]]:
    step_limit = min(max_step_seconds, *(branch.stable_step_seconds for branch in grid.values()))
    events = sorted({0.0, duration_hours, *cutoffs_hours.values()})
    intervals = []
    step_count = 0
    for start, end in zip(events, events[1:]):
        required_steps = (end - start) * 3600 / step_limit
        if required_steps > _MAX_STEPS - step_count:
            raise SimulationLimit("The requested run would exceed the pilot limit for time steps")
        count = max(1, ceil(required_steps))
        intervals.append((start, end, count))
        step_count += count
    if step_count > _MAX_STEPS:
        raise SimulationLimit("The requested run would exceed the pilot limit for time steps")

    frames = step_count + 1
    # One time, three junction values, four global and twelve branch balance values per frame.
    values = frames * (sum(branch.cells for branch in grid.values()) + 20)
    estimated_bytes = 4096 + 32 * values + 40 * frames
    if values > _MAX_RESULT_VALUES or estimated_bytes > _MAX_RESPONSE_BYTES:
        raise SimulationLimit("The requested run would exceed the pilot limit for result size")
    return intervals


def _advance(
    concentration: list[float],
    branch: _GridBranch,
    inlet_flux: float,
    outlet_flux: float,
    dt_seconds: float,
) -> list[float]:
    q = branch.flow_m3_s
    diffusion = branch.dispersive_coefficient_m3_s
    face_fluxes = [inlet_flux]
    face_fluxes.extend(
        q * left + diffusion * (left - right)
        for left, right in zip(concentration, concentration[1:])
    )
    face_fluxes.append(outlet_flux)
    dt_over_volume = dt_seconds / branch.volume_m3
    return [
        value + dt_over_volume * (flux_in - flux_out)
        for value, flux_in, flux_out in zip(concentration, face_fluxes, face_fluxes[1:])
    ]


def solve(inputs: Inputs, *, target_cell_m: float = 25, max_step_seconds: float = 20) -> dict:
    if not all(isfinite(value) and value > 0 for value in (target_cell_m, max_step_seconds)):
        raise ValueError("Grid spacing and maximum time step must be positive and finite")
    upstream = {branch.id: branch for branch in inputs.branches}
    flows = {key: branch.flow_m3_s for key, branch in upstream.items()}
    flows["out"] = fsum(flows.values())
    grid = _make_grid(flows, {**upstream, "out": inputs.downstream}, target_cell_m)
    duration = inputs.duration_hours
    cutoffs = {}
    for key, branch in upstream.items():
        end = duration if branch.load_duration_minutes is None else branch.load_duration_minutes / 60
        # Express a whole-horizon load with the same last time after unit conversion.
        cutoffs[key] = duration if end >= nextafter(duration, 0.0) else end
    schedule = _schedule(grid, cutoffs, duration, max_step_seconds)

    # C - background in mg/L. Its signed flux and storage track the change from
    # the ambient condition without subtracting two large absolute inventories.
    background = inputs.background_mg_l
    roundoff_floor = -8 * ulp(background)

    def absolute_concentration(deviation: float) -> float:
        concentration = background + deviation
        if concentration >= 0:
            return concentration
        # The flux update and node mixing can leave a few ULPs after cancellation
        # at physical zero. Apply this tolerance only to reported concentrations.
        if concentration >= roundoff_floor:
            return 0.0
        raise ArithmeticError("Negative absolute concentration exceeds the roundoff allowance")

    states = {key: [0.0] * branch.cells for key, branch in grid.items()}
    histories = {key: [[background] * branch.cells] for key, branch in grid.items()}
    junction = {key: [background] for key in grid}
    branch_balances = {key: _MassHistory.initialized() for key in grid}
    global_balance = _MassHistory.initialized()
    times = [0.0]
    largest_step = 0.0

    for start, end, count in schedule:
        upstream_inlets = {
            key: flows[key] * (upstream[key].concentration_mg_l - background)
            if start < cutoffs[key] else 0.0
            for key in upstream
        }
        for index in range(1, count + 1):
            time = end if index == count else start + (end - start) * index / count
            dt_seconds = (time - times[-1]) * 3600
            largest_step = max(largest_step, dt_seconds)
            # Sampling the old terminal cells makes both inputs simultaneous.
            # The same outgoing advective flux feeds the next reach at the node.
            outgoing = {key: flows[key] * state[-1] for key, state in states.items()}
            incoming = {**upstream_inlets, "out": fsum(outgoing[key] for key in upstream)}
            for key, branch in grid.items():
                state = _advance(states[key], branch, incoming[key], outgoing[key], dt_seconds)
                states[key] = state
                histories[key].append([absolute_concentration(value) for value in state])
                conversion = dt_seconds * _KG_PER_M3_MG_L
                branch_balances[key].integrate(
                    incoming[key] * conversion,
                    outgoing[key] * conversion,
                    fsum(state) * branch.volume_m3 * _KG_PER_M3_MG_L,
                )
            junction["a"].append(histories["a"][-1][-1])
            junction["b"].append(histories["b"][-1][-1])
            junction["out"].append(
                absolute_concentration(fsum(flows[key] * states[key][-1] for key in upstream) / flows["out"])
            )
            global_balance.record(
                fsum(branch_balances[key].input[-1] for key in upstream),
                branch_balances["out"].output[-1],
                fsum(balance.stored[-1] for balance in branch_balances.values()),
            )
            times.append(time)

    scale = [background, *(branch.concentration_mg_l for branch in upstream.values())]
    return {
        "model_id": "conservative-1d-confluence-v1",
        "format_version": 1,
        "geometry": _geometry_payload(),
        "inputs": inputs.model_dump(),
        "flows_m3_s": flows,
        "times_hours": times,
        "concentrations_mg_l": histories,
        "junction_mg_l": junction,
        "scale_mg_l": [min(scale), max(scale)],
        "balance_kg": vars(global_balance),
        "branch_balance_kg": {key: vars(balance) for key, balance in branch_balances.items()},
        "grid": {"cells": {key: branch.cells for key, branch in grid.items()}, "max_step_seconds": largest_step},
    }


class _ConfluenceRoute(APIRoute):
    def get_route_handler(self):
        handle_request = super().get_route_handler()

        async def validate_request(request: Request):
            read_bytes = 0

            async def bounded_receive():
                nonlocal read_bytes
                message = await request.receive()
                read_bytes += len(message.get("body", b""))
                if read_bytes > _MAX_REQUEST_BYTES:
                    raise HTTPException(status_code=413, detail="Confluence request exceeds 8192 bytes")
                return message

            try:
                return await handle_request(Request(request.scope, bounded_receive))
            except RequestValidationError as exc:
                # Invalid inputs may contain non-JSON values such as NaN.
                errors = [{field: error[field] for field in ("type", "loc", "msg")} for error in exc.errors()]
                return JSONResponse({"detail": errors}, status_code=422)

        return validate_request


router = APIRouter(prefix="/api/v1/confluence", tags=["confluence pilot"], route_class=_ConfluenceRoute)
_simulation_slot = Lock()


@router.get("/pilot")
def get_pilot() -> dict:
    return pilot_definition()


@router.post("/simulations")
def simulate_confluence(inputs: Inputs) -> JSONResponse:
    if not _simulation_slot.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="The pilot solver is busy", headers={"Retry-After": "2"})
    try:
        response = JSONResponse(solve(inputs))
        if len(response.body) > _MAX_RESPONSE_BYTES:
            raise SimulationLimit("The serialized result would exceed the pilot limit for response size")
        return response
    except SimulationLimit as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        _simulation_slot.release()
