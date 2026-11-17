import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Reach, RestorableConditions } from "./multipleSources";
import "./modelWorkspace.css";

const Simulation = lazy(() => import("./Simulation"));
const RegionalOverview = lazy(() => import("./RegionalOverview"));
const MultipleSimulation = lazy(() => import("./MultipleSimulation"));
const Confluence = lazy(() => import("./Confluence"));
export type ModelViewState = { currentReachId: string | null; hasResult: boolean };
export type ModelViewProps = {
  workspaceVisible?: boolean;
  onViewState?: (state: ModelViewState) => void;
  requestedReach?: Reach;
  returnResultVersion?: number;
};

export default function ModelWorkspace({ initialScenario }: { initialScenario?: RestorableConditions }) {
  const [multiple, setMultiple] = useState(location.hash !== "#model/legacy");
  const [snapshot, setSnapshot] = useState(initialScenario);
  const [overview, setOverview] = useState(false);
  const [visitedOverview, setVisitedOverview] = useState(false);
  const [confluence, setConfluence] = useState(location.hash === "#model/confluence");
  const [visitedConfluence, setVisitedConfluence] = useState(confluence);
  const [requestedReach, setRequestedReach] = useState<Reach>();
  const [returnResultVersion, setReturnResultVersion] = useState(0);
  const [viewState, setViewState] = useState<ModelViewState>({ currentReachId: null, hasResult: false });
  const overviewButton = useRef<HTMLButtonElement>(null);
  const confluenceLink = useRef<HTMLAnchorElement>(null);
  const backFromConfluence = useRef<HTMLAnchorElement>(null);
  const wasConfluence = useRef(false);
  const restoreFocus = useRef(false);
  const onViewState = useCallback((state: ModelViewState) => setViewState(state), []);
  useEffect(() => {
    const navigate = () => {
      if (location.hash === "#model/confluence") {
        setOverview(false);
        setVisitedConfluence(true);
        setConfluence(true);
        return;
      }
      if (location.hash === "#model/legacy" || location.hash === "#model") {
        setConfluence(false);
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
    if (confluence) backFromConfluence.current?.focus({ preventScroll: true });
    else if (wasConfluence.current) confluenceLink.current?.focus({ preventScroll: true });
    wasConfluence.current = confluence;
  }, [confluence]);
  useEffect(() => {
    if (!overview && restoreFocus.current) {
      restoreFocus.current = false;
      overviewButton.current?.focus({ preventScroll: true });
    }
  }, [overview]);
  const viewProps = { workspaceVisible: !overview && !confluence, onViewState, requestedReach, returnResultVersion };
  function changeModel(next: boolean) {
    if (next === multiple) return;
    setRequestedReach(undefined);
    window.history.replaceState(window.history.state, "", next ? "#model" : "#model/legacy");
    setMultiple(next);
  }
  function open(value: RestorableConditions, next: boolean) {
    setSnapshot(value);
    changeModel(next);
  }
  function switchModel(next: boolean) {
    if (next !== multiple) {
      setSnapshot(undefined);
      changeModel(next);
    }
  }
  function closeOverview() {
    restoreFocus.current = true;
    setOverview(false);
  }
  function openOverview() {
    setVisitedOverview(true);
    setOverview(true);
  }
  return (
    <div className={`model-choice-workspace${multiple ? "" : " is-legacy"}`}>
      <nav className="model-choice" aria-label="Расчётная постановка" hidden={overview || confluence} inert={overview || confluence}>
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
        {multiple && <button
          ref={overviewButton}
          type="button"
          className="regional-open"
          onClick={openOverview}
        >
          Обзор области
        </button>}
        {multiple && <a className="model-confluence-link" ref={confluenceLink} href="#model/confluence">Слияние рек</a>}
        <span>Сохраните условия перед сменой модели.</span>
      </nav>
      <div className="model-view" hidden={overview || confluence} inert={overview || confluence}>
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
              onOpenOverview={openOverview}
              overviewButtonRef={overviewButton}
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
            onOpenDemo={multiple ? (scenario) => {
              setRequestedReach(undefined);
              setSnapshot(scenario);
              closeOverview();
            } : undefined}
            onReturnResult={() => {
              setReturnResultVersion((version) => version + 1);
              closeOverview();
            }}
          />
        </Suspense>
      )}
      {visitedConfluence && (
        <div className="confluence-view" hidden={!confluence} inert={!confluence}>
          <nav className="model-choice" aria-label="Навигация пилота">
            <a className="model-confluence-link" ref={backFromConfluence} href={multiple ? "#model" : "#model/legacy"}>← К прежней модели</a>
          </nav>
          <Suspense fallback={<p role="status">Открываем пилот слияния…</p>}>
            <Confluence visible={confluence} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
