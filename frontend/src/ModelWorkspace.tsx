import { lazy, Suspense, useState } from 'react';
const Simulation = lazy(() => import('./Simulation'));
import type { ScenarioConditions } from './scenarioStorage';
import './modelWorkspace.css';
const MultipleSimulation = lazy(() => import('./MultipleSimulation'));
type Restore = { name?: string; conditions: ScenarioConditions; geometry_sha256: string | null; downstream_geometry_sha256?: string | null };

export default function ModelWorkspace() {
  const [multiple,setMultiple]=useState(false);
  const [snapshot,setSnapshot]=useState<Restore>();
  function open(value:Restore,next:boolean) {setSnapshot(value);setMultiple(next);}
  function switchModel(next:boolean) {if(next!==multiple){setSnapshot(undefined);setMultiple(next);}}
  return <div className={`model-choice-workspace${multiple?'':' is-legacy'}`}>
    <nav className="model-choice" aria-label="Расчётная постановка">
      <button type="button" tabIndex={multiple?0:-1} aria-pressed={!multiple} onClick={()=>switchModel(false)}>Один источник · прежняя модель</button>
      <button type="button" aria-label="Несколько источников" title="Несколько источников" aria-pressed={multiple} onClick={()=>switchModel(true)}><span className="mode-full-label">Несколько источников</span><span className="mode-short-label" aria-hidden="true">1–3</span></button>
      <span>Сохраните условия перед сменой модели.</span>
    </nav>
    <Suspense fallback={<p role="status">Открываем расчётную модель…</p>}>{multiple ? <MultipleSimulation initialScenario={snapshot} onOpenLegacy={value=>open(value,false)} onApplyLegacy={value=>open(value,false)} />
      : <Simulation initialScenario={snapshot} onOpenMultiple={value=>open(value,true)} />}</Suspense>
  </div>;
}
