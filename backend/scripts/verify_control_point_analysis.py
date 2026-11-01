"""Record the unchanged demo and every ordinary internal state for independent analysis.

Run with existing backend dependencies. No database, field data or solver modification.
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.verify_multiple_sources import PARAMS
from app.multiple_transport import simulate_multiple


def run(output: Path):
    indices = [35, 49, 99]
    reference = []
    result = simulate_multiple(PARAMS, reference_callback=lambda hour, row:
                               reference.append([hour, *[row[index] for index in indices]]))
    report = dict(
        purpose='Same numerical scheme and ordinary internal steps; NOT validation against observations.',
        threshold_mg_l=10.2, indices=indices, inputs=result['inputs'],
        saved_times=result['times_hours'],
        saved_values=[[row[index] for index in indices] for row in result['concentrations_mg_l']],
        reference=reference, diagnostics=result['diagnostics'], temporal_resolution=result['temporal_resolution'],
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(dict(saved_states=len(report['saved_times']), reference_states=len(reference),
                         excess_mass_error_kg=result['diagnostics']['excess_mass_error_kg'])))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    run(parser.parse_args().output)
