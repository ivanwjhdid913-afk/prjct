import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { basisLabels, cellLabels, matrixLabels, readinessLabels, validDischargeCatalog, type DischargeCatalog, type DischargeItem, type MatrixKey, type Source } from './dischargeCatalog';
import './dischargeData.css';

const dateLabel = (date: string) => date.split('-').reverse().join('.');
const coordinateLabel = (item: DischargeItem) => item.coordinates?.kind === 'enterprise' ? 'Территория предприятия' : 'Водовыпуск';
function Reference({ source }: { source: Source }) {
  return <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>;
}
function EvidenceMap({ items }: { items: DischargeItem[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [tileError, setTileError] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const mapped = items.filter(item => item.coordinates !== null);
    if (!mapped.length) return;
    const map = L.map(host.current, { scrollWheelZoom: false, zoomControl: false });
    map.attributionControl.setPrefix(false);
    L.control.zoom({ zoomInTitle: 'Увеличить масштаб', zoomOutTitle: 'Уменьшить масштаб' }).addTo(map);
    map.fitBounds(mapped.map(item => [item.coordinates!.latitude, item.coordinates!.longitude] as L.LatLngTuple), { padding: [35, 35], maxZoom: 14 });
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 }).addTo(map);
    let timer = window.setTimeout(() => setTileError(true), 10_000);
    tiles.on('load', () => window.clearTimeout(timer)); tiles.on('tileerror', () => setTileError(true));
    for (const item of mapped) {
      const point = item.coordinates!;
      const marker = L.marker([point.latitude, point.longitude], { keyboard: true, icon: L.divIcon({ className: `discharge-marker ${point.kind}`, html: point.kind === 'enterprise' ? '▧' : '●', iconSize: [44, 44], iconAnchor: [22, 22] }) }).addTo(map);
      const label = `${coordinateLabel(item)}: ${item.name}`;
      const element = marker.getElement(); element?.setAttribute('role', 'button'); element?.setAttribute('aria-label', label);
      const reveal = () => { const card = document.getElementById(`discharge-${item.id}`) as HTMLDetailsElement | null; if (card) { card.open = true; card.scrollIntoView({ block: 'start', behavior: 'auto' }); card.querySelector('summary')?.focus({ preventScroll: true }); } };
      marker.on('click', reveal);
      element?.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); reveal(); } });
    }
    const observer = new ResizeObserver(() => map.invalidateSize()); observer.observe(host.current);
    return () => { window.clearTimeout(timer); observer.disconnect(); map.remove(); };
  }, [items]);
  return <section className="discharge-map-panel" aria-label="Карта документированных положений">
    <div ref={host} className="discharge-map" />
    <p>▧ Территория предприятия · ● Водовыпуск. Положение территории не обозначает место сброса.</p>
    {tileError && <p role="status">Подложка недоступна. Подтверждённые координаты и паспорта доступны в списке.</p>}
  </section>;
}
function Passport({ item, sources }: { item: DischargeItem; sources: Source[] }) {
  const point = item.coordinates;
  return <details className="discharge-card" id={`discharge-${item.id}`} data-testid="discharge-card">
    <summary><span className="discharge-card-name">{item.name}<small>{item.kind}</small></span><span className={`discharge-status ${item.readiness}`}>{readinessLabels[item.readiness]}</span></summary>
    <div className="discharge-card-body">
      <p className="discharge-conclusion">{item.discharge_summary}</p>
      <dl className="discharge-facts"><div><dt>Положение объекта</dt><dd>{item.location_description}</dd></div><div><dt>Принимающий водный объект</dt><dd>{item.receiver ?? 'Не установлен'}<small>{item.receiver_note}</small></dd></div><div><dt>Координаты</dt><dd>{point ? <><strong>{coordinateLabel(item)}</strong><br />{point.longitude}, {point.latitude} · {point.crs}, долгота, широта<small>{point.description} · {point.locator}</small><Reference source={sources.find(s => s.id === point.source_id)!} /></> : 'Координаты не установлены'}</dd></div></dl>
      <h3>Что подтверждено документами</h3>
      <ul className="discharge-evidence">{item.evidence.map((fact, index) => <li key={index}>
        <p>{fact.statement}</p>
        {fact.quantity && <p className="discharge-quantity"><strong>{fact.quantity.value.toLocaleString('ru-RU', { maximumFractionDigits: 15 })} {fact.quantity.unit}</strong><span>{fact.quantity.parameter} · {basisLabels[fact.quantity.basis]}</span><small>{fact.quantity.scope}</small></p>}
        <p className="discharge-citation"><span>Период: {fact.period}. {fact.locator}.</span> <Reference source={sources.find(s => s.id === fact.source_id)!} /></p>
        {fact.conversion && <p className="discharge-conversion">{fact.conversion}</p>}
      </li>)}</ul>
      <div className="discharge-limitations"><h3>Готовность к моделированию</h3><p><strong>{readinessLabels[item.readiness]}.</strong> {item.readiness_reason}</p><p>{item.prepared_reach.explanation}</p><h4>Недостающие сведения</h4><ul>{item.missing.map((value, index) => <li key={index}>{value}</li>)}</ul><p className="discharge-no-calc">Паспорт не подставляет параметры в модель. Сценарный расчёт доступен независимо в разделе «Моделирование».</p></div>
    </div>
  </details>;
}
export default function DischargeData() {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: DischargeCatalog }>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const abort = new AbortController(); let active = true; setState({ status: 'loading' });
    const timeout = window.setTimeout(() => abort.abort(), 10_000);
    void fetch('/api/v1/discharge-data', { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('Не удалось загрузить паспорта данных. Проверьте соединение и повторите запрос.');
      const data: unknown = await response.json();
      if (!validDischargeCatalog(data)) throw new Error('Некорректный набор исходных данных. Обновите приложение или повторите запрос.');
      if (active) setState({ status: 'ready', data });
    }).catch(error => { if (active) setState({ status: 'error', message: abort.signal.aborted ? 'Не удалось загрузить паспорта: время ожидания истекло.' : error instanceof Error ? error.message : 'Не удалось загрузить паспорта данных.' }); }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; abort.abort(); window.clearTimeout(timeout); };
  }, [revision]);
  const data = state.status === 'ready' ? state.data : null;
  return <section className="discharge-section" aria-labelledby="discharge-title">
    <header className="discharge-heading"><p className="eyebrow">Исходные данные / Липецк и окрестности</p><h1 id="discharge-title" ref={title} tabIndex={-1}>Данные о водных сбросах</h1><p className="lead">Проверенные сведения, их происхождение и пробелы перед первым расчётом на реальных данных.</p></header>
    <aside className="discharge-caution"><strong>Объект исследования — не подтверждение действующего сброса.</strong><p>Сведения относятся к указанным периодам. Годовая масса не задаёт концентрацию, расход и режим. Расчётная концентрация не является измеренной; наличие предприятия не доказывает причину загрязнения.</p></aside>
    {state.status === 'loading' && <div className="state" role="status"><p>Загружаем паспорта данных…</p><div className="skeleton" /><div className="skeleton" /></div>}
    {state.status === 'error' && <div className="state error" role="alert"><p>{state.message}</p><button onClick={() => setRevision(v => v + 1)}>Повторить загрузку</button></div>}
    {data && <>
      <div className="discharge-overview"><span><strong>{data.items.length}</strong> исследованных объектов</span><span><strong>{data.items.filter(item => item.readiness === 'ready').length}</strong> готовых постановок расчёта</span><span>Проверено {dateLabel(data.checked_on)}<small>Набор v{data.format_version} · периоды указаны в паспортах</small></span></div>
      {data.items.some(item => item.coordinates !== null) ? <EvidenceMap items={data.items} /> : <p className="discharge-map-absent">Проверенных координат для маркеров в этом наборе нет. Адреса предприятий не приняты за координаты выпусков.</p>}
      {!data.items.length ? <p className="state">Паспортов пока нет</p> : <div className="discharge-passports" aria-label="Паспорта исследованных объектов">{data.items.map(item => <Passport key={item.id} item={item} sources={data.sources} />)}</div>}
      {!!data.items.length && <section className="discharge-matrix"><h2>Что есть для модели</h2><p>«Есть сведения» означает наличие документа, а не подтверждённую точность. Для расчёта хлоридов нужны согласованные условия одного выпуска и периода.</p><div role="region" aria-label="Матрица наличия данных" tabIndex={0} className="discharge-table-scroll"><table aria-label="Матрица наличия данных"><thead><tr><th scope="col">Параметр</th>{data.items.map(item => <th scope="col" key={item.id}>{item.name}</th>)}</tr></thead><tbody>{(Object.keys(matrixLabels) as MatrixKey[]).map(key => <tr key={key}><th scope="row">{matrixLabels[key]}</th>{data.items.map(item => <td key={item.id}><span className={`matrix-state ${item.matrix[key].status}`}>{cellLabels[item.matrix[key].status]}</span><small>{item.matrix[key].note}</small></td>)}</tr>)}<tr><th scope="row">Подготовленные участки</th>{data.items.map(item => <td key={item.id}><strong>{item.prepared_reach.status === 'matched' ? 'Сопоставлен' : item.prepared_reach.status === 'outside' ? 'Вне участка' : 'Не сопоставлен'}</strong><small>{item.prepared_reach.explanation}</small></td>)}</tr></tbody></table></div></section>}
      <section className="discharge-sources"><h2>Источники и воспроизводимость</h2><p>Оригиналы не перепубликуются. Для скачанных документов указана SHA-256; если скачивание недоступно, это отмечено отдельно. Содержимое внешних сайтов может измениться.</p>{data.sources.map(source => <details key={source.id}><summary>{source.publisher} · {source.title}</summary><div><Reference source={source} /><dl><dt>Документ / идентификатор</dt><dd>{source.document_id}</dd><dt>Публикация</dt><dd>{source.published_on ? dateLabel(source.published_on) : 'Точный день не установлен'}. {source.publication_note}</dd><dt>Проверка</dt><dd>{dateLabel(source.checked_on)}</dd><dt>Получение</dt><dd>{source.acquisition}</dd><dt>SHA-256</dt><dd className="discharge-sha">{source.sha256 ?? 'Не вычислена: локальный оригинал не скачан'}</dd><dt>Распространение</dt><dd>{source.redistribution}</dd></dl></div></details>)}</section>
      <aside className="discharge-next"><h2>Следующий шаг к реальному расчёту</h2><p>Запросить паспорт конкретного выпуска и синхронный ряд по хлоридам: координаты, расход стоков и реки, фон и концентрацию на выпуске. Проверить подходящую геометрию и гидрологию отдельно. Подготовленный перечень запроса находится в документации проекта; сообщения никому не отправлялись.</p></aside>
    </>}
  </section>;
}

