import type { ReactElement, ReactNode } from "react";
import { Button, Loading, Text } from "barte-design-system";
import { InlineEmpty } from "./display";

/** O estado de uma carga: o que o `LoadFeedback` desenha. */
export type LoadState = "loading" | "ready" | "empty" | "error";

export interface LoadFeedbackProps {
  state: LoadState;
  /** `page` ocupa a área da página; `inline` cabe dentro de um bloco. (#53) */
  size?: "page" | "inline";
  loadingLabel?: string;
  errorTitle?: string;
  errorDescription?: string;
  retryLabel?: string;
  onRetry?: () => void;
  emptyLabel?: ReactNode;
  /** Só em `ready`. Pode ser uma função, chamada apenas então. (#53) */
  children?: ReactNode | (() => ReactNode);
}

/** O carregando, o erro com "tentar de novo", o vazio e, pronto, o conteúdo. */
export function LoadFeedback({
  state,
  size = "page",
  loadingLabel,
  errorTitle,
  errorDescription,
  retryLabel,
  onRetry,
  emptyLabel,
  children,
}: LoadFeedbackProps): ReactElement | null {
  if (state === "loading") {
    return (
      <div role="status" className={`bk-feedback bk-feedback--${size}`}>
        <Loading type={size === "page" ? "page" : "icon"} {...(loadingLabel ? { description: loadingLabel } : {})} />
        {size === "page" ? null : loadingLabel}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div role="alert" className={`bk-feedback bk-feedback--${size}`}>
        {errorTitle ? (
          <Text variant="label-lg" color="var(--content-primary)">
            {errorTitle}
          </Text>
        ) : null}
        {errorDescription ? (
          <Text variant="body-sm" color="var(--content-secondary)">
            {errorDescription}
          </Text>
        ) : null}
        {onRetry && retryLabel ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : null}
      </div>
    );
  }
  if (state === "empty") return <InlineEmpty>{emptyLabel}</InlineEmpty>;
  return <>{typeof children === "function" ? children() : children}</>;
}
