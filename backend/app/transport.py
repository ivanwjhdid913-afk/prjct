"""Bounded, conservative 1D scenario solver; no database or web dependencies.

Cell values are volume averages in kg/m³. Exponential fitting integrates the
constant-coefficient advective/dispersive face flux. Crank–Nicolson advances
those fluxes with a positivity-preserving time-step restriction. No clipping,
reaction, or graphical attenuation is applied. This is not a calibrated model.
"""
import math
import time
from array import array
from collections.abc import Callable


PARAMETER_LIMITS = {
    'river_flow_m3_s': (.1, 1000.), 'effluent_flow_m3_s': (0., 100.),
    'background_mg_l': (0., 10000.), 'effluent_mg_l': (0., 10000.),
    'velocity_m_s': (.02, 2.), 'dispersion_m2_s': (.1, 100.),
    'length_m': (100., 20000.), 'duration_hours': (.1, 48.),
}
MAX_CELLS = 6000
MAX_STEPS = 15000
MAX_UPDATES = 20_000_000
MAX_OUTPUT_STATES = 2048
MAX_REFERENCE_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
MAX_COMPRESSION_CHECKS = 50_000_000
INTERPOLATION_RELATIVE_TOLERANCE = .01
INTERPOLATION_ABSOLUTE_TOLERANCE_MG_L = 1e-9


def _resolution_limit(reason: str) -> ValueError:
    return ValueError('Недостаточное временное разрешение: ' + reason
                      + ' Измените длительность расчёта, длительность нагрузки или параметры потока; '
                      'точность не снижена автоматически.')


def _compress_trajectory(data: array, mandatory: set[int], amplitudes: list[float]) -> tuple[list[int], float, int]:
    """Common RDP time grid with a per-signal, background-relative error bound.

    Each accepted interval has been checked against every interior step state.
    Mandatory extrema/events/legacy times partition the work before refinement.
    The flat, preallocated float64 reference holds time plus 100 conservative means.
    """
    width = 101
    selected = set(mandatory)
    ordered = sorted(selected)
    pending = list(zip(ordered, ordered[1:]))
    scales = [max(a, INTERPOLATION_ABSOLUTE_TOLERANCE_MG_L / INTERPOLATION_RELATIVE_TOLERANCE)
              for a in amplitudes]
    checks, accepted_error = 0, 0.
    if len(selected) > MAX_OUTPUT_STATES:
        raise _resolution_limit(f'нужно больше {MAX_OUTPUT_STATES} состояний.')
    while pending:
        left, right = pending.pop()
        needed = max(0, right - left - 1) * 100
        if checks + needed > MAX_COMPRESSION_CHECKS:
            raise _resolution_limit('превышен лимит проверки интерполяции.')
        checks += needed
        start, end = left * width, right * width
        duration = data[end] - data[start]
        worst, split = 0., None
        for i in range(left + 1, right):
            offset = i * width
            ratio = (data[offset] - data[start]) / duration
            for j, scale in enumerate(scales, 1):
                estimate = data[start + j] + ratio * (data[end + j] - data[start + j])
                error = abs(data[offset + j] - estimate) / scale
                if error > worst:
                    worst, split = error, i
        if worst > INTERPOLATION_RELATIVE_TOLERANCE:
            if len(selected) >= MAX_OUTPUT_STATES:
                raise _resolution_limit(f'нужно больше {MAX_OUTPUT_STATES} состояний.')
            selected.add(split)
            pending.extend(((left, split), (split, right)))
        else:
            accepted_error = max(accepted_error, worst)
    return sorted(selected), accepted_error, checks


def validate_parameters(params: dict) -> dict:
    required = set(PARAMETER_LIMITS)
    if (not isinstance(params, dict) or not required <= set(params)
            or set(params) - required - {'load_mode', 'load_duration_hours', 'load_intervals'}):
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
    if mode not in ('continuous', 'finite', 'profile'):
        raise ValueError('load_mode: допустимы continuous, finite или profile.')
    rows = params.get('load_intervals')
    if mode != 'profile' and rows is not None:
        raise ValueError('load_intervals: интервалы допустимы только в режиме profile.')
    if mode == 'profile':
        if duration is not None:
            raise ValueError('Для профиля load_duration_hours должен быть null.')
        if not isinstance(rows, list) or len(rows) > 12:
            raise ValueError('load_intervals: нужен явный список не более 12 интервалов.')
        normalized = []
        previous_end = 0.
        for index, row in enumerate(rows):
            prefix = f'load_intervals[{index}]'
            if not isinstance(row, dict) or set(row) != {'start_hours', 'end_hours', 'effluent_mg_l'}:
                raise ValueError(prefix + ': нужны начало, конец и концентрация.')
            for name in ('start_hours', 'end_hours', 'effluent_mg_l'):
                value = row[name]
                upper = 10000 if name == 'effluent_mg_l' else result['duration_hours']
                if (isinstance(value, bool) or not isinstance(value, (int, float))
                        or not math.isfinite(value) or not 0 <= value <= upper):
                    raise ValueError(prefix + f'.{name}: требуется конечное число от 0 до {upper:g}.')
            if row['start_hours'] >= row['end_hours']:
                raise ValueError(prefix + ': конец должен быть позже начала.')
            if row['start_hours'] < previous_end:
                raise ValueError(prefix + ': нарушен порядок или есть перекрытие с предыдущим интервалом.')
            previous_end = row['end_hours']
            normalized.append({key: float(value) for key, value in row.items()})
        result['load_intervals'] = normalized
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
               inflow_per_area: float, load_end_seconds: float | None = None,
               state_callback: Callable[[float, list[float]], None] | None = None,
               keep_snapshots: bool = True,
               inflow_intervals: list[tuple[float, float, float]] | None = None) -> dict:
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
    snapshots = [current.copy()] if keep_snapshots else []
    if state_callback is not None:
        state_callback(0., current)
    outgoing = 0.
    work = [0.] * n
    steps = 0
    max_dt = 0.

    def advance(step_dt, coefficients, active, end_seconds):
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
        if state_callback is not None:
            state_callback(end_seconds, current)

    profile_steps = _profile_steps(dt, frames * steps_per_frame, inflow_intervals) if inflow_intervals is not None else None
    profile_cursor = 0
    factor_cache = {dt: nominal}
    for frame in range(frames):
        for substep in range(steps_per_frame):
            index = frame * steps_per_frame + substep
            if profile_steps is not None:
                nominal_end = (index + 1) * dt
                while profile_cursor < len(profile_steps):
                    step_dt, end, flux = profile_steps[profile_cursor]
                    coefficients = factor_cache.get(step_dt)
                    if coefficients is None:
                        coefficients = factor_cache[step_dt] = factors(step_dt)
                    coefficients = (*coefficients[:-1], step_dt * flux / dx)
                    advance(step_dt, coefficients, True, end)
                    profile_cursor += 1
                    if end == nominal_end:
                        break
            elif index == stop_index and split:
                # Exact event time, independent of output frames and normal steps.
                # Each piece uses a constant inlet flux; do not trapezoidally
                # smear the source discontinuity across either piece.
                advance(before_stop, before, True, load_end_seconds)
                advance(dt - before_stop, after, False, (index + 1) * dt)
            else:
                advance(dt, nominal, stop_index is None or index < stop_index, (index + 1) * dt)
        if keep_snapshots:
            snapshots.append(current.copy())
    return {'snapshots': snapshots, 'final_state': current, 'outflow_per_area': outgoing, 'steps': steps, 'dt_s': max_dt}


def _profile_steps(dt: float, steps: int, intervals: list[tuple[float, float, float]]) -> list[tuple[float, float, float]]:
    """Split the unchanged nominal time grid at exact source boundaries."""
    horizon = steps * dt
    events = sorted({t for a, b, _ in intervals for t in (a, b) if 0 < t < horizon})
    result, cursor = [], 0
    for index in range(steps):
        start, end = index * dt, (index + 1) * dt
        points = []
        while cursor < len(events) and events[cursor] <= end:
            if events[cursor] > start:
                points.append(events[cursor])
            cursor += 1
        if not points or points[-1] != end:
            points.append(end)
        left = start
        for right in points:
            # The right-hand row wins at a touching half-open boundary.
            flux = next((value for a, b, value in intervals if a <= left < b), 0.)
            step_dt = (dt if left == start else dt - (left - start)) if right == end else right - left
            result.append((step_dt, right, flux))
            left = right
    return result


def _load_switch(dt: float, load_end_seconds: float | None) -> tuple[int | None, float]:
    if load_end_seconds is None:
        return None, 0.
    index = math.floor(load_end_seconds / dt)
    return index, load_end_seconds - index * dt


def _event_neighbor_hour(hours: float, event: float, direction: float, horizon: float) -> float:
    """Encode a distinct event neighbor when seconds collapse onto one hour.

    The event itself is immutable. Move only its ordinary neighbor by at most
    two event-hour ULPs; never manufacture room outside the requested domain.
    This changes the float representation of time, not integration or values.
    """
    if (direction < 0 and hours < event) or (direction > 0 and hours > event):
        return hours
    candidate = math.nextafter(event, direction)
    if not 0 <= candidate <= horizon or abs(candidate - hours) > 2 * math.ulp(event):
        raise _resolution_limit('близкие моменты нельзя различить с машинной точностью.')
    return candidate


def simulate(params: dict, *, spatial_refinement: float = 1.,
             temporal_refinement: float = 1., buffer_factor: float = 1.,
             reference_callback: Callable[[float, list[float]], None] | None = None) -> dict:
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
    is_profile = p['load_mode'] == 'profile'
    event_hours = {}
    for hours in [0., p['duration_hours'],
                  *[row[key] for row in p.get('load_intervals', []) for key in ('start_hours', 'end_hours')]]:
        event_seconds = hours * 3600
        if event_seconds in event_hours and event_hours[event_seconds] != hours:
            # Distinct valid input doubles can become identical after unit
            # conversion. Never silently drop that pulse or its gap.
            raise _resolution_limit('близкие события нельзя различить с машинной точностью.')
        event_hours[event_seconds] = hours
    intervals = [(row['start_hours'] * 3600, row['end_hours'] * 3600,
                  qe * (row['effluent_mg_l'] * .001 - cb))
                 for row in p.get('load_intervals', [])]
    active_seconds = p['load_duration_hours'] * 3600 if p['load_mode'] == 'finite' else seconds
    # A full-duration pulse follows precisely the existing continuous arithmetic.
    load_end = active_seconds if active_seconds < seconds and not is_profile else None
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
    # Event splitting can only add work. Reject the nominal grid before
    # materializing its schedule (which otherwise could be vastly too large).
    if n > MAX_CELLS or steps > MAX_STEPS or n * steps > MAX_UPDATES:
        raise ValueError('Слишком большой размер вычислений: уменьшите длину или длительность; '
                         'снизьте скорость либо увеличьте дисперсию. '
                         f'Сетка: {n} ячеек, шагов: {steps}, операций ячейка-шаг: {n * steps}.')
    profile_steps = _profile_steps(dt, steps, [(a, b, flux / area) for a, b, flux in intervals]) if is_profile else None
    if profile_steps is not None:
        steps = len(profile_steps)
    elif _load_switch(dt, load_end)[1] > 0:
        steps += 1
    updates = n * steps
    if n > MAX_CELLS or steps > MAX_STEPS or updates > MAX_UPDATES:
        raise ValueError('Слишком большой размер вычислений: уменьшите длину или длительность; '
                         'снизьте скорость либо увеличьте дисперсию. '
                         f'Сетка: {n} ячеек, шагов: {steps}, операций ячейка-шаг: {updates}.')
    reference_bytes = (steps + 1) * 101 * array('d').itemsize
    if reference_bytes > MAX_REFERENCE_BYTES:
        raise _resolution_limit(f'опорная траектория превышает {MAX_REFERENCE_BYTES} байт.')
    trajectory = array('d', [0.]) * ((steps + 1) * 101)
    stop_index, before_stop = _load_switch(dt, load_end)
    legacy_frames = {i * steps_per_frame + int(before_stop > 0 and i * steps_per_frame > stop_index): i
                     for i in range(49)}
    if profile_steps is not None:
        endpoint_indices = {end: i + 1 for i, (_, end, _) in enumerate(profile_steps)}
        legacy_frames = {0: 0} | {endpoint_indices[i * steps_per_frame * dt]: i for i in range(1, 49)}
    profile_neighbors = {}
    if is_profile:
        event_indices = {endpoint_indices[t]: hours for t, hours in event_hours.items() if 0 < t < seconds}
        for index, hours in event_indices.items():
            for neighbor, direction in ((index - 1, -math.inf), (index + 1, math.inf)):
                if neighbor not in event_indices:
                    profile_neighbors[neighbor] = hours, direction
    mandatory = set(legacy_frames)
    previous_values, directions = None, [0] * 100
    minimum, maximum = [math.inf] * 100, [-math.inf] * 100
    min_index, max_index = [0] * 100, [0] * 100
    reference_count = 0

    def capture(t, state):
        nonlocal reference_count, previous_values
        index = reference_count
        hours = t / 3600
        if index in legacy_frames:
            hours = legacy_frames[index] * p['duration_hours'] / 48
            # Endpoints belong to the requested domain exactly. In particular,
            # 48 * .1 / 48 is one ULP larger than .1; keep the historical
            # arithmetic only for interior frames, without touching the state.
            if legacy_frames[index] == 0:
                hours = 0.
            elif legacy_frames[index] == 48:
                hours = p['duration_hours']
        if is_profile and t in event_hours:
            hours = event_hours[t]
            mandatory.add(index)
        if load_end is not None and t == load_end:
            hours = p['load_duration_hours']
            mandatory.add(index)
        offset = index * 101
        values = [(cb + math.fsum(state[i:i + per_segment]) / per_segment) * 1000
                  for i in range(0, 100 * per_segment, per_segment)]
        if index in profile_neighbors:
            event, direction = profile_neighbors[index]
            if direction < 0 or values != previous_values:
                hours = _event_neighbor_hour(hours, event, direction, p['duration_hours'])
        if before_stop > 0:
            event_index = stop_index + 1
            if index == event_index - 1:
                hours = _event_neighbor_hour(hours, p['load_duration_hours'], -math.inf, p['duration_hours'])
            elif index == event_index + 1 and values != list(trajectory[offset - 100:offset]):
                hours = _event_neighbor_hour(hours, p['load_duration_hours'], math.inf, p['duration_hours'])
            if index in legacy_frames and legacy_frames[index] in (0, 48):
                endpoint = 0. if legacy_frames[index] == 0 else p['duration_hours']
                if hours != endpoint:
                    raise _resolution_limit('близкие моменты нельзя различить с машинной точностью.')
        trajectory[offset] = hours
        if is_profile and previous_values is not None:
            # Each reversal is retained, including weaker later pulses. With
            # an exact plateau the last plateau state is the turning point.
            for j, value in enumerate(values):
                delta = value - previous_values[j]
                direction = (delta > 0) - (delta < 0)
                if direction and directions[j] and direction != directions[j]:
                    mandatory.add(index - 1)
                if direction:
                    directions[j] = direction
        previous_values = values
        for j, value in enumerate(values):
            trajectory[offset + j + 1] = value
            if value < minimum[j]:
                minimum[j], min_index[j] = value, index
            if value > maximum[j]:
                maximum[j], max_index[j] = value, index
        reference_count += 1
        if reference_callback is not None:
            reference_callback(hours, values)

    # Evolve the excess above the constant background. This avoids subtractive
    # cancellation in the small excess mass balance while preserving the PDE.
    run = _integrate(initial=[0.] * n, u=u, dispersion=dispersion, dx=dx, dt=dt,
                     steps_per_frame=steps_per_frame, frames=48,
                     inflow_per_area=excess_load / area, load_end_seconds=load_end,
                     state_callback=capture, keep_snapshots=False,
                     inflow_intervals=[(a, b, flux / area) for a, b, flux in intervals] if is_profile else None)
    mandatory.update(min_index)
    mandatory.update(max_index)
    amplitudes = [max(abs(low - p['background_mg_l']), abs(high - p['background_mg_l']))
                  for low, high in zip(minimum, maximum)]
    selected, interpolation_error, checks = _compress_trajectory(trajectory, mandatory, amplitudes)
    # A split event can differ from an ordinary step by less than one ULP
    # in hours. Keep one state only when both time and all means are identical;
    # integration, mass accounting, and the stored values remain unchanged.
    distinct = []
    for index in selected:
        if distinct and trajectory[index * 101] <= trajectory[distinct[-1] * 101]:
            previous = distinct[-1]
            if trajectory[index * 101:(index + 1) * 101] == trajectory[previous * 101:(previous + 1) * 101]:
                continue
            raise _resolution_limit('близкие моменты нельзя различить с машинной точностью.')
        distinct.append(index)
    selected = distinct
    times = [trajectory[i * 101] for i in selected]
    rows = [list(trajectory[i * 101 + 1:(i + 1) * 101]) for i in selected]
    excess_stored = area * dx * math.fsum(run['final_state'])
    excess_in = (math.fsum(flux * (b - a) for a, b, flux in intervals) if is_profile
                 else excess_load * active_seconds)
    absolute_excess_in = (math.fsum(abs(flux) * (b - a) for a, b, flux in intervals) if is_profile
                          else abs(excess_in))
    excess_out = area * run['outflow_per_area']
    excess_error = excess_stored - (excess_in - excess_out)
    initial_mass = area * dx * n * cb
    final_mass = initial_mass + excess_stored
    # After cessation the water flow and background mass flux continue unchanged.
    full_in = ((qr * cb + qe * ce) * seconds if load_end is None and not is_profile
               else flow * cb * seconds + excess_in)
    full_out = flow * cb * seconds + excess_out
    mass_error = final_mass - initial_mass - (full_in - full_out)
    return {
        'inputs': p,
        'derived': dict(total_flow_m3_s=flow, area_m2=area, load_kg_s=None if is_profile else qe * ce,
                        excess_load_kg_s=None if is_profile else excess_load,
                        steady_mg_l=None if is_profile else steady * 1000,
                        travel_hours=length / u / 3600),
        'distances_m': [(i + .5) * length / 100 for i in range(100)],
        'times_hours': times,
        'concentrations_mg_l': rows,
        'temporal_resolution': dict(method='adaptive-step-states', saved_states=len(selected),
                                   reference_states=reference_count, max_states=MAX_OUTPUT_STATES,
                                   interpolation_relative_tolerance=INTERPOLATION_RELATIVE_TOLERANCE,
                                   interpolation_absolute_tolerance_mg_l=INTERPOLATION_ABSOLUTE_TOLERANCE_MG_L,
                                   max_relative_interpolation_error=interpolation_error,
                                   reference_max_step_seconds=run['dt_s'],
                                   max_gap_seconds=max(b - a for a, b in zip(times, times[1:])) * 3600,
                                   memory_limit_bytes=MAX_REFERENCE_BYTES, reference_memory_bytes=reference_bytes,
                                   max_response_bytes=MAX_RESPONSE_BYTES, compression_checks=checks),
        'scale_mg_l': ([min([p['background_mg_l']] + [(qr * cb + qe * r['effluent_mg_l'] * .001) / flow * 1000 for r in p['load_intervals']]),
                        max([p['background_mg_l']] + [(qr * cb + qe * r['effluent_mg_l'] * .001) / flow * 1000 for r in p['load_intervals']])]
                       if is_profile else [min(cb, steady) * 1000, max(cb, steady) * 1000]),
        'diagnostics': dict(method='exponential-fitted finite volume / Crank-Nicolson',
                            cells=n, steps=run['steps'], cell_updates=updates, dx_m=dx, dt_s=run['dt_s'],
                            cell_peclet=u * dx / dispersion, buffer_m=buffer_cells * dx,
                            initial_mass_kg=initial_mass, final_mass_kg=final_mass,
                            incoming_mass_kg=full_in, outgoing_mass_kg=full_out,
                            excess_stored_kg=excess_stored, excess_incoming_kg=excess_in,
                            excess_outgoing_kg=excess_out,
                            mass_error_kg=mass_error, excess_mass_error_kg=excess_error,
                            relative_mass_error=abs(mass_error) / max(abs(full_in), initial_mass, 1e-30),
                            relative_excess_mass_error=abs(excess_error) / max(absolute_excess_in, 1e-30),
                            runtime_seconds=time.perf_counter() - started),
    }
