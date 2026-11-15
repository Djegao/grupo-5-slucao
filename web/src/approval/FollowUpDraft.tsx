import type { ReactElement } from "react";
import { Button, Text } from "barte-design-system";
import { shortDate, type FollowUpDraftView } from "../components/supplier-request-view";
import { texts } from "../texts";

const t = texts.supplierRequests.draft;

/** #19 Em que ponto está o rascunho: para revisar, enviando, enviado ou com o envio falho. */
export type FollowUpPhase = "review" | "sending" | "sent" | "failed";

/** #19 O motivo do envio falho é um código fechado: o texto de um erro de fora não chega à tela (layer-exposure). */
export type FollowUpFailure = "mailRefused" | "unknown";

export interface FollowUpDraftProps {
  draft: FollowUpDraftView;
  phase: FollowUpPhase;
  /** #19 Só o texto do e-mail se libera para edição; para, assunto, prazo e anexo ficam travados. */
  editing: boolean;
  failure?: FollowUpFailure;
  /** #19 Quando a cobrança saiu, em `sent`. */
  sentOn?: string;
  sentTime?: string;
  onEdit: () => void;
  onBodyChange: (body: string) => void;
  onSend: () => void;
  onDiscard: () => void;
  onRetry: () => void;
}

function Field({ label, children }: { label: string; children: string }): ReactElement {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
      <Text as="span" variant="caption-sm" color="var(--content-tertiary)">
        {label}
      </Text>
      <Text as="span" variant="body-base">
        {children}
      </Text>
    </div>
  );
}

/** #5/AC-4 O rascunho da cobrança no formato do pedido da #3 (para, prazo, assunto, texto, anexo): a cobrança só sai no clique em enviar. */
export function FollowUpDraft(props: FollowUpDraftProps): ReactElement {
  const { draft, phase, editing, failure, sentOn, sentTime, onEdit, onBodyChange, onSend, onDiscard, onRetry } = props;
  if (phase === "sent") {
    return (
      <div role="status">
        <Text as="p" variant="body-base">
          {t.sent(shortDate(sentOn ?? ""), sentTime, shortDate(draft.dueOn))}
        </Text>
      </div>
    );
  }
  const busy = phase === "sending";
  return (
    <section aria-label={t.title} style={{ display: "grid", gap: "var(--spacing-sm)" }}>
      <h4 style={{ margin: 0 }}>{t.title}</h4>
      <Text as="p" variant="caption-sm" color="var(--content-tertiary)">
        {t.subtitle}
      </Text>
      {phase === "failed" ? (
        <div role="alert">
          <Text as="p" variant="body-base">
            {failure === "mailRefused" ? t.failed.mailRefused : t.failed.unknown}
          </Text>
          <Text as="p" variant="caption-sm">
            {t.failedKept}
          </Text>
        </div>
      ) : null}
      <Field label={t.to}>{draft.to}</Field>
      <Field label={t.dueOn}>{shortDate(draft.dueOn)}</Field>
      <Field label={t.subject}>{draft.subject}</Field>
      {editing ? (
        <label style={{ display: "grid", gap: "var(--spacing-2xs)" }}>
          <Text as="span" variant="caption-sm" color="var(--content-tertiary)">
            {t.body}
          </Text>
          <textarea value={draft.body} rows={5} onChange={(event) => onBodyChange(event.target.value)} />
        </label>
      ) : (
        <Field label={t.body}>{draft.body}</Field>
      )}
      <Field label={t.attachment}>{draft.attachmentName}</Field>
      {busy ? (
        <div role="status">
          <Text as="p" variant="body-base">
            {t.sending}
          </Text>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        {phase === "failed" ? (
          <Button variant="fill" size="base" onClick={onRetry}>
            {t.retry}
          </Button>
        ) : (
          <Button variant="fill" size="base" onClick={onSend} disabled={busy}>
            {t.send}
          </Button>
        )}
        {editing ? null : (
          <Button variant="outline" size="base" onClick={onEdit} disabled={busy}>
            {t.edit}
          </Button>
        )}
        <Button variant="outline" size="base" onClick={onDiscard} disabled={busy}>
          {t.discard}
        </Button>
      </div>
    </section>
  );
}
