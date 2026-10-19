"""Bounded, conservative 1D scenario solver; no database or web dependencies.

Cell values are volume averages in kg/m³. Exponential fitting integrates the
constant-coefficient advective/dispersive face flux. Crank–Nicolson advances
those fluxes with a positivity-preserving time-step restriction. No clipping,
reaction, or graphical attenuation is applied. This is not a calibrated model.
"""
import math
import time


PARAMETER_LIMITS = {
    'river_flow_m3_s': (.1, 1000.), 'effluent_flow_m3_s': (0., 100.),
    'background_mg_l': (0., 10000.), 'effluent_mg_l': (0., 10000.),
    'velocity_m_s': (.02, 2.), 'dispersion_m2_s': (.1, 100.),
    'length_m': (100., 20000.), 'duration_hours': (.1, 48.),
}
MAX_CELLS = 6000
MAX_STEPS = 15000
MAX_UPDATES = 20_000_000


def validate_parameters(params: dict) -> dict:
    required = set(PARAMETER_LIMITS)
    if (not isinstance(params, dict) or not required <= set(params)
            or set(params) - required - {'load_mode', 'load_duration_hours'}):
        raise ValueError('Нужны восемь физических параметров и допустимые настройки нагрузки.')
    result = {}
    for name, (low, high) in PARAMETER_LIMITS.items():
        value = params[name]
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not low <= value <= high or not math.isfinite(value)):
            raise ValueError(f'{name}: требуется конечное число от {low:g} до {high:g}.')
        result[name] = float(value)
    mode = params.get('load_mode', 'continuous')
    duration = params.get('load_duration_hours')
    if mode not in ('continuous', 'finite'):
        raise ValueError('load_mode: допустимы continuous или finite.')
    if mode == 'continuous' and duration is not None:
        raise ValueError('Для непрерывной нагрузки load_duration_hours должен быть null.')
    if mode == 'finite' and (isinstance(duration, bool) or not isinstance(duration, (int, float))
                             or not 0 < duration <= result['duration_hours']
                             or not math.isfinite(duration)):
        raise ValueError('Длительность нагрузки должна быть конечным положительным числом не больше длительности расчёта.')
    result.update(load_mode=mode, load_duration_hours=float(duration) if duration is not None else None)
    return result


def _coefficients(u: float, dispersion: float, dx: float) -> tuple[float, float]:
    peclet = u * dx / dispersion
    left = u / -math.expm1(-peclet)
    right = u / math.expm1(peclet)
    return left / dx, right / dx


def _integrate(*, initial: list[float], u: float, dispersion: float,
               dx: float, dt: float, steps_per_frame: int, frames: int,
               inflow_per_area: float, load_end_seconds: float | None = None) -> dict:
    """Integrate a specified initial profile; inlet is flux, outlet c_x=0.

    Internal entry point also permits an independent exact eigenmode test.
    Inflow and integrated outflow here are per cross-sectional area.
    """
    n = len(initial)
    left, right = _coefficients(u, dispersion, dx)
    if n < 2 or dt <= 0 or dt * (left + right) > 2 + 1e-12:
        raise ValueError('Шаг времени не обеспечивает неотрицательность схемы.')
    def factors(step_dt):
        h = step_dt / 2
        lo, hi = h * left, h * right
        # M = I - dt L/2 is an M-matrix. Pre-factor each distinct step size.
        diagonal = [1 + lo] + [1 + lo + hi] * (n - 2) + [1 + lo]
        inverse = [0.] * n
        upper = [0.] * n
        inverse[0] = 1 / diagonal[0]
        upper[0] = -hi * inverse[0]
        for i in range(1, n):
            inverse[i] = 1 / (diagonal[i] + lo * upper[i - 1])
            upper[i] = -hi * inverse[i] if i < n - 1 else 0.
        return lo, hi, inverse, upper, 1 - lo - hi, 1 - lo, step_dt * inflow_per_area / dx

    nominal = factors(dt)
    stop_index, before_stop = _load_switch(dt, load_end_seconds)
    split = before_stop > 0
    before = factors(before_stop) if split else None
    after = factors(dt - before_stop) if split else None
    current = initial.copy()
    snapshots = [current.copy()]
    outgoing = 0.
    work = [0.] * n
    steps = 0
    max_dt = 0.

    def advance(step_dt, coefficients, active):
        nonlocal outgoing, steps, max_dt
        lo, hi, inverse, upper, mid_factor, edge_factor, source = coefficients
        if not active:
            source = 0.
        old_last = current[-1]
        work[0] = (edge_factor * current[0] + hi * current[1] + source) * inverse[0]
        for i in range(1, n - 1):
            rhs = lo * current[i - 1] + mid_factor * current[i] + hi * current[i + 1]
            work[i] = (rhs + lo * work[i - 1]) * inverse[i]
        work[-1] = (lo * current[-2] + edge_factor * old_last + lo * work[-2]) * inverse[-1]
        current[-1] = work[-1]
        for i in range(n - 2, -1, -1):
            current[i] = work[i] - upper[i] * current[i + 1]
        outgoing += step_dt * u * (old_last + current[-1]) / 2
        steps += 1
        max_dt = max(max_dt, step_dt)

    for frame in range(frames):
        for substep in range(steps_per_frame):
            index = frame * steps_per_frame + substep
            if index == stop_index and split:
                # Exact event time, independent of output frames and normal steps.
                # Each piece uses a constant inlet flux; do not trapezoidally
                # smear the source discontinuity across either piece.
                advance(before_stop, before, True)
                advance(dt - before_stop, after, False)
            else:
                advance(dt, nominal, stop_index is None or index < stop_index)
        snapshots.append(current.copy())
    return {'snapshots': snapshots, 'outflow_per_area': outgoing, 'steps': steps, 'dt_s': max_dt}


def _load_switch(dt: float, load_end_seconds: float | None) -> tuple[int | None, float]:
    if load_end_seconds is None:
        return None, 0.
    index = math.floor(load_end_seconds / dt)
    return index, load_end_seconds - index * dt


def simulate(params: dict, *, spatial_refinement: float = 1.,
             temporal_refinement: float = 1., buffer_factor: float = 1.) -> dict:
    """Run one scenario; refinement options are for numerical tests, not the API."""
    started = time.perf_counter()
    p = validate_parameters(params)
    for factor in (spatial_refinement, temporal_refinement, buffer_factor):
        if not math.isfinite(factor) or factor < 1 or factor > 8:
            raise ValueError('Коэффициент уточнения должен быть от 1 до 8.')
    qr, qe = p['river_flow_m3_s'], p['effluent_flow_m3_s']
    cb, ce = p['background_mg_l'] * .001, p['effluent_mg_l'] * .001
    u, dispersion = p['velocity_m_s'], p['dispersion_m2_s']
    length, seconds = p['length_m'], p['duration_hours'] * 3600
    active_seconds = p['load_duration_hours'] * 3600 if p['load_mode'] == 'finite' else seconds
    # A full-duration pulse follows precisely the existing continuous arithmetic.
    load_end = active_seconds if active_seconds < seconds else None
    flow = qr + qe
    area = flow / u
    excess_load = qe * (ce - cb)
    steady = (qr * cb + qe * ce) / flow
    # Each display segment contains an integer number of internal cells, so
    # displayed concentrations are conservative spatial averages, not samples.
    per_segment = math.ceil(max(1., length / 100 * u / (.5 * dispersion)) * spatial_refinement)
    dx = length / (100 * per_segment)
    buffer_cells = math.ceil(max(.1 * length, 20 * dispersion / u) * buffer_factor / dx)
    n = 100 * per_segment + buffer_cells
    left, right = _coefficients(u, dispersion, dx)
    dt_limit = .8 * 2 / (left + right) / temporal_refinement
    steps_per_frame = math.ceil(seconds / 48 / dt_limit)
    steps = 48 * steps_per_frame
    dt = seconds / steps
    if _load_switch(dt, load_end)[1] > 0:
        steps += 1
    updates = n * steps
    if n > MAX_CELLS or steps > MAX_STEPS or updates > MAX_UPDATES:
        raise ValueError('Слишком большой размер вычислений: уменьшите длину или длительность; '
                         'снизьте скорость либо увеличьте дисперсию. '
                         f'Сетка: {n} ячеек, шагов: {steps}, операций ячейка-шаг: {updates}.')
    # Evolve the excess above the constant background. This avoids subtractive
    # cancellation in the small excess mass balance while preserving the PDE.
    run = _integrate(initial=[0.] * n, u=u, dispersion=dispersion, dx=dx, dt=dt,
                     steps_per_frame=steps_per_frame, frames=48,
                     inflow_per_area=excess_load / area, load_end_seconds=load_end)
    rows = [[(cb + math.fsum(row[i:i + per_segment]) / per_segment) * 1000
             for i in range(0, 100 * per_segment, per_segment)] for row in run['snapshots']]
    excess_stored = area * dx * math.fsum(run['snapshots'][-1])
    excess_in = excess_load * active_seconds
    excess_out = area * run['outflow_per_area']
    excess_error = excess_stored - (excess_in - excess_out)
    initial_mass = area * dx * n * cb
    final_mass = initial_mass + excess_stored
    # After cessation the water flow and background mass flux continue unchanged.
    full_in = ((qr * cb + qe * ce) * seconds if load_end is None
               else flow * cb * seconds + excess_in)
    full_out = flow * cb * seconds + excess_out
    mass_error = final_mass - initial_mass - (full_in - full_out)
    return {
        'inputs': p,
        'derived': dict(total_flow_m3_s=flow, area_m2=area, load_kg_s=qe * ce,
                        excess_load_kg_s=excess_load, steady_mg_l=steady * 1000,
                        travel_hours=length / u / 3600),
        'distances_m': [(i + .5) * length / 100 for i in range(100)],
        'times_hours': [i * p['duration_hours'] / 48 for i in range(49)],
        'concentrations_mg_l': rows,
        'scale_mg_l': [min(cb, steady) * 1000, max(cb, steady) * 1000],
        'diagnostics': dict(method='exponential-fitted finite volume / Crank-Nicolson',
                            cells=n, steps=run['steps'], cell_updates=updates, dx_m=dx, dt_s=run['dt_s'],
                            cell_peclet=u * dx / dispersion, buffer_m=buffer_cells * dx,
                            initial_mass_kg=initial_mass, final_mass_kg=final_mass,
                            incoming_mass_kg=full_in, outgoing_mass_kg=full_out,
                            excess_stored_kg=excess_stored, excess_incoming_kg=excess_in,
                            excess_outgoing_kg=excess_out,
                            mass_error_kg=mass_error, excess_mass_error_kg=excess_error,
                            relative_mass_error=abs(mass_error) / max(abs(full_in), initial_mass, 1e-30),
                            relative_excess_mass_error=abs(excess_error) / max(abs(excess_in), 1e-30),
                            runtime_seconds=time.perf_counter() - started),
    }
