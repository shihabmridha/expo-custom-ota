import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * Small, dependency-free SVG charts for the Devices tab.
 *
 * Colors come from the `--viz-*` tokens in `index.css`, so light and dark mode
 * are each chosen rather than flipped. Text always uses ink colors; a colored
 * swatch beside it carries series identity. Every chart pairs its plot with a
 * screen-reader table, since a picture of numbers is not the numbers.
 */

const number = new Intl.NumberFormat();
export const formatCount = (n: number) => number.format(n);
export const formatPercent = (fraction: number) =>
  `${Number((fraction * 100).toFixed(fraction < 0.1 ? 1 : 0))}%`;

/** "Oct 7" for a `YYYY-MM-DD` UTC day. */
export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Rendered width of an element, so SVG text is laid out at real pixels. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Round ticks from zero to a clean ceiling at or above `max`. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let value = 0; value < max + step; value += step) {
    ticks.push(Math.round(value));
    if (value >= max) break;
  }
  return [...new Set(ticks)];
}

export function Swatch({ color, hatched = false }: { color: string; hatched?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-sm"
      style={{
        background: hatched
          ? `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 4px)`
          : color,
        boxShadow: hatched ? `inset 0 0 0 1px ${color}` : undefined,
      }}
    />
  );
}

function LineKey({ color }: { color: string }) {
  return (
    <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: color }} />
  );
}

function Tooltip({ x, children, width }: { x: number; children: ReactNode; width: number }) {
  // Flip to the left of the crosshair once it would overflow the plot.
  const flip = x > width - 170;
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
      style={flip ? { right: width - x + 10 } : { left: x + 10 }}
    >
      {children}
    </div>
  );
}

// --- Rollout curve -----------------------------------------------------------

export interface RolloutPoint {
  day: string;
  /** Cumulative installs we sent the update to. */
  sent: number;
  /** Cumulative installs that reported running it. */
  launched: number;
}

const MARGIN = { top: 16, right: 16, bottom: 26, left: 44 };

/**
 * Cumulative "sent" and "launched" installs per day, against the cohort's active
 * install count. The gap between the two lines is the delivery problem worth
 * investigating; the gap to the reference line is who has not checked in yet.
 */
export function RolloutChart({
  points,
  reference,
  height = 220,
}: {
  points: RolloutPoint[];
  reference: { value: number; label: string } | null;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const peak = Math.max(reference?.value ?? 0, ...points.map((p) => Math.max(p.sent, p.launched)));
  const ticks = niceTicks(peak);
  const yMax = ticks[ticks.length - 1] ?? 1;

  const x = (i: number) =>
    MARGIN.left + (points.length <= 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth);
  const y = (value: number) => MARGIN.top + plotHeight - (value / yMax) * plotHeight;

  const path = (key: 'sent' | 'launched') =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p[key])}`).join('');
  const area =
    points.length > 1 ? `${path('launched')}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z` : '';

  const onMove = useCallback(
    (event: React.PointerEvent<SVGRectElement>) => {
      if (points.length === 0) return;
      const box = event.currentTarget.getBoundingClientRect();
      const ratio = (event.clientX - box.left) / box.width;
      setHover(Math.round(ratio * (points.length - 1)));
    },
    [points.length],
  );

  const xLabels =
    points.length <= 1
      ? points.map((_, i) => i)
      : [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const last = points[points.length - 1];
  const hovered = hover === null ? null : points[hover];

  return (
    <figure className="m-0">
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
        <span className="inline-flex items-center gap-1.5">
          <LineKey color="var(--viz-latest)" /> Launched
        </span>
        <span className="inline-flex items-center gap-1.5">
          <LineKey color="var(--viz-context)" /> Sent
        </span>
      </div>
      <div ref={ref} className="relative">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={
              last
                ? `${formatCount(last.launched)} installs launched and ${formatCount(last.sent)} sent by ${formatDay(last.day)}`
                : 'No rollout activity yet'
            }
            className="block overflow-visible"
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={MARGIN.left}
                  x2={width - MARGIN.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="var(--viz-grid)"
                />
                <text
                  x={MARGIN.left - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-neutral-500 text-[11px] tabular-nums"
                >
                  {formatCount(tick)}
                </text>
              </g>
            ))}

            {reference && reference.value > 0 && (
              <g>
                <line
                  x1={MARGIN.left}
                  x2={width - MARGIN.right}
                  y1={y(reference.value)}
                  y2={y(reference.value)}
                  stroke="currentColor"
                  className="text-neutral-400 dark:text-neutral-500"
                />
                <text
                  x={width - MARGIN.right}
                  y={y(reference.value) - 6}
                  textAnchor="end"
                  className="fill-neutral-600 text-[11px] dark:fill-neutral-400"
                >
                  {reference.label}
                </text>
              </g>
            )}

            {area && <path d={area} fill="var(--viz-wash)" />}
            {points.length > 1 && (
              <>
                <path
                  d={path('sent')}
                  fill="none"
                  stroke="var(--viz-context)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <path
                  d={path('launched')}
                  fill="none"
                  stroke="var(--viz-latest)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </>
            )}

            {last &&
              (['sent', 'launched'] as const).map((key) => (
                <circle
                  key={key}
                  cx={x(points.length - 1)}
                  cy={y(last[key])}
                  r={4}
                  fill={key === 'sent' ? 'var(--viz-context)' : 'var(--viz-latest)'}
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                />
              ))}

            {xLabels.map((i) => (
              <text
                key={i}
                x={x(i)}
                y={height - 6}
                textAnchor={
                  points.length <= 1
                    ? 'middle'
                    : i === 0
                      ? 'start'
                      : i === points.length - 1
                        ? 'end'
                        : 'middle'
                }
                className="fill-neutral-500 text-[11px]"
              >
                {points[i] ? formatDay(points[i].day) : ''}
              </text>
            ))}

            {hovered && hover !== null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={MARGIN.top}
                y2={MARGIN.top + plotHeight}
                stroke="currentColor"
                className="text-neutral-300 dark:text-neutral-600"
              />
            )}
            <rect
              x={MARGIN.left}
              y={MARGIN.top}
              width={plotWidth}
              height={plotHeight}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}
        {hovered && hover !== null && (
          <Tooltip x={x(hover)} width={width}>
            <p className="mb-1 font-medium">{formatDay(hovered.day)}</p>
            <p className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5">
                <LineKey color="var(--viz-latest)" /> Launched
              </span>
              <span className="tabular-nums">{formatCount(hovered.launched)}</span>
            </p>
            <p className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5">
                <LineKey color="var(--viz-context)" /> Sent
              </span>
              <span className="tabular-nums">{formatCount(hovered.sent)}</span>
            </p>
          </Tooltip>
        )}
      </div>
      <table className="sr-only">
        <caption>Cumulative installs per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Sent</th>
            <th>Launched</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.day}>
              <td>{p.day}</td>
              <td>{p.sent}</td>
              <td>{p.launched}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

// --- Composition bar ---------------------------------------------------------

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
  hatched?: boolean;
  /** Extra lines for the legend row, e.g. the releases folded into "Older". */
  detail?: string;
}

/**
 * One horizontal bar split into parts of a whole, with a legend that carries
 * the numbers. Segments are separated by a 2px surface gap, not a stroke.
 */
export function CompositionBar({ segments }: { segments: Segment[] }) {
  const [active, setActive] = useState<string | null>(null);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const visible = segments.filter((s) => s.value > 0);

  if (total === 0) {
    return <p className="text-sm text-neutral-500">No active installs in this window.</p>;
  }

  return (
    <div>
      <div
        className="flex h-5 gap-0.5"
        role="img"
        aria-label={visible.map((s) => `${s.label} ${s.value}`).join(', ')}
      >
        {visible.map((segment) => (
          <div
            key={segment.key}
            className="min-w-1 transition-opacity first:rounded-l last:rounded-r"
            style={{
              flexGrow: segment.value,
              flexBasis: 0,
              background: segment.hatched
                ? `repeating-linear-gradient(135deg, ${segment.color} 0 3px, transparent 3px 6px)`
                : segment.color,
              boxShadow: segment.hatched ? `inset 0 0 0 1px ${segment.color}` : undefined,
              opacity: active && active !== segment.key ? 0.35 : 1,
            }}
            onPointerEnter={() => setActive(segment.key)}
            onPointerLeave={() => setActive(null)}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {segments.map((segment) => (
          <li
            key={segment.key}
            className={`-mx-1 flex min-w-0 items-baseline gap-2 rounded px-1 ${active === segment.key ? 'bg-neutral-100 dark:bg-neutral-800' : ''}`}
            onPointerEnter={() => setActive(segment.key)}
            onPointerLeave={() => setActive(null)}
          >
            <Swatch color={segment.color} hatched={segment.hatched} />
            <span className="min-w-0 flex-1">
              {segment.label}
              {segment.detail && (
                <span className="block text-xs text-neutral-500">{segment.detail}</span>
              )}
            </span>
            <span className="tabular-nums">{formatCount(segment.value)}</span>
            <span className="w-12 text-right text-xs text-neutral-500 tabular-nums">
              {formatPercent(segment.value / total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A thin progress track for compact lists; the track is a lighter step of the
 * fill. Decorative: every use sits beside the same value as visible text.
 */
export function Meter({ fraction }: { fraction: number | null }) {
  return (
    <div
      aria-hidden
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: 'color-mix(in srgb, var(--viz-embedded) 35%, transparent)' }}
    >
      {fraction !== null && (
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, fraction * 100)}%`, background: 'var(--viz-latest)' }}
        />
      )}
    </div>
  );
}

// --- Stacked daily columns ---------------------------------------------------

export interface ColumnSeries {
  key: string;
  label: string;
  color: string;
}

export function DailyColumns({
  days,
  series,
  height = 180,
}: {
  days: { day: string; values: Record<string, number> }[];
  series: ColumnSeries[];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const margin = { top: 8, right: 8, bottom: 22, left: 40 };
  const plotWidth = Math.max(0, width - margin.left - margin.right);
  const plotHeight = height - margin.top - margin.bottom;
  const totals = days.map((d) => series.reduce((sum, s) => sum + (d.values[s.key] ?? 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals), 3);
  const yMax = ticks[ticks.length - 1] ?? 1;
  const band = days.length > 0 ? plotWidth / days.length : 0;
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const y = (value: number) => margin.top + plotHeight - (value / yMax) * plotHeight;
  const hovered = hover === null ? null : days[hover];

  return (
    <figure className="m-0">
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <Swatch color={s.color} /> {s.label}
          </span>
        ))}
      </div>
      <div ref={ref} className="relative">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Update checks per day"
            className="block"
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={margin.left}
                  x2={width - margin.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="var(--viz-grid)"
                />
                <text
                  x={margin.left - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-neutral-500 text-[11px] tabular-nums"
                >
                  {formatCount(tick)}
                </text>
              </g>
            ))}
            {days.map((d, i) => {
              const cx = margin.left + band * i + band / 2;
              let base = 0;
              const parts = series
                .map((s) => ({ s, value: d.values[s.key] ?? 0 }))
                .filter((p) => p.value > 0);
              return (
                <g key={d.day} opacity={hover !== null && hover !== i ? 0.45 : 1}>
                  {parts.map(({ s, value }, index) => {
                    const top = y(base + value);
                    // A 2px surface gap between stacked segments.
                    const bottom = y(base) - (index > 0 ? 2 : 0);
                    base += value;
                    const h = Math.max(0, bottom - top);
                    const isTop = index === parts.length - 1;
                    const r = isTop ? Math.min(4, h, barWidth / 2) : 0;
                    const left = cx - barWidth / 2;
                    return (
                      <path
                        key={s.key}
                        fill={s.color}
                        d={`M${left},${bottom}V${top + r}Q${left},${top} ${left + r},${top}H${left + barWidth - r}Q${left + barWidth},${top} ${left + barWidth},${top + r}V${bottom}Z`}
                      />
                    );
                  })}
                </g>
              );
            })}
            {days.length > 0 &&
              [0, days.length - 1].map((i) => (
                <text
                  key={i}
                  x={margin.left + band * i + band / 2}
                  y={height - 6}
                  textAnchor={i === 0 ? 'start' : 'end'}
                  className="fill-neutral-500 text-[11px]"
                >
                  {formatDay(days[i]!.day)}
                </text>
              ))}
            <rect
              x={margin.left}
              y={margin.top}
              width={plotWidth}
              height={plotHeight}
              fill="transparent"
              onPointerMove={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const index = Math.floor(((event.clientX - box.left) / box.width) * days.length);
                setHover(Math.max(0, Math.min(days.length - 1, index)));
              }}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}
        {hovered && hover !== null && (
          <Tooltip x={margin.left + band * hover + band / 2} width={width}>
            <p className="mb-1 font-medium">{formatDay(hovered.day)}</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <Swatch color={s.color} /> {s.label}
                </span>
                <span className="tabular-nums">{formatCount(hovered.values[s.key] ?? 0)}</span>
              </p>
            ))}
          </Tooltip>
        )}
      </div>
      <table className="sr-only">
        <caption>Update checks per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              {series.map((s) => (
                <td key={s.key}>{d.values[s.key] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Horizontal bars for a handful of labelled counts; the value sits at the bar tip. */
export function LabelledBars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.label} className="text-sm">
          <div className="mb-1 text-xs text-neutral-600 dark:text-neutral-400">{row.label}</div>
          <div className="flex items-center gap-2">
            <div className="h-3 flex-1">
              <div
                className="h-full rounded-r"
                style={{
                  width: `${(row.value / max) * 100}%`,
                  minWidth: row.value > 0 ? 2 : 0,
                  background: 'var(--viz-older)',
                }}
              />
            </div>
            <span className="w-14 text-right tabular-nums">{formatCount(row.value)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
