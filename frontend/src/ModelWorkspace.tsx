import type { AnalysisSettings } from "./analysisSettings";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Reach } from "./multipleSources";
import type { ScenarioConditions } from "./scenarioStorage";
import "./modelWorkspace.css";

const Simulation = lazy(() => import("./Simulation"));
const RegionalOverview = lazy(() => import("./RegionalOverview"));
const MultipleSimulation = lazy(() => import("./MultipleSimulation"));
type Restore = {
  name?: string;
  analysis_settings?: AnalysisSettings | null;
  conditions: ScenarioConditions;
  geometry_sha256: string | null;
  downstream_geometry_sha256?: string | null;
};
export type ModelViewState = { currentReachId: string | null; hasResult: boolean };
export type ModelViewProps = {
  workspaceVisible?: boolean;
  onViewState?: (state: ModelViewState) => void;
  requestedReach?: Reach;
  returnResultVersion?: number;
};

export default function ModelWorkspace() {
  const [multiple, setMultiple] = useState(location.hash !== "#model/legacy");
  const [snapshot, setSnapshot] = useState<Restore>();
  const [overview, setOverview] = useState(false);
  const [visitedOverview, setVisitedOverview] = useState(false);
  const [requestedReach, setRequestedReach] = useState<Reach>();
  const [returnResultVersion, setReturnResultVersion] = useState(0);
  const [viewState, setViewState] = useState<ModelViewState>({ currentReachId: null, hasResult: false });
  const overviewButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const onViewState = useCallback((state: ModelViewState) => setViewState(state), []);
  useEffect(() => {
    const navigate = () => {
      if (location.hash === "#model/legacy" || location.hash === "#model") {
        setSnapshot(undefined);
        setRequestedReach(undefined);
        setOverview(false);
        setMultiple(location.hash !== "#model/legacy");
      }
    };
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => {
    if (!overview && restoreFocus.current) {
      restoreFocus.current = false;
      overviewButton.current?.focus({ preventScroll: true });
    }
  }, [overview]);
  const viewProps = { workspaceVisible: !overview, onViewState, requestedReach, returnResultVersion };
  function open(value: Restore, next: boolean) {
    if (next !== multiple) setRequestedReach(undefined);
    setSnapshot(value);
    setMultiple(next);
  }
  function switchModel(next: boolean) {
    if (next !== multiple) {
      setSnapshot(undefined);
      setRequestedReach(undefined);
      setMultiple(next);
    }
  }
  function closeOverview() {
    restoreFocus.current = true;
    setOverview(false);
  }
  return (
    <div className="model-choice-workspace">
      <nav className="model-choice" aria-label="Расчётная постановка" hidden={overview} inert={overview}>
        <button
          type="button"
          aria-label="Один источник · прежняя модель"
          aria-pressed={!multiple}
          onClick={() => switchModel(false)}
        >
          <span className="mode-full-label">Один источник · прежняя модель</span>
          <span className="mode-short-label" aria-hidden="true">Один источник</span>
        </button>
        <button
          type="button"
          aria-label="Несколько источников"
          title="Несколько источников"
          aria-pressed={multiple}
          onClick={() => switchModel(true)}
        >
          <span className="mode-full-label">Несколько источников</span>
          <span className="mode-short-label" aria-hidden="true">
            1–3 источника
          </span>
        </button>
        <button
          ref={overviewButton}
          type="button"
          className="regional-open"
          onClick={() => {
            setVisitedOverview(true);
            setOverview(true);
          }}
        >
          Обзор области
        </button>
        <span>Сохраните условия перед сменой модели.</span>
      </nav>
      <div className="model-view" hidden={overview} inert={overview}>
        <Suspense fallback={<p role="status">Открываем расчётную модель…</p>}>
          {multiple ? (
            <MultipleSimulation
              {...viewProps}
              initialScenario={snapshot}
              onOpenLegacy={(value) => open(value, false)}
              onApplyLegacy={(value) => open(value, false)}
            />
          ) : (
            <Simulation
              {...viewProps}
              initialScenario={snapshot}
              onOpenMultiple={(value) => open(value, true)}
            />
          )}
        </Suspense>
      </div>
      {visitedOverview && (
        <Suspense fallback={<p role="status">Открываем обзор области…</p>}>
          <RegionalOverview
            visible={overview}
            currentReachId={viewState.currentReachId}
            hasResult={viewState.hasResult}
            onApplyReach={(reach) => {
              setRequestedReach({ ...reach });
              closeOverview();
            }}
            onReturnResult={() => {
              setReturnResultVersion((version) => version + 1);
              closeOverview();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
