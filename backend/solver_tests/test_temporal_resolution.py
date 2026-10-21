"""Output fidelity against the actual integration steps, including split events."""
from bisect import bisect_right
from array import array
import math

import pytest

from app import transport
from test_transport import DEMO


SHORT = DEMO | dict(velocity_m_s=1., length_m=500., duration_hours=1.,
                    load_mode='finite', load_duration_hours=5 / 3600)


def test_five_second_pulse_retains_actual_step_extrema_and_exact_event():
    reference = []
    result = transport.simulate(SHORT, reference_callback=lambda t, row: reference.append((t, row.copy())))
    times, rows = result['times_hours'], result['concentrations_mg_l']
    assert SHORT['load_duration_hours'] in times
    assert 49 < len(times) <= 2048
    assert max(row[0] for row in rows) > 10.499256098
    for segment in range(100):
        dense = [row[segment] for _, row in reference]
        saved = [row[segment] for row in rows]
        for extreme in (min, max):
            value = extreme(dense)
            assert extreme(saved) == value
            assert times[saved.index(value)] == reference[dense.index(value)][0]
    assert_reference_error(result, reference)


def assert_reference_error(result, reference):
    times, rows = result['times_hours'], result['concentrations_mg_l']
    background = result['inputs']['background_mg_l']
    amplitudes = [max(abs(row[j] - background) for _, row in reference) for j in range(100)]
    worst = 0.
    for t, expected in reference:
        right = min(bisect_right(times, t), len(times) - 1)
        left = right - 1
        ratio = (t - times[left]) / (times[right] - times[left])
        for j in range(100):
            predicted = rows[left][j] + ratio * (rows[right][j] - rows[left][j])
            error = abs(predicted - expected[j])
            scale = max(amplitudes[j], 1e-7)
            assert error <= .01 * scale + 1e-14
            worst = max(worst, error / scale)
    assert result['temporal_resolution']['max_relative_interpolation_error'] == pytest.approx(worst, abs=1e-12)
    return worst


@pytest.mark.parametrize('params', [
    SHORT | dict(load_duration_hours=17.137 / 3600),
    SHORT | dict(effluent_mg_l=0.),
    DEMO | dict(duration_hours=48., load_mode='finite', load_duration_hours=5 / 3600),
    DEMO | dict(length_m=3126., duration_hours=6., load_mode='finite', load_duration_hours=.5),
    DEMO | dict(duration_hours=6.),
], ids=['intermediate-pulse', 'below-background', 'long-horizon', 'half-hour-demo', 'continuous'])
def test_all_segments_dense_error_extrema_and_timestamps(params):
    reference = []
    result = transport.simulate(params, reference_callback=lambda t, row: reference.append((t, row.copy())))
    times, rows = result['times_hours'], result['concentrations_mg_l']
    assert times[0] == 0 and times[-1] == params['duration_hours']
    assert all(math.isfinite(t) for t in times)
    assert all(a < b for a, b in zip(times, times[1:]))
    assert set(i * params['duration_hours'] / 48 for i in range(49)) <= set(times)
    assert set(times) <= {t for t, _ in reference}
    for j in range(100):
        dense, saved = [row[j] for _, row in reference], [row[j] for row in rows]
        for extreme in (min, max):
            value = extreme(dense)
            assert extreme(saved) == value
            assert times[saved.index(value)] == reference[dense.index(value)][0]
    assert_reference_error(result, reference)
    metadata = result['temporal_resolution']
    assert metadata['reference_states'] == result['diagnostics']['steps'] + 1 == len(reference)
    assert metadata['reference_memory_bytes'] == len(reference) * 101 * 8 <= 16 * 1024 * 1024
    assert metadata['compression_checks'] <= transport.MAX_COMPRESSION_CHECKS
    assert metadata['max_gap_seconds'] == max(b - a for a, b in zip(times, times[1:])) * 3600
    assert result['diagnostics']['relative_mass_error'] < 1e-9
    assert result['diagnostics']['relative_excess_mass_error'] < 1e-9


def test_integrator_callback_includes_split_and_preserves_legacy_arithmetic():
    kwargs = dict(initial=[0.] * 80, u=.2, dispersion=.5, dx=1., dt=1.7,
                  steps_per_frame=3, frames=5, inflow_per_area=.02, load_end_seconds=5.137)
    original = transport._integrate(**kwargs)
    reference = []
    observed = transport._integrate(**kwargs, state_callback=lambda t, row: reference.append((t, row.copy())))
    assert observed == original
    assert len(reference) == observed['steps'] + 1 == 17
    assert 5.137 in [t for t, _ in reference]
    for frame, row in enumerate(original['snapshots']):
        index = frame * 3 + int(frame * 3 > 3)
        assert reference[index][1] == row
    compact = transport._integrate(**kwargs, keep_snapshots=False)
    assert compact['snapshots'] == []
    assert compact['final_state'] == original['snapshots'][-1]
    assert compact['outflow_per_area'] == original['outflow_per_area']


@pytest.mark.parametrize('finite', [False, True])
def test_constant_trajectory_keeps_exact_legacy_values(finite):
    params = SHORT | dict(effluent_mg_l=10.) if finite else DEMO | dict(effluent_mg_l=10., duration_hours=1.)
    result = transport.simulate(params)
    assert len(result['times_hours']) == 50 if finite else len(result['times_hours']) == 49
    assert all(row == [10.] * 100 for row in result['concentrations_mg_l'])
    assert result['temporal_resolution']['max_relative_interpolation_error'] == 0


def test_reference_allocation_limit_rejects_before_integrating(monkeypatch):
    monkeypatch.setattr(transport, 'MAX_REFERENCE_BYTES', 100)
    def forbidden(**kwargs):
        pytest.fail('Memory limit must be checked before integration')
    monkeypatch.setattr(transport, '_integrate', forbidden)
    with pytest.raises(ValueError, match='траектория'):
        transport.simulate(SHORT)


def test_adaptive_state_limit_rejects_instead_of_losing_a_peak(monkeypatch):
    # An alternating signal needs every interior vertex even though only the
    # endpoints are mandatory; exercises adaptive insertion, not just its setup.
    data = array('d', (v for i in range(20) for v in [float(i), *([float(i % 2)] * 100)]))
    monkeypatch.setattr(transport, 'MAX_OUTPUT_STATES', 8)
    with pytest.raises(ValueError, match='больше 8 состояний'):
        transport._compress_trajectory(data, {0, 19}, [1.] * 100)


def test_mandatory_state_limit_and_compression_work_limit(monkeypatch):
    data = array('d', (v for i in range(10) for v in [float(i), *([0.] * 100)]))
    monkeypatch.setattr(transport, 'MAX_OUTPUT_STATES', 2)
    with pytest.raises(ValueError, match='состояний'):
        transport._compress_trajectory(data, {0, 1, 9}, [0.] * 100)
    monkeypatch.setattr(transport, 'MAX_COMPRESSION_CHECKS', 799)
    with pytest.raises(ValueError, match='проверки интерполяции'):
        transport._compress_trajectory(data, {0, 9}, [0.] * 100)


def test_absolute_floor_allows_sub_nanogram_noise_but_not_larger_error():
    data = array('d', (v for i in range(3) for v in [float(i), *([5e-10 if i == 1 else 0.] * 100)]))
    selected, error, checks = transport._compress_trajectory(data, {0, 2}, [5e-10] * 100)
    assert selected == [0, 2] and error == pytest.approx(.005) and checks == 100
    data[102] = 2e-9
    selected, _, _ = transport._compress_trajectory(data, {0, 2}, [2e-9] * 100)
    assert selected == [0, 1, 2]


def test_representationally_coincident_event_and_legacy_frame_have_one_output_time():
    # The event and next ordinary state have identical float64 means and hour,
    # even though the unchanged integrator takes a ~2e-15-second final piece.
    params = SHORT | dict(duration_hours=.3, load_duration_hours=.0062499999999999995)
    reference=[]
    result=transport.simulate(params, reference_callback=lambda t,row:reference.append((t,row.copy())))
    times=result['times_hours']
    assert all(a < b for a,b in zip(times,times[1:]))
    assert times.count(params['load_duration_hours']) == 1
    assert set(i*.3/48 for i in range(49)) <= set(times)
    assert_reference_error(result,reference)
    assert result['diagnostics']['relative_excess_mass_error'] < 1e-9
