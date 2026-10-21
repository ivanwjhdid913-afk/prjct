"""Finite inlet pulses: conservation, independent reference and regressions."""
import hashlib
import json
import math

import pytest

from app.transport import _integrate, simulate
from test_transport import DEMO


def legacy_rows(result):
    rows = dict(zip(result['times_hours'], result['concentrations_mg_l']))
    return [rows[i * result['inputs']['duration_hours'] / 48] for i in range(49)]


def test_continuous_numeric_output_is_bit_for_bit_unchanged():
    # Captured from the original continuous solver before finite-load changes.
    result = simulate(DEMO | {'duration_hours': 6})
    result['concentrations_mg_l'] = legacy_rows(result)
    result['times_hours'] = [i * 6 / 48 for i in range(49)]
    result.pop('temporal_resolution')
    result.pop('inputs')
    result['diagnostics'].pop('runtime_seconds')
    digest = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    assert digest == '3b119a303e92f55fd9f3a3d8b3e394547634488dba059f04f1b2b2407932020f'


def test_finite_duration_load_stops_and_preserves_mass():
    result = simulate(DEMO | dict(length_m=3126., duration_hours=6.,
                                  load_mode='finite', load_duration_hours=.5))
    assert result['inputs']['load_mode'] == 'finite'
    assert result['inputs']['load_duration_hours'] == .5
    assert result['concentrations_mg_l'][-1][0] == pytest.approx(10, abs=1e-7)
    diagnostics = result['diagnostics']
    assert diagnostics['excess_incoming_kg'] == pytest.approx(.009 * 1800)
    assert diagnostics['relative_mass_error'] < 1e-9
    assert diagnostics['relative_excess_mass_error'] < 1e-9


def test_omitted_and_explicit_continuous_and_full_duration_are_equal():
    params = DEMO | dict(duration_hours=.5, length_m=1000.)
    old = simulate(params)
    continuous = simulate(params | dict(load_mode='continuous', load_duration_hours=None))
    finite = simulate(params | dict(load_mode='finite', load_duration_hours=.5))
    assert old['inputs'] == continuous['inputs'] == params | dict(load_mode='continuous', load_duration_hours=None)
    for result in (old, continuous, finite):
        result.pop('inputs')
        result['diagnostics'].pop('runtime_seconds')
    assert old == continuous == finite


@pytest.mark.parametrize('change', [dict(effluent_flow_m3_s=0), dict(effluent_mg_l=10)])
def test_finite_no_source_preserves_background(change):
    result = simulate(DEMO | dict(duration_hours=1, load_mode='finite', load_duration_hours=.173) | change)
    assert all(c == 10 for row in result['concentrations_mg_l'] for c in row)
    assert result['diagnostics']['excess_incoming_kg'] == 0
    assert result['diagnostics']['excess_outgoing_kg'] == 0


@pytest.mark.parametrize('effluent', [0., 100.])
def test_finite_nonnegative_and_conservative_for_positive_and_negative_excess(effluent):
    params = DEMO | dict(background_mg_l=1., effluent_mg_l=effluent,
                        effluent_flow_m3_s=10., length_m=1000., duration_hours=1.,
                        load_mode='finite', load_duration_hours=.173123)
    result = simulate(params)
    low, high = result['scale_mg_l']
    assert all(max(0, low) - 1e-12 <= c <= high + 1e-12
               for row in result['concentrations_mg_l'] for c in row)
    d = result['diagnostics']
    assert d['excess_incoming_kg'] == pytest.approx(10 * (effluent - 1) * .001 * .173123 * 3600)
    assert d['excess_stored_kg'] + d['excess_outgoing_kg'] == pytest.approx(d['excess_incoming_kg'], abs=1e-9)
    assert d['final_mass_kg'] + d['outgoing_mass_kg'] == pytest.approx(d['initial_mass_kg'] + d['incoming_mass_kg'], abs=1e-9)
    assert d['incoming_mass_kg'] == pytest.approx(20 * .001 * 3600 + d['excess_incoming_kg'])
    assert d['relative_mass_error'] < 1e-9
    assert d['relative_excess_mass_error'] < 1e-9
    nominal_steps = round(3600 / d['dt_s'])
    assert d['steps'] == nominal_steps + 1
    assert d['cell_updates'] == d['cells'] * d['steps']


def test_exact_switch_inside_step_not_aligned_with_frame():
    dt, stop, flux = 1.7, 5.137, .02
    result = _integrate(initial=[0.] * 80, u=.2, dispersion=.5, dx=1.,
                        dt=dt, steps_per_frame=3, frames=5,
                        inflow_per_area=flux, load_end_seconds=stop)
    assert result['steps'] == 16
    assert result['dt_s'] == dt
    assert len(result['snapshots']) == 6
    assert math.fsum(result['snapshots'][-1]) + result['outflow_per_area'] == pytest.approx(flux * stop, abs=1e-14)
    assert math.fsum(result['snapshots'][1]) == pytest.approx(flux * 5.1, abs=1e-14)
    assert math.fsum(result['snapshots'][2]) == pytest.approx(flux * stop, abs=1e-14)


@pytest.mark.parametrize('settings', [
    dict(load_mode='other'), dict(load_mode=True), dict(load_mode=None),
    dict(load_mode='finite'), dict(load_mode='finite', load_duration_hours=None),
    *[dict(load_mode='finite', load_duration_hours=v) for v in
      [True, False, 0, -1, 7, '0.5', math.nan, math.inf, -math.inf, 10**1000]],
    dict(load_duration_hours=.5), dict(load_mode='continuous', load_duration_hours=.5),
])
def test_invalid_load_settings(settings):
    with pytest.raises(ValueError):
        simulate(DEMO | dict(duration_hours=6) | settings)


def flux_step(x, seconds, u=.1, dispersion=1.):
    """Exact semi-infinite step response with u*c-D*c_x=u at x=0.

    Solving the Laplace-transformed ODE gives
    C(x,s)=2*u*exp((u-sqrt(u*u+4*D*s))*x/(2*D))/(s*(u+sqrt(u*u+4*D*s))).
    The expression below is its inverse transform. A finite pulse is the
    difference of two time-shifted step responses (linearity of the PDE).
    This reference uses neither the production grid nor its time integrator.
    """
    if seconds <= 0:
        return 0.
    denominator = 2 * math.sqrt(dispersion * seconds)
    return (.5 * math.erfc((x - u * seconds) / denominator)
            + u * math.sqrt(seconds / (math.pi * dispersion)) * math.exp(-(x - u * seconds)**2 / (4 * dispersion * seconds))
            - .5 * (1 + u * x / dispersion + u*u * seconds / dispersion)
            * math.exp(u * x / dispersion) * math.erfc((x + u * seconds) / denominator))


def exact_pulse_cells(n, time, stop, length=100.):
    # Simpson quadrature of the analytic profile gives conservative cell means.
    dx = length / n
    def pulse(x):
        return flux_step(x, time) - flux_step(x, time - stop)
    return [(pulse(i*dx) + 4*pulse((i+.5)*dx) + pulse((i+1)*dx)) / 6 for i in range(n)]


def pulse_run(n, dt, stop=133.2, seconds=360.):
    steps = round(seconds / dt)
    return _integrate(initial=[0.] * (3*n), u=.1, dispersion=1., dx=100/n,
                      dt=seconds/steps, steps_per_frame=steps, frames=1,
                      inflow_per_area=.1, load_end_seconds=stop)['snapshots'][-1][:n]


def rms(a, b):
    return math.sqrt(math.fsum((x-y)**2 for x, y in zip(a, b)) / len(a))


def test_finite_pulse_matches_independent_analytic_reference_and_spatial_convergence():
    errors = [rms(pulse_run(n, .01), exact_pulse_cells(n, 360., 133.2)) for n in (25, 50, 100)]
    print('finite pulse analytic spatial RMS:', errors)
    assert errors[-1] < .0001
    assert errors[0] / errors[1] > 3.7
    assert errors[1] / errors[2] > 3.7


def test_finite_pulse_second_order_time_convergence():
    reference = pulse_run(50, .0125, stop=25.137, seconds=100.)
    errors = [rms(pulse_run(50, dt, stop=25.137, seconds=100.), reference) for dt in (2., 1., .5)]
    print('finite pulse temporal RMS:', errors)
    assert errors[0] / errors[1] > 3.7
    assert errors[1] / errors[2] > 3.7


def test_finite_demo_refinement_and_outlet_length_sensitivity():
    params = DEMO | dict(length_m=3126., duration_hours=6., load_mode='finite', load_duration_hours=.5)
    baseline = simulate(params)
    def difference(other):
        return max(abs(a-b) for row_a, row_b in zip(legacy_rows(baseline), legacy_rows(other))
                   for a, b in zip(row_a, row_b))
    differences = [difference(simulate(params, **option)) for option in
                   [dict(spatial_refinement=2), dict(temporal_refinement=2), dict(buffer_factor=2)]]
    print('finite demo dx/2, dt/2, buffer*2 max mg/L differences:', differences)
    assert differences[0] < .003
    assert differences[1] < .0003
    assert differences[2] < 1e-7
