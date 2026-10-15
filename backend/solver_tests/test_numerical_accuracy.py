"""Independent mathematical references and numerical refinement checks.

Exact eigenmode derivation for c_t=D*c_xx-u*c_x on [0,L]: put
c=B+exp(a*x)*f(x)*exp(-lambda*t), a=u/(2D).
f=cos(k*x)+(a/k)*sin(k*x), lambda=D*k²+u²/(4D).
Then u*c-D*c_x=u*B at x=0. At x=L, c_x=0 precisely when
2*a*k*cos(kL)+(a²-k²)*sin(kL)=0. This is the same flux inlet
and zero-gradient outlet as the production model (nonuniform initial data).
Its exact cell average follows from integral exp(a*x)*f=exp(a*x)*sin(k*x)/k.
No numerical solver or inaccessible published formula defines this reference.
"""
import math

import pytest

from app.transport import _integrate, simulate
from test_transport import DEMO


def eigenmode(n, t, mode=0):
    u, dispersion, length = .2, .5, 5.
    a = u / (2 * dispersion)
    beta = a * length
    lo, hi = mode * math.pi + 1e-10, mode * math.pi + math.pi / 2
    def equation(theta):
        return 2 * beta * theta * math.cos(theta) + (beta**2 - theta**2) * math.sin(theta)
    for _ in range(60):
        mid = (lo + hi) / 2
        if equation(lo) * equation(mid) <= 0:
            hi = mid
        else:
            lo = mid
    k = (lo + hi) / 2 / length
    decay = dispersion * k * k + u * u / (4 * dispersion)
    dx = length / n
    averages = [(math.exp(a * (i + 1) * dx) * math.sin(k * (i + 1) * dx)
                 - math.exp(a * i * dx) * math.sin(k * i * dx)) / (k * dx) for i in range(n)]
    return [3 + v for v in averages], [3 + v * math.exp(-decay * t) for v in averages]


def rms(a, b):
    return math.sqrt(math.fsum((x - y)**2 for x, y in zip(a, b)) / len(a))


def integrate_mode(n, t, dt, mode=0):
    initial, exact = eigenmode(n, t, mode)
    steps = round(t / dt)
    result = _integrate(initial=initial, u=.2, dispersion=.5, dx=5 / n,
                        dt=t / steps, steps_per_frame=steps, frames=1, inflow_per_area=.2 * 3)
    return result['snapshots'][-1], exact


def test_exact_control_same_boundary_and_spatial_convergence():
    errors = []
    for n in (20, 40, 80):
        numeric, exact = integrate_mode(n, 2., .001)
        errors.append(rms(numeric, exact))
    print('eigenmode RMS spatial errors:', errors)
    # Second order in space: error should quarter with each halving of dx.
    assert errors[-1] < 2e-5
    assert errors[0] / errors[1] > 3.7
    assert errors[1] / errors[2] > 3.7


def test_second_order_time_convergence_at_fixed_grid():
    reference, _ = integrate_mode(40, 1., .000625, mode=4)
    errors = [rms(integrate_mode(40, 1., dt, mode=4)[0], reference)
              for dt in (.025, .0125, .00625)]
    print('fixed grid RMS temporal errors:', errors)
    assert errors[0] / errors[1] > 3.8
    assert errors[1] / errors[2] > 3.8


def test_demo_refinement_and_outflow_buffer():
    # Shorter duration reduces work while covering the moving front at 6 h.
    params = DEMO | {'duration_hours': 6}
    coarse = simulate(params)
    fine_x = simulate(params, spatial_refinement=2)
    fine_t = simulate(params, temporal_refinement=2)
    long_buffer = simulate(params, buffer_factor=2)
    def largest(a, b):
        return max(abs(x-y) for row_a, row_b in zip(a['concentrations_mg_l'], b['concentrations_mg_l'])
                   for x, y in zip(row_a, row_b))
    spatial, temporal, buffer = (largest(coarse, r) for r in (fine_x, fine_t, long_buffer))
    print('demo mg/L differences: dx/2=', spatial, 'dt/2=', temporal, 'buffer*2=', buffer)
    assert spatial < .003
    assert temporal < .0002
    assert buffer < 1e-7


def test_output_buffer_when_front_has_crossed_display_end():
    params = DEMO | {'duration_hours': 15}
    base = simulate(params)
    extended = simulate(params, buffer_factor=2)
    difference = max(abs(x-y) for a,b in zip(base['concentrations_mg_l'], extended['concentrations_mg_l'])
                     for x,y in zip(a,b))
    print('post arrival buffer difference mg/L:', difference)
    assert difference < 1e-7


def test_parameter_responses():
    p = DEMO | {'duration_hours': 6}
    baseline = simulate(p)
    stronger = simulate(p | {'effluent_mg_l': 190})
    larger_river = simulate(p | {'river_flow_m3_s': 20})
    faster = simulate(p | {'velocity_m_s': .5})
    wider = simulate(p | {'dispersion_m2_s': 20})
    # The excess doubles when ce-cb doubles: exact linearity, same hydraulics.
    assert max(abs((b-10) * 2 - (s-10)) for b,s in
               zip(baseline['concentrations_mg_l'][-1], stronger['concentrations_mg_l'][-1])) < 1e-10
    assert larger_river['derived']['steady_mg_l'] < baseline['derived']['steady_mg_l']
    def normalized(result):
        plateau = result['derived']['steady_mg_l'] - 10
        return [(v-10) / plateau for v in result['concentrations_mg_l'][-1]]
    base_values, fast_values, wide_values = map(normalized, (baseline, faster, wider))
    # 6 km has not reached the plateau at 6 h at .25m/s, but has at .5m/s.
    assert fast_values[60] > base_values[60] + .5
    transition = lambda values: sum(.1 < v < .9 for v in values)
    assert transition(wide_values) > transition(base_values)


def test_integrator_rejects_nonpositive_time_scheme():
    with pytest.raises(ValueError, match='неотрицательность'):
        _integrate(initial=[1.] * 10, u=.2, dispersion=.5, dx=.1, dt=1,
                   steps_per_frame=1, frames=1, inflow_per_area=.2)
