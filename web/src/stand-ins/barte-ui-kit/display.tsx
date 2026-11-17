/**
 * Os blocos de leitura do kit (#53): painel, bloco, lista de rótulo e valor, selos, números, cabeçalho de página.
 *
 * Os nomes de classe `StatusBadge-module__*` e `RankingBars-module__track` imitam, de propósito, os do kit real: a
 * tela (app.css, GridBadge.css) e os testes a miram por eles. Sem o sufixo de hash, só o prefixo, que é o que
 * `[class*="…"]` e as regex dos testes casam.
 */
import { type CSSProperties, type ReactElement, type ReactNode } from "react";
import { toneColor, type Tone } from "./tone";

const join = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(" ");

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Ao lado do título (um selo, uma ação). (#53) */
  aside?: ReactNode;
  size?: "sm" | "md";
  padding?: "sm" | "md" | "lg";
  className?: string;
  children?: ReactNode;
}

/** Uma caixa com título, descrição e conteúdo. */
export function Panel({ title, description, aside, size = "md", padding = "md", className, children }: PanelProps): ReactElement {
  return (
    <div className={join("bk-panel", `bk-panel--${size}`, `bk-panel--pad-${padding}`, className)}>
      {title || aside ? (
        <div className="bk-panel__head">
          {title ? <h2 className="bk-panel__title">{title}</h2> : <span />}
          {aside}
        </div>
      ) : null}
      {description ? <p className="bk-panel__description">{description}</p> : null}
      <div className="bk-panel__body">{children}</div>
    </div>
  );
}

export interface BlockProps {
  title?: ReactNode;
  description?: ReactNode;
  size?: "overline" | "sm" | "md";
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  className?: string;
  children?: ReactNode;
}

/** Uma seção dentro de uma caixa: um título menor e o conteúdo. */
export function Block({ title, description, size = "md", headingLevel = 3, className, children }: BlockProps): ReactElement {
  const Heading = `h${headingLevel}` as "h3";
  return (
    <div className={join("bk-block", `bk-block--${size}`, className)}>
      {title ? <Heading className="bk-block__title">{title}</Heading> : null}
      {description ? <p className="bk-block__description">{description}</p> : null}
      {children}
    </div>
  );
}

export interface DataListItem {
  key?: string;
  label: ReactNode;
  value: ReactNode;
  /** O valor em destaque. (#53) */
  emphasis?: boolean;
  /** O valor em fonte de código. (#53) */
  mono?: boolean;
}

export interface DataListProps {
  items: readonly DataListItem[];
  divided?: boolean;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}

/** Pares de rótulo e valor, um por linha. */
export function DataList({ items, divided, size = "md", className, "aria-label": ariaLabel }: DataListProps): ReactElement {
  return (
    <ul className={join("bk-datalist", divided && "bk-datalist--divided", `bk-datalist--${size}`, className)} aria-label={ariaLabel}>
      {items.map((item, index) => (
        <li key={item.key ?? index} className="bk-datalist__row">
          <span className="bk-datalist__label">{item.label}</span>
          <span className={join("bk-datalist__value", item.emphasis && "bk-datalist__value--emphasis", item.mono && "bk-datalist__value--mono")}>
            {item.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** O texto de "não há nada aqui", de uma linha. */
export function InlineEmpty({ children }: { children?: ReactNode }): ReactElement {
  return <p className="bk-inline-empty">{children}</p>;
}

export interface StatusBadgeProps {
  tone?: Tone;
  variant?: "soft" | "solid";
  size?: "sm" | "md" | "pill";
  className?: string;
  children?: ReactNode;
}

/** O selo de status: um tom, suave ou cheio, com o texto dentro. */
export function StatusBadge({ tone = "neutral", variant = "soft", size = "md", className, children }: StatusBadgeProps): ReactElement {
  return (
    <span
      className={join(
        "bk-badge",
        `StatusBadge-module__${size}__bk`,
        `StatusBadge-module__${variant}__bk`,
        `StatusBadge-module__${tone}__bk`,
        className,
      )}
    >
      <span className="StatusBadge-module__label__bk">{children}</span>
    </span>
  );
}

export interface AiSourceBadgeProps {
  source: "ai" | "rule" | "person";
  label: string;
  size?: "sm" | "md";
}

/** O selo de quem produziu o conteúdo (o agente, uma regra, uma pessoa). */
export function AiSourceBadge({ source, label, size = "md" }: AiSourceBadgeProps): ReactElement {
  return (
    <span className={join("bk-source", `bk-source--${source}`, `bk-source--${size}`)}>
      <span aria-hidden="true" className="bk-source__mark" />
      {label}
    </span>
  );
}

export interface StatProps {
  caption: ReactNode;
  value: ReactNode;
  context?: ReactNode;
  tone?: Tone;
  /** O texto explicativo, atrás do botão de informação. (#53) */
  info?: string;
  /** O nome do botão de informação, para leitor de tela. (#53) */
  infoLabel?: string;
}

/** Um número com a legenda e o contexto. */
export function Stat({ caption, value, context, tone = "neutral", info, infoLabel }: StatProps): ReactElement {
  return (
    <div className="bk-stat" style={{ "--stat-tone": toneColor[tone] } as CSSProperties}>
      <p className="bk-stat__caption">
        {caption}
        {info ? (
          <button type="button" className="bk-stat__info" aria-label={infoLabel ?? "Mais informação"} title={info}>
            i
          </button>
        ) : null}
      </p>
      <p className="bk-stat__value">{value}</p>
      {context ? <p className="bk-stat__context">{context}</p> : null}
    </div>
  );
}

/** Os números lado a lado, em `columns` colunas. */
export function StatGrid({ columns = 3, children }: { columns?: number; children?: ReactNode }): ReactElement {
  return (
    <div className="bk-statgrid" style={{ "--stat-columns": String(columns) } as CSSProperties}>
      {children}
    </div>
  );
}

export interface PageTitleBarProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Ao lado do título: um filtro, um seletor. (#53) */
  actions?: ReactNode;
  variant?: "compact" | "default";
}

/** O cabeçalho da página: o título (h1), o subtítulo e as ações. */
export function PageTitleBar({ title, subtitle, actions, variant = "default" }: PageTitleBarProps): ReactElement {
  return (
    <header className={join("bk-titlebar", `bk-titlebar--${variant}`)}>
      <div className="bk-titlebar__text">
        <h1 className="bk-titlebar__title">
          {title}
        </h1>
        {subtitle ? <p className="bk-titlebar__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="bk-titlebar__actions">{actions}</div> : null}
    </header>
  );
}
