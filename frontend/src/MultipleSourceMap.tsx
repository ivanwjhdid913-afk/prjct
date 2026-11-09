import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./controlPoints.css";
import { riverCoordinate } from "./riverCoordinate";
import type { ControlPoint } from "./analysisSettings";
import type { Line, MultipleResult, Reach } from "./multipleSources";

export type MapSource = {
  id: string;
  name: string;
  source_distance_m: number;
  number?: number;
};

export function concentrationColor(value: number, scale: [number, number]) {
  const fraction =
    scale[1] === scale[0]
      ? 0.5
      : Math.min(1, Math.max(0, (value - scale[0]) / (scale[1] - scale[0])));
  const palette = [
    [36, 101, 180],
    [22, 166, 176],
    [225, 212, 90],
    [239, 138, 52],
    [185, 31, 82],
  ];
  const position = fraction * 4;
  const index = Math.min(3, Math.floor(position));
  return `rgb(${palette[index].map((value, channel) => Math.round(value + (palette[index + 1][channel] - value) * (position - index))).join(", ")})`;
}

/** Cut by ellipsoidal chainage, retaining every original bend within a segment. */
export function previewSegmentGeometries(reach: Reach): Line[] {
  return Array.from({ length: 100 }, (_, index) => {
    const start = (reach.length_m * index) / 100;
    const end = (reach.length_m * (index + 1)) / 100;
    const interior = reach.geometry.coordinates.filter(
      (_, vertex) =>
        reach.distances_m[vertex] > start && reach.distances_m[vertex] < end,
    );
    return {
      type: "LineString",
      coordinates: [
        riverCoordinate(reach.geometry.coordinates, reach.distances_m, start),
        ...interior,
        riverCoordinate(reach.geometry.coordinates, reach.distances_m, end),
      ],
    };
  });
}

/** Fit only after an explicit layout change, never on time or A/B switching. */
function fitVisibleReach(instance: L.Map, reach: Reach, element: HTMLElement) {
  const bounds = element.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const panel = element
    .closest(".multiple-stage")
    ?.querySelector<HTMLElement>(".multiple-profile");
  const cover = panel && !panel.hidden ? panel.getBoundingClientRect() : null;
  const bottom = cover && cover.left < bounds.right && cover.right > bounds.left
    ? Math.max(0, Math.min(bounds.bottom, cover.bottom) - Math.max(bounds.top, cover.top))
    : 0;
  const exposedHeight = bounds.height - bottom;
  const topPadding = bottom ? Math.min(36, Math.floor(exposedHeight / 3)) : 45;
  const bottomPadding = bottom ? Math.min(22, Math.floor(exposedHeight / 5)) : 45;
  instance.invalidateSize({ pan: false });
  instance.fitBounds(
    reach.geometry.coordinates.map(([lon, lat]) => [lat, lon] as L.LatLngTuple),
    {
      paddingTopLeft: [45, topPadding],
      paddingBottomRight: [45, bottom + bottomPadding],
      animate: false,
    },
  );
}

type Props = {
  reach: Reach | null;
  result: MultipleResult | null;
  values: number[] | null;
  scale: [number, number];
  sources: MapSource[];
  selectedSource: string;
  selectedSegment: number;
  picking: boolean;
  profileOpen: boolean;
  suspended: boolean;
  onSource: (id: string) => void;
  onSegment: (index: number) => void;
  onPick: (lon: number, lat: number) => void;
  controlPoints?: ControlPoint[];
  selectedControlPointId?: string | null;
  onControlPointSelect?: (point: ControlPoint) => void;
};

export default function MultipleSourceMap({
  reach,
  result,
  values,
  scale,
  sources,
  selectedSource,
  selectedSegment,
  picking,
  profileOpen,
  suspended,
  onSource,
  onSegment,
  onPick,
  controlPoints = [],
  selectedControlPointId = null,
  onControlPointSelect,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const segments = useRef<L.Polyline[]>([]);
  const pins = useRef<L.Marker[]>([]);
  const pointPins = useRef<L.Marker[]>([]);
  const [tileError, setTileError] = useState(false);
  const calls = useRef({
    onSource,
    onSegment,
    onPick,
    picking,
    onControlPointSelect,
  });
  calls.current = {
    onSource,
    onSegment,
    onPick,
    picking,
    onControlPointSelect,
  };
  const key = reach
    ? JSON.stringify([
        reach.id,
        reach.geometry,
        reach.length_m,
        reach.distances_m,
      ])
    : "";
  const preview = useMemo(
    () => (reach ? previewSegmentGeometries(reach) : []),
    [key],
  );
  const geometries = result?.segment_geometries ?? preview;
  const segmentKey = JSON.stringify(geometries);

  useEffect(() => {
    if (!host.current || !reach) return;
    setTileError(false);
    const instance = L.map(host.current, {
      zoomControl: false,
      scrollWheelZoom: false,
      zoomAnimation: false,
      fadeAnimation: false,
    });
    map.current = instance;
    instance.attributionControl.setPrefix(false);
    instance.attributionControl.setPosition("bottomleft");
    L.control
      .zoom({
        zoomInTitle: "Увеличить масштаб",
        zoomOutTitle: "Уменьшить масштаб",
      })
      .addTo(instance);
    const points = reach.geometry.coordinates.map(
      ([lon, lat]) => [lat, lon] as L.LatLngTuple,
    );
    instance.setView(points[0], 12);
    const tiles = L.tileLayer(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    ).addTo(instance);
    tiles.on("tileerror", () => setTileError(true));
    L.polyline(points, {
      color: "#fff",
      weight: 16,
      interactive: false,
      smoothFactor: 0,
    }).addTo(instance);
    L.polyline(points, {
      color: "#416b7b",
      weight: 11,
      interactive: false,
      smoothFactor: 0,
      className: "multiple-river-centerline",
    }).addTo(instance);
    L.control
      .scale({ imperial: false, position: "bottomleft" })
      .addTo(instance);
    instance.on("click", (event) => {
      if (calls.current.picking)
        calls.current.onPick(event.latlng.lng, event.latlng.lat);
    });
    const element = host.current;
    let lastSize = "";
    const observer = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      const size = `${element.clientWidth}x${element.clientHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      fitVisibleReach(instance, reach, element);
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      segments.current = [];
      pins.current = [];
      pointPins.current = [];
      instance.remove();
      map.current = null;
    };
  }, [key]);

  useEffect(() => {
    if (!reach || !map.current || !host.current) return;
    const frame = requestAnimationFrame(() => {
      if (map.current && host.current)
        fitVisibleReach(map.current, reach, host.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [key, profileOpen]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    segments.current.forEach((segment) => segment.remove());
    segments.current = geometries.map((line, index) =>
      L.polyline(
        line.coordinates.map(([lon, lat]) => [lat, lon] as L.LatLngTuple),
        {
          weight: 9,
          color: "#416b7b",
          smoothFactor: 0,
          className: result
            ? "simulation-segment"
            : "simulation-preview-segment",
        },
      )
        .addTo(instance)
        .on("click", (event) => {
          if (calls.current.picking)
            calls.current.onPick(event.latlng.lng, event.latlng.lat);
          else calls.current.onSegment(index);
          L.DomEvent.stopPropagation(event);
        }),
    );
    return () => {
      segments.current.forEach((segment) => segment.remove());
      segments.current = [];
    };
  }, [key, segmentKey, !!result]);

  useEffect(() => {
    segments.current.forEach((line, index) =>
      line.setStyle({
        color: values
          ? concentrationColor(values[index], scale)
          : index === selectedSegment
            ? "#174c45"
            : "#416b7b",
        opacity: values || index === selectedSegment ? 1 : 0.65,
        weight: index === selectedSegment ? 13 : 9,
      }),
    );
  }, [values, scale, selectedSegment, key, segmentKey, !!result]);

  const sourceKey = JSON.stringify(sources);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !reach) return;
    pins.current.forEach((pin) => pin.remove());
    pins.current = sources.map((source, index) => {
      const [lon, lat] = riverCoordinate(
        reach.geometry.coordinates,
        reach.distances_m,
        source.source_distance_m,
      );
      const sourceNumber = source.number ?? index + 1;
      const coincident = sources
        .slice(0, index)
        .filter(
          (other) =>
            Math.abs(other.source_distance_m - source.source_distance_m) < 0.01,
        ).length;
      return L.marker([lat, lon], {
        keyboard: true,
        title: `Сценарный источник ${sourceNumber}: ${source.name}`,
        alt: `Выбрать источник ${sourceNumber}`,
        zIndexOffset: source.id === selectedSource ? 1000 : 0,
        icon: L.divIcon({
          className: `multiple-map-source${source.id === selectedSource ? " is-selected" : ""}`,
          html: `<span class="multiple-source-dot" style="left:${11 - coincident * 32}px"></span><span class="multiple-source-number">${sourceNumber}</span>`,
          iconSize: [30, 35],
          iconAnchor: [15 - coincident * 32, 30],
        }),
      })
        .addTo(instance)
        .on("click", (event) => {
          calls.current.onSource(source.id);
          L.DomEvent.stopPropagation(event);
        });
    });
    return () => {
      pins.current.forEach((pin) => pin.remove());
      pins.current = [];
    };
  }, [key, sourceKey, selectedSource]);

  const pointsKey = JSON.stringify(controlPoints);
  const compactPointLabels = profileOpen && matchMedia("(max-width:760px)").matches;
  useEffect(() => {
    const instance = map.current;
    if (!instance || !reach) return;
    pointPins.current.forEach((pin) => pin.remove());
    pointPins.current = controlPoints.map((point, index) => {
      const [lon, lat] = riverCoordinate(
        reach.geometry.coordinates,
        reach.distances_m,
        (reach.length_m * (point.segment_index + 0.5)) / 100,
      );
      return L.marker([lat, lon], {
        keyboard: true,
        title: `Контрольная точка К${index + 1}: ${point.name}`,
        alt: `Выбрать контрольную точку К${index + 1}`,
        zIndexOffset: point.id === selectedControlPointId ? 1200 : 200,
        icon: L.divIcon({
          className: `multiple-map-control-point${point.id === selectedControlPointId ? " is-selected" : ""}`,
          html: `<span class="control-point-pin">К${index + 1}</span>`,
          iconSize: [32, 32],
          iconAnchor: compactPointLabels ? [-12, 16] : [16, -5],
        }),
      })
        .addTo(instance)
        .on("click", (event) => {
          if (calls.current.onControlPointSelect)
            calls.current.onControlPointSelect(point);
          else calls.current.onSegment(point.segment_index);
          L.DomEvent.stopPropagation(event);
        });
    });
    return () => {
      pointPins.current.forEach((pin) => pin.remove());
      pointPins.current = [];
    };
  }, [key, pointsKey, selectedControlPointId, compactPointLabels]);

  useEffect(() => {
    if (picking) host.current?.focus({ preventScroll: true });
  }, [picking]);
  return (
    <div
      className={`multiple-map${picking ? " is-picking" : ""}`}
      inert={suspended}
    >
      <div
        ref={host}
        className="point-map"
        tabIndex={-1}
        aria-label="Полный участок реки, сценарные источники и контрольные точки"
      />
      {tileError && (
        <p className="map-caption">
          Подложка недоступна. Русло и метки показаны независимо от неё.
        </p>
      )}
      {!reach && (
        <p className="multiple-map-empty">Загружаем подготовленное русло…</p>
      )}
    </div>
  );
}
