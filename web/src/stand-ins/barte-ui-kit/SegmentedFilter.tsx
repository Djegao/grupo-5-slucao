import { useRef, type KeyboardEvent, type ReactElement } from "react";
import { Pills } from "barte-design-system";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Aparece depois do rótulo: "Todas · 66". Sem ele, só o rótulo. (#53) */
  count?: number;
}

export interface SegmentedFilterProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "base";
  className?: string;
}

/**
 * O filtro em pílulas: um grupo de rádio. A pílula é a `Pills` do design system (cheia no marcado, vazada nos
 * outros), dentro de um botão que leva o foco e o gesto. A classe `SegmentedFilter-module__pill` é a do kit real,
 * que o `GridFilter.css` e os testes miram.
 */
export function SegmentedFilter<T extends string>({ options, value, onChange, ariaLabel, size = "sm", className }: SegmentedFilterProps<T>): ReactElement {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const checked = Math.max(0, options.findIndex((o) => o.value === value));

  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (from + step + options.length) % options.length;
    buttons.current[next]?.focus();
    const option = options[next];
    if (option) onChange(option.value);
  };

  return (
    <div className={className}>
      <div role="radiogroup" aria-label={ariaLabel} className="bk-segmented">
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={index === checked ? 0 : -1}
              className="SegmentedFilter-module__pill__bk bk-segmented__pill"
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => move(event, index)}
            >
              <Pills
                size={size}
                variant={selected ? "fill" : "ghost"}
                state={selected ? "accent" : "default"}
                label={option.count === undefined ? option.label : `${option.label} · ${option.count}`}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
