import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TemporalProfile from '../src/TemporalProfile';
import MultipleSourceMap from '../src/MultipleSourceMap';
import '../src/styles.css';
import '../src/simulation.css';
import '../src/multipleSources.css';
import { multipleResultFixture } from './multiple-result-fixture';

const reach: any = {
  id: 'test-curve', name: 'Тестовое русло', length_m: 1000,
  geometry: { type: 'LineString', coordinates: [[39, 52], [39.003, 52.002], [39.001, 52.004], [39.005, 52.006]] },
  distances_m: [0, 332.5, 667.5, 1000], metadata: {},
};
const inputs: any = {
  river_flow_m3_s: 10, background_mg_l: 10, velocity_m_s: .25, dispersion_m2_s: 5,
  duration_hours: 5, reach_id: reach.id,
  sources: [{ id: 'source-1', name: 'Источник', source_distance_m: 100, effluent_flow_m3_s: .1,
    effluent_mg_l: 100, load_mode: 'continuous', load_duration_hours: null, load_intervals: null }],
};
const result: any = {
  ...multipleResultFixture(inputs, reach), times_hours: [0, 1, 2, 3, 4, 5],
  concentrations_mg_l: [10, 12, 10, 10, 12, 10].map(c => Array(100).fill(c)), scale_mg_l: [10, 12],
};
const points = [{ id: 'cp-1', name: 'У створа', segment_index: 35 }];
const intervals = [{ start_hours: .5, end_hours: 1.5, start_inclusive: false, end_inclusive: false, continues_at_end: false },
  { start_hours: 3.5, end_hours: 4.5, start_inclusive: false, end_inclusive: false, continues_at_end: false }];

function MapHarness() {
  const [selected, setSelected] = useState(35);
  const [point, setPoint] = useState<string | null>(null);
  const [sourceSelections, setSourceSelections] = useState(0);
  const Map = MultipleSourceMap as any;
  return <><div style={{ height: 480, position: 'relative' }}><Map reach={reach} result={null} values={null}
    scale={[10, 12]} sources={inputs.sources} selectedSource="source-1" selectedSegment={selected}
    picking={false} profileOpen={false} suspended={false} onSource={() => setSourceSelections(n => n + 1)}
    onSegment={setSelected} onPick={() => {}} controlPoints={points} selectedControlPointId={point}
    onControlPointSelect={(p: any) => { setPoint(p.id); setSelected(p.segment_index); }} /></div>
    <output data-testid="map-selection">{selected} / {point} / {sourceSelections}</output></>;
}

function PointEventHarness({ Panel }: { Panel: any }) {
  const allPoints = [...points, { id: 'cp-2', name: 'Ниже по течению', segment_index: 49 }];
  const [selected, setSelected] = useState('cp-2');
  const [hour, setHour] = useState(0);
  return <><Panel draftPoints={allPoints} thresholdDraft="11" appliedSettings={{ points: allPoints, threshold_mg_l: 11 }}
    result={result} a={null} b={null} hour={hour} selectedSegment={49} selectedPointId={selected}
    analysisAvailable={true} draftDirty={false} lengthM={1000} onAddSelected={() => {}} onRename={() => {}}
    onRemove={() => {}} onSelect={(point: any) => setSelected(point.id)} onThresholdChange={() => {}}
    onApply={() => {}} onResetForGeometry={() => {}} onSeek={setHour} />
    <output aria-label="Выбранная точка и время">{selected} / {hour}</output></>;
}

async function mount() {
  const mode = new URL(location.href).searchParams.get('mode');
  const root = createRoot(document.getElementById('root')!);
  document.getElementById('root')!.setAttribute('data-mounted', 'true');
  if (mode === 'map') { root.render(<MapHarness />); return; }
  if (mode === 'chart' || mode === 'chart-huge') {
    const Chart = TemporalProfile as any;
    root.render(<Chart result={result} a={result} b={result} distances={result.distances_m} selected={35}
      onSelect={() => {}} hour={1.25} duration={5} scale={[10, 12]} background={10}
      onSeek={(hour: number) => { document.querySelector('output')!.textContent = String(hour); }}
      thresholdMgL={mode === 'chart-huge' ? 1e308 : 11} exceedanceIntervals={intervals} comparisonExceedanceIntervals={intervals} />);
    return;
  }
  try {
    const path = '/src/ControlPointsPanel.tsx';
    const { default: Panel } = await import(/* @vite-ignore */ path);
    if (mode === 'panel-event-select') { root.render(<PointEventHarness Panel={Panel} />); return; }
    const threshold = mode === 'panel-null' ? null : mode === 'panel-zero' ? 0 : 11;
    const primary = mode === 'panel-many' ? { ...result, times_hours: Array.from({length: 101}, (_, i) => i / 20),
      concentrations_mg_l: Array.from({length: 101}, (_, i) => Array(100).fill(i % 2 ? 12 : 10)) } : result;
    const comparing = mode === 'panel';
    root.render(<Panel draftPoints={points} thresholdDraft={threshold === null ? '' : String(threshold)} appliedSettings={{ points, threshold_mg_l: threshold }}
      result={mode === 'panel-before' ? null : primary} a={comparing ? result : null} b={comparing ? { ...result, concentrations_mg_l: result.times_hours.map(() => Array(100).fill(10)) } : null}
      hour={1.25} selectedSegment={35} selectedPointId="cp-1" analysisAvailable={true} draftDirty={false} lengthM={1000}
      onAddSelected={() => {}} onRename={() => {}} onRemove={() => {}} onSelect={() => {}}
      onThresholdChange={() => {}} onApply={() => {}} onResetForGeometry={() => {}}
      onSegmentSelect={(index: number) => { document.querySelector('output')!.textContent = String(index); }}
      onSeek={(hour: number) => { document.querySelector('output')!.textContent = String(hour); }} />);
  } catch (error) { document.getElementById('root')!.textContent = String(error); }
}
void mount();
