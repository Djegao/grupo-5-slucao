import type { ReactElement, ReactNode } from "react";

/** Como um campo se compara nos dois lados. Sem estado, o campo só é mostrado, sem julgamento. */
export type ComparisonState = "match" | "divergent" | "missing" | "not-comparable";

export interface ComparisonField {
  key?: string;
  label: ReactNode;
  /** O valor do primeiro lado. `null` aparece como "ausente". */
  a: ReactNode | null;
  /** O valor do segundo lado. `null` aparece como "ausente". */
  b: ReactNode | null;
  state?: ComparisonState;
  /** Explica o estado ao lado dele. */
  note?: ReactNode;
}

export interface ReconciliationDiffProps {
  /** O nome de cada lado, no cabeçalho. */
  columns: readonly [string, string];
  fields: readonly ComparisonField[];
  /** O cabeçalho da coluna dos rótulos. */
  fieldLabel?: string;
  /** Conta quantos campos divergem e quantos conferem, abaixo da tabela. */
  showSummary?: boolean;
  variant?: "grid" | "stacked";
  /** O nome da tabela, para leitor de tela. */
  ariaLabel?: string;
}

const STATE_LABEL: Record<ComparisonState, string> = {
  match: "confere",
  divergent: "divergente",
  missing: "ausente",
  "not-comparable": "não comparável",
};

const ABSENT = "ausente";

const cell = (value: ReactNode | null): ReactNode => (value === null || value === undefined || value === "" ? <span className="bk-diff__absent">{ABSENT}</span> : value);

/** Dois lados do mesmo dado, campo a campo, com o que confere e o que diverge. */
export function ReconciliationDiff({ columns, fields, fieldLabel = "Campo", showSummary, variant = "grid", ariaLabel }: ReconciliationDiffProps): ReactElement {
  const divergent = fields.filter((f) => f.state === "divergent").length;
  const matching = fields.filter((f) => f.state === "match").length;
  return (
    <div className={`bk-diff bk-diff--${variant}`}>
      <div role="table" aria-label={ariaLabel} className="bk-diff__table">
        <div role="row" className="bk-diff__row bk-diff__row--head">
          <span role="columnheader">{fieldLabel}</span>
          <span role="columnheader">{columns[0]}</span>
          <span role="columnheader">{columns[1]}</span>
          <span role="columnheader">Situação</span>
        </div>
        {fields.map((field, index) => (
          <div role="row" key={field.key ?? index} className={`bk-diff__row${field.state ? ` bk-diff__row--${field.state}` : ""}`}>
            <span role="rowheader" className="bk-diff__label">
              {field.label}
            </span>
            <span role="cell">{cell(field.a)}</span>
            <span role="cell">{cell(field.b)}</span>
            <span role="cell" className="bk-diff__state">
              {field.state ? <span className="bk-diff__badge">{STATE_LABEL[field.state]}</span> : null}
              {field.note ? <span className="bk-diff__note">{field.note}</span> : null}
            </span>
          </div>
        ))}
      </div>
      {showSummary ? (
        <p className="bk-diff__summary">
          {divergent} {divergent === 1 ? "campo diverge" : "campos divergem"} · {matching} {matching === 1 ? "confere" : "conferem"}
        </p>
      ) : null}
    </div>
  );
}
