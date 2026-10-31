"""Reproduce output fidelity versus every step of the unchanged numerical scheme."""
from bisect import bisect_right
import json
import math
from pathlib import Path
import sys
import argparse

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
from app.river import prepared_reach
from app.transport import simulate

REACH, _ = prepared_reach()
PARAMS = dict(river_flow_m3_s=10., effluent_flow_m3_s=.1, background_mg_l=10.,
              effluent_mg_l=None, velocity_m_s=.25, dispersion_m2_s=5.,
              length_m=REACH['length_m'], duration_hours=6., load_mode='profile',
              load_intervals=[dict(start_hours=0., end_hours=.5, effluent_mg_l=100.),
                              dict(start_hours=2., end_hours=2.5, effluent_mg_l=60.)])


def interpolate(times, rows, t, j):
    right = min(bisect_right(times, t), len(times) - 1)
    left = max(0, right - 1)
    if times[right] == times[left]:
        return rows[left][j]
    ratio = (t - times[left]) / (times[right] - times[left])
    return rows[left][j] + ratio * (rows[right][j] - rows[left][j])


def peaks(reference, j):
    result, direction = [], 0
    for i in range(1, len(reference)):
        delta = reference[i][1][j] - reference[i - 1][1][j]
        sign = (delta > 0) - (delta < 0)
        if sign < 0 and direction > 0:
            result.append(reference[i - 1])
        if sign:
            direction = sign
    return result


def run(output_path: Path):
    reference = []
    baseline = simulate(PARAMS, reference_callback=lambda t, row: reference.append((t, row.copy())))
    times, rows = baseline['times_hours'], baseline['concentrations_mg_l']
    saved = dict(zip(times, rows))
    amplitudes = [max(abs(row[j] - 10.) for _, row in reference) for j in range(100)]
    per_segment, worst, worst_absolute = [], 0., 0.
    for j in range(100):
        measured = []
        for t, row in peaks(reference, j):
            if row[j] - 10. <= 1e-6:
                continue
            assert t in saved and saved[t] == row
            output = saved[t][j]
            measured.append(dict(time_hours=t, reference_mg_l=row[j], output_mg_l=output,
                                 amplitude_above_background_mg_l=row[j] - 10.,
                                 relative_amplitude_error=abs(output - row[j]) / (row[j] - 10.),
                                 peak_time_error_seconds=0.))
        assert len(measured) == 2, (j, measured)
        errors = [abs(interpolate(times, rows, t, j) - row[j]) for t, row in reference]
        absolute = max(errors)
        relative = absolute / max(amplitudes[j], 1e-7)
        worst, worst_absolute = max(worst, relative), max(worst_absolute, absolute)
        per_segment.append(dict(segment_index=j, distance_m=baseline['distances_m'][j], peaks=measured,
                                max_absolute_interpolation_error_mg_l=absolute,
                                max_relative_interpolation_error=relative))
    assert worst <= .01 + 1e-12
    assert all(saved[t] == dict(reference)[t] for t in times)
    report = dict(purpose='Output fidelity relative to frequent recording of the SAME scheme; not physical validation.',
                  reach_id=REACH['id'], params=PARAMS, diagnostics=baseline['diagnostics'],
                  temporal_resolution=baseline['temporal_resolution'],
                  exact_events_hours=[0., .5, 2., 2.5],
                  all_events_saved=all(t in times for t in (0., .5, 2., 2.5)),
                  resolved_peaks=200, worst_peak_amplitude_error=0., worst_peak_time_error_seconds=0.,
                  independently_measured_interpolation_error=worst,
                  independently_measured_absolute_interpolation_error_mg_l=worst_absolute,
                  per_segment=per_segment)
    report['refinement'] = []
    common = [i * 6 / 48 for i in range(49)]
    for options in [dict(spatial_refinement=2.), dict(temporal_refinement=2.), dict(buffer_factor=2.),
                    dict(spatial_refinement=4.)]:
        try:
            other = simulate(PARAMS, **options)
            other_rows = dict(zip(other['times_hours'], other['concentrations_mg_l']))
            difference = max(abs(a - b) for t in common for a, b in zip(saved[t], other_rows[t]))
            report['refinement'].append(dict(options=options, max_difference_at_49_common_times_mg_l=difference,
                                              cells=other['diagnostics']['cells'], steps=other['diagnostics']['steps']))
        except ValueError as error:
            report['refinement'].append(dict(options=options, rejected=str(error)))
    signed = PARAMS | dict(load_intervals=[dict(start_hours=0., end_hours=.5, effluent_mg_l=0.),
                                         dict(start_hours=2., end_hours=2.5, effluent_mg_l=20.)])
    cancellation = simulate(signed)
    report['signed_cancellation'] = dict(diagnostics=cancellation['diagnostics'],
                                       absolute_excess_throughput_kg=3.6,
                                       minimum_output_mg_l=min(map(min, cancellation['concentrations_mg_l'])))
    assert abs(cancellation['diagnostics']['excess_incoming_kg']) < 1e-14
    assert cancellation['diagnostics']['relative_excess_mass_error'] < 1e-10
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('resolved_peaks', 'independently_measured_interpolation_error',
                                                  'independently_measured_absolute_interpolation_error_mg_l', 'refinement')}, indent=2))
    print(output_path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='Path for the full numerical JSON report')
    run(parser.parse_args().output)
