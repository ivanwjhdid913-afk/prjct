"""Offline, streamed grid study of a 3.6-second pulse (no API limit changes).

Run from the repository root:
  backend/.venv/Scripts/python.exe backend/tools/pulse_convergence.py --output PATH

The dense controls intentionally exceed interactive step/update caps. Only the
current solver state and 100 segment extrema are retained, never a trajectory.
Every comparison uses the same conservative 10 m displayed segment averages.
This is evidence for this scenario, not a universal error certificate.
"""
import argparse
import json
import math
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.transport import MAX_STEPS, MAX_UPDATES, _integrate, simulate


PARAMS = dict(river_flow_m3_s=10., effluent_flow_m3_s=.1,
              background_mg_l=10., effluent_mg_l=100., velocity_m_s=.25,
              dispersion_m2_s=5., length_m=1000., duration_hours=.1,
              load_mode='finite', load_duration_hours=.001)
PROBES = {'near': 0, 'middle': 49, 'far': 99}


class Extrema:
    """O(100) streaming storage, also recording whether the end is rising."""
    def __init__(self):
        self.maximum = [-math.inf] * 100
        self.peak_seconds = [0.] * 100
        self.previous = [0.] * 100
        self.last = [0.] * 100
        self.states = 0

    def capture(self, seconds, values):
        assert len(values) == 100 and all(math.isfinite(v) and v >= 0 for v in values)
        self.previous, self.last = self.last, values
        self.states += 1
        for i, value in enumerate(values):
            if value > self.maximum[i]:
                self.maximum[i], self.peak_seconds[i] = value, seconds

    def segments(self, horizon):
        return [dict(segment=i + 1, center_m=(i + .5) * 10,
                     peak_excess_mg_l=self.maximum[i], peak_seconds=self.peak_seconds[i],
                     peak_status=('truncated_rising_boundary_maximum'
                                  if self.peak_seconds[i] == horizon and self.last[i] > self.previous[i]
                                  else 'interior_peak'),
                     final_excess_mg_l=self.last[i]) for i in range(100)]


def dense_control(dx, dt, hours):
    started = time.perf_counter()
    seconds = hours * 3600
    per_segment = round(10 / dx)
    assert per_segment * dx == 10
    steps = round(seconds / dt)
    assert math.isclose(steps * dt, seconds)
    # Same 400 m downstream buffer as simulate() for all four spatial grids.
    cells = round(1400 / dx)
    extrema = Extrema()

    def capture(t, state):
        values = [math.fsum(state[i:i + per_segment]) / per_segment * 1000
                  for i in range(0, 100 * per_segment, per_segment)]
        extrema.capture(t, values)

    area = 10.1 / .25
    source = .1 * (.1 - .01)
    result = _integrate(initial=[0.] * cells, u=.25, dispersion=5., dx=dx, dt=dt,
                        steps_per_frame=steps, frames=1, inflow_per_area=source / area,
                        load_end_seconds=3.6, state_callback=capture, keep_snapshots=False)
    incoming = source * 3.6
    residual = area * dx * math.fsum(result['final_state']) + area * result['outflow_per_area'] - incoming
    assert abs(residual) / incoming < 1e-8  # Conservation check, not a peak error claim.
    assert result['snapshots'] == [] and extrema.states == result['steps'] + 1
    segments = extrema.segments(seconds)
    return dict(dx_m=dx, dt_s=dt, horizon_hours=hours, cells=cells, steps=result['steps'],
                cell_updates=cells * result['steps'],
                exceeds_interactive_caps=result['steps'] > MAX_STEPS or cells * result['steps'] > MAX_UPDATES,
                relative_excess_mass_residual=abs(residual) / incoming,
                runtime_seconds=time.perf_counter() - started,
                segments=segments, probes={name: segments[i] for name, i in PROBES.items()})


def pairwise(coarse, fine):
    result = {}
    for name in PROBES:
        a, b = coarse['probes'][name], fine['probes'][name]
        delta = a['peak_excess_mg_l'] - b['peak_excess_mg_l']
        result[name] = dict(amplitude_difference_mg_l=delta,
                            relative_amplitude_difference=abs(delta) / b['peak_excess_mg_l'],
                            peak_time_difference_seconds=a['peak_seconds'] - b['peak_seconds'],
                            both_interior=a['peak_status'] == b['peak_status'] == 'interior_peak')
    return result


def compare_series(runs, parameter):
    pairs = [pairwise(a, b) for a, b in zip(runs, runs[1:])]
    ratios = {}
    for name in PROBES:
        differences = [abs(pair[name]['amplitude_difference_mg_l']) for pair in pairs]
        ratios[name] = [a / b if b else None for a, b in zip(differences, differences[1:])]
    return dict(parameter=parameter, values=[r[parameter] for r in runs], pairs=pairs,
                successive_amplitude_difference_ratios=ratios)


def study():
    reproduction = []
    targets = [.0724053, .0752941, .0767170, .0770601]
    for factor, target in zip((1, 2, 4, 8), targets):
        r = simulate(PARAMS, spatial_refinement=factor)
        amplitude = max(row[0] for row in r['concentrations_mg_l']) - 10
        assert abs(amplitude - target) < 5e-8  # Reproduce the supplied rounded measurements.
        reproduction.append(dict(dx_m=r['diagnostics']['dx_m'], dt_s=r['diagnostics']['dt_s'],
                                 near_peak_excess_mg_l=amplitude,
                                 near_peak_seconds=r['times_hours'][max(range(len(r['times_hours'])),
                                     key=lambda i: r['concentrations_mg_l'][i][0])] * 3600))
    studies = []
    for hours in (.1, 1.5):
        spatial = []
        for dx in (10., 5., 2.5, 1.25):
            print(f'dense horizon={hours}h dx={dx}m dt=0.1s', flush=True)
            spatial.append(dense_control(dx, .1, hours))
        temporal = []
        for dt in (.2, .1, .05):
            print(f'dense horizon={hours}h dx=1.25m dt={dt}s', flush=True)
            temporal.append(spatial[-1] if dt == .1 else dense_control(1.25, dt, hours))
        space_comparison = compare_series(spatial, 'dx_m')
        time_comparison = compare_series(temporal, 'dt_s')
        for run in spatial + temporal:
            for name in ('middle', 'far'):
                expected = 'truncated_rising_boundary_maximum' if hours == .1 else 'interior_peak'
                assert run['probes'][name]['peak_status'] == expected
        # Convergence evidence: successive amplitude changes shrink. No chosen
        # 1% threshold, no assumption that a refined grid is the exact solution.
        # For the short horizon inspect the arrived near peak only: tiny remote
        # boundary tails do not establish convergence of the unobserved peak.
        for comparison in (space_comparison, time_comparison):
            for name in (('near',) if hours == .1 else PROBES):
                assert all(ratio is not None and ratio > 1 for ratio in
                           comparison['successive_amplitude_difference_ratios'][name])
        studies.append(dict(horizon_hours=hours, spatial_runs=spatial, temporal_runs=temporal,
                            spatial_comparison=space_comparison, temporal_comparison=time_comparison))
    return dict(parameters=PARAMS, reproduction=reproduction, studies=studies,
                interpretation={
                    'output_tolerance': '1% controls interpolation relative to computed step states only.',
                    'short_horizon': 'Middle/far maxima are rising boundary tails; pulse peaks have not arrived.',
                    'spatial_control': 'Fixed dt=0.1s, independently checked at dx=1.25m with dt=0.2/0.1/0.05s.',
                    'memory': 'O(cells+100) streaming extrema; no dense trajectory or snapshots retained.',
                    'budget': 'Offline controls intentionally exceed API step/update caps; production caps unchanged.',
                    'limits': 'Paired differences and measured ratios are not a continuum/physical error bound; '
                              'no universal 1% accuracy guarantee or default grid change.'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = study()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(f'Checks passed; report written to {args.output}', flush=True)
