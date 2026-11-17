/**
 * Barras, linha e linha do tempo, sem biblioteca de gráfico (#53): o kit real usa `recharts`, que o substituto não
 * traz. Cada um mantém o que a tela e os testes leem: o rótulo de acessibilidade, os textos e os números.
 */
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { toneColor, type Tone } from "./tone";

export interface ProgressSegment {
  value: number;
  tone?: Tone;
  label: string;
}

export interface ProgressBarProps {
  segments: readonly ProgressSegment[];
  /** O fundo da barra: o valor que ela completa. (#53) */
  max: number;
  size?: "sm" | "md";
  showLegend?: boolean;
  /** O texto do valor ("R$ 42 mil de R$ 543 mil"): aparece e é o `aria-valuetext`. (#53) */
  valueText?: string;
}

/** Uma barra de progresso em segmentos (o evitado e o em decisão, por exemplo). */
export function ProgressBar({ segments, max, size = "md", showLegend, valueText }: ProgressBarProps): ReactElement {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const percent = (value: number): string => `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`;
  return (
    <div className="bk-progress">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(total, max)}
        {...(valueText ? { "aria-valuetext": valueText } : {})}
        className={`bk-progress__track bk-progress__track--${size}`}
      >
        {segments.map((s) => (
          <span key={s.label} className="bk-progress__segment" style={{ width: percent(s.value), background: toneColor[s.tone ?? "neutral"] }} />
        ))}
      </div>
      {valueText ? <p className="bk-progress__text">{valueText}</p> : null}
      {showLegend ? (
        <ul className="bk-legend">
          {segments.map((s) => (
            <li key={s.label} className="bk-legend__item">
              <span aria-hidden="true" className="bk-legend__swatch" style={{ background: toneColor[s.tone ?? "neutral"] }} />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface LineSeries {
  key: string;
  label: string;
  color?: string;
  dashed?: boolean;
}

export interface LineChartProps {
  data: readonly Record<string, string | number>[];
  xKey: string;
  series: readonly LineSeries[];
  height?: number;
  /** O kit real a usa na dica ao passar o mouse; o substituto não desenha dica. (#53) */
  formatValue?: (value: number) => string;
  formatAxis?: (value: number) => string;
  ariaLabel: string;
}

const WIDTH = 600;
const PAD = { left: 48, right: 12, top: 12, bottom: 24 };

/** Um gráfico de linhas simples, em SVG, com a legenda das séries. */
export function LineChart({ data, xKey, series, height = 220, formatAxis = String, ariaLabel }: LineChartProps): ReactElement {
  const values = data.flatMap((row) => series.map((s) => Number(row[s.key] ?? 0)));
  const top = Math.max(1, ...values);
  const x = (index: number): number => PAD.left + (data.length <= 1 ? 0 : (index / (data.length - 1)) * (WIDTH - PAD.left - PAD.right));
  const y = (value: number): number => height - PAD.bottom - (value / top) * (height - PAD.top - PAD.bottom);
  const colorOf = (s: LineSeries, index: number): string => s.color ?? Object.values(toneColor)[(index + 1) % 5] ?? "currentColor";
  return (
    <div className="bk-linechart">
      <svg role="img" aria-label={ariaLabel} viewBox={`0 0 ${WIDTH} ${height}`} width="100%" height={height}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(top * t)} y2={y(top * t)} stroke="var(--stroke-tertiary)" />
            <text x={PAD.left - 6} y={y(top * t) + 4} textAnchor="end" fontSize="10" fill="var(--content-secondary)">
              {formatAxis(top * t)}
            </text>
          </g>
        ))}
        {data.map((row, index) => (
          <text key={String(row[xKey])} x={x(index)} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--content-secondary)">
            {String(row[xKey])}
          </text>
        ))}
        {series.map((s, si) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={colorOf(s, si)}
            strokeWidth="2"
            {...(s.dashed ? { strokeDasharray: "6 4" } : {})}
            points={data.map((row, index) => `${x(index)},${y(Number(row[s.key] ?? 0))}`).join(" ")}
          />
        ))}
      </svg>
      <ul className="bk-legend">
        {series.map((s, si) => (
          <li key={s.key} className="bk-legend__item">
            <span aria-hidden="true" className="bk-legend__swatch" style={{ background: colorOf(s, si) }} />
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface RankingItem {
  key: string;
  label: string;
  value: number;
  /** Texto menor ao lado do rótulo (a contagem de notas). (#53) */
  meta?: string;
}

export interface RankingBarsProps {
  items: readonly RankingItem[];
  formatValue?: (value: number) => string;
  tone?: Tone;
}

/** Barras horizontais em ordem decrescente, cada uma com o rótulo, o valor e a barra proporcional ao maior. */
export function RankingBars({ items, formatValue = String, tone = "neutral" }: RankingBarsProps): ReactElement {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const top = Math.max(1, ...sorted.map((i) => i.value));
  return (
    <ol className="bk-ranking">
      {sorted.map((item) => (
        <li key={item.key} className="bk-ranking__row">
          <span className="bk-ranking__label">{item.label}</span>
          {item.meta ? <span className="bk-ranking__meta">{item.meta}</span> : null}
          <span className="bk-ranking__value">{formatValue(item.value)}</span>
          <span className="RankingBars-module__track__bk bk-ranking__track">
            <span className="bk-ranking__bar" style={{ width: `${(item.value / top) * 100}%`, background: toneColor[tone] } as CSSProperties} />
          </span>
        </li>
      ))}
    </ol>
  );
}

export interface TimelineItem {
  kind: "event";
  id: string;
  title: ReactNode;
  time?: ReactNode;
  /** O selo de quem fez o passo. (#53) */
  badge?: ReactNode;
  /** O passo foi de um agente (uma regra, o Claude), não de uma pessoa. (#53) */
  byAgent?: boolean;
}

/** Uma linha do tempo vertical: a hora, o que aconteceu e o selo de quem fez. */
export function Timeline({ items, ariaLabel }: { items: readonly TimelineItem[]; ariaLabel: string }): ReactElement {
  return (
    <ol className="bk-timeline" aria-label={ariaLabel}>
      {items.map((item) => (
        <li key={item.id} className={`bk-timeline__item${item.byAgent ? " bk-timeline__item--agent" : ""}`}>
          {item.time ? <span className="bk-timeline__time">{item.time}</span> : null}
          <span className="bk-timeline__title">{item.title}</span>
          {item.badge}
        </li>
      ))}
    </ol>
  );
}
