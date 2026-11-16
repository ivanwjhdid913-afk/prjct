import { useEffect, useId, useState } from 'react';
import { dischargeDemo, DEMO_TITLE, provenanceRows, type InputProvenance } from './inputProvenance';
import { validReach, type RestorableConditions } from './multipleSources';
import type { DischargeItem, Source } from './dischargeCatalog';
import './dischargePassport.css';

const scheme = 'https://opac.lib48.ru/images/newspapers/pervyj-nomer-oficialno/2024/HTML/747/';
const historicalPoint = 'https://science-biology.ru/article/view?id=1227';
const fishPlan = 'https://fish.gov.ru/wp-content/uploads/2026/10/plan_opv_na_2026_god_v_red._rasporyazhenij_5-r_12-r_22-r_30-r_35-r_40-r_50-r_52-r_55-r_.pdf#page=33';
const observationNotice = 'https://epp.genproc.gov.ru/ru/proc_48/mass-media/news/regional/e8637469/';
const quantity = (fact: DischargeItem['evidence'][number] | undefined) => fact?.quantity
  ? `${fact.quantity.value.toLocaleString('ru-RU')} ${fact.quantity.unit}` : 'Нет значения в паспорте';

export function ProvenanceFields({ provenance }: { provenance: InputProvenance }) {
  return <dl className="passport-fields">{provenanceRows(provenance).map(row => <div key={row.key}>
    <dt>{row.label}</dt><dd><strong>{row.value}</strong><span>{row.origin} · {row.source}</span></dd>
  </div>)}</dl>;
}

export function CoskPassport({ item, sources }: { item: DischargeItem; sources: Source[] }) {
  const title = useId();
  const august = item.evidence.find(fact => fact.period === '2022, август' && fact.quantity?.basis === 'actual');
  const september = item.evidence.find(fact => fact.period === '2022, сентябрь' && fact.quantity?.basis === 'actual');
  const incoming = item.evidence.find(fact => fact.period === '2022' && fact.quantity?.parameter === 'Среднесуточное поступление на ЦОСК');
  const schemeUrl = sources.find(source => source.id === august?.source_id)?.url ?? scheme;
  return <section className="outfall-passport" aria-labelledby={title}>
    <div className="passport-top"><div><h3 id={title}>Паспорт выпуска ЦОСК</h3><p>Проверяемый период · 29.08–05.09.2022</p></div><strong className="discharge-status">Недостаточно данных</strong></div>
    <dl className="passport-fields">
      <div><dt>Координаты выпуска</dt><dd><strong>Координаты выпуска для расчёта не подтверждены</strong><span>Для наблюдений 2017 года указаны 39,54917° в. д., 52,54583° с. ш. Система координат и положение оголовков не указаны. <a href={historicalPoint}>Исследование</a></span></dd></div>
      <div><dt>Водоприёмник</dt><dd><strong>{item.receiver ?? 'Не установлен'} · 198-й км от устья</strong><span>Береговой выпуск. <a href={schemeUrl}>Схема водоотведения 2024, с. 47</a> · <a href={fishPlan}>план Росрыболовства 2026, п. 219</a>.</span></dd></div>
      <div><dt>Расход выпуска, м³/с</dt><dd><strong>Не подтверждён</strong><span>{quantity(incoming)} за 2022 год — поступление на технологическую линию. Для расчёта нужен расход на выпуске за тот же период, что и пробы.</span></dd></div>
      <div><dt>Хлориды в стоках</dt><dd><strong>{quantity(august)} · {quantity(september)}</strong><span>Август 2022 и сентябрь 2022 · месячные значения на выходе ЦОСК. Даты отдельных проб не раскрыты. <a href={schemeUrl}>Таблица 1.2, строка 18</a></span></dd></div>
      <div><dt>Расход реки выше выпуска, м³/с</dt><dd><strong>Нет данных за даты отбора</strong><span>Нужен синхронный расход в створе выше выпуска.</span></dd></div>
      <div><dt>Фон хлоридов в реке, мг/л</dt><dd><strong>Нет данных за даты отбора</strong><span>Нужны протоколы проб выше выпуска.</span></dd></div>
      <div><dt>Скорость, м/с</dt><dd><strong>Нет данных за даты отбора</strong><span>Нужна скорость течения или расчёт по расходу и живому сечению.</span></dd></div>
      <div><dt>Продольная дисперсия, м²/с</dt><dd><strong>Нет данных для участка</strong><span>Нужна оценка с методом и диапазоном неопределённости.</span></dd></div>
      <div><dt>Наблюдения в реке, мг/л</dt><dd><strong>Нет доступного ряда хлоридов</strong><span>Известно, что пробы брали. Для сравнения нужны значения, координаты створов и время. <a href={observationNotice}>Сообщение прокуратуры, 2026</a></span></dd></div>
    </dl>
    <p className="passport-note">Реальный выпуск не сопоставлен с подготовленными участками. Годовое поступление на очистку и месячные хлориды не образуют синхронную пару расхода и концентрации.</p>
    <button type="button" disabled>Применить условия</button>
  </section>;
}

type Demo = ReturnType<typeof dischargeDemo>;
type State = { status: 'loading' } | { status: 'unavailable'; message: string } | { status: 'ready'; demo: Demo };

export function DemoPassport({ onApply }: { onApply: (scenario: RestorableConditions) => void }) {
  const title = useId();
  const [opened, setOpened] = useState(false);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort('timeout'), 10_000);
    let active = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const response = await fetch('/api/v1/river-reaches', { signal: controller.signal });
        if (!response.ok) throw new Error('Реестр подготовленных участков недоступен.');
        const body = await response.json();
        if (!Array.isArray(body?.items) || !body.items.every(validReach)) throw new Error('Некорректные данные подготовленного русла.');
        const demo = dischargeDemo(body.items);
        if (active) setState({ status: 'ready', demo });
      } catch (error) {
        const message = controller.signal.aborted ? 'Не удалось сверить геометрию: время ожидания истекло.'
          : error instanceof Error ? error.message : 'Не удалось сверить геометрию.';
        if (active) setState({ status: 'unavailable', message });
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [opened, revision]);
  return <details className="discharge-card demo-passport" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary><span className="discharge-card-name"><span id={title}>{DEMO_TITLE}</span><small>Постоянный сброс · подготовленное русло</small></span><span className="discharge-status ready">Учебный пример</span></summary>
    <section className="discharge-card-body" aria-labelledby={title}>
      <p className="passport-note">Условный источник и учебная контрольная точка. Геометрия русла взята из реестра, расходы, концентрации и гидрология заданы для демонстрации.</p>
      {state.status === 'loading' && <p role="status">Сверяем геометрию с реестром…</p>}
      {state.status === 'unavailable' && <div className="passport-unavailable"><p role="status">{state.message}</p><button type="button" onClick={() => setRevision(value => value + 1)}>Сверить ещё раз</button></div>}
      {state.status === 'ready' && <><p role="status" className="passport-ready">Геометрия совпадает. Проверьте условия перед применением.</p><ProvenanceFields provenance={state.demo.input_provenance} /></>}
      <button className="primary" type="button" disabled={state.status !== 'ready'} onClick={() => { if (state.status === 'ready') onApply(state.demo); }}>Применить условия</button>
    </section>
  </details>;
}
