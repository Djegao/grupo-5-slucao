import type { ReactElement } from "react";
import { Button, Text } from "barte-design-system";
import { shortDate, type FollowUpDraftView } from "../components/supplier-request-view";
import { texts } from "../texts";

const t = texts.supplierRequests.draft;

/** #19 Em que ponto está o rascunho: para revisar, enviando, enviado ou com o envio falho. */
export type FollowUpPhase = FollowUpPhaseState["phase"];

/** #19 O motivo do envio falho é um código fechado: o texto de um erro de fora não chega à tela (layer-exposure). */
export type FollowUpFailure = "mailRefused" | "unknown";

/** #19 O que cada fase exige: `sent` traz quando saiu e `failed` traz o motivo, então nenhuma tela desenha data ou motivo vazio. */
export type FollowUpPhaseState =
  | { phase: "review" }
  | { phase: "sending" }
  | { phase: "sent"; sentOn: string; sentTime?: string }
  | { phase: "failed"; failure: FollowUpFailure };

export type FollowUpDraftProps = FollowUpDraftBaseProps & FollowUpPhaseState;

interface FollowUpDraftBaseProps {
  draft: FollowUpDraftView;
  /** #19 Só o texto do e-mail se libera para edição; para, assunto, prazo e anexo ficam travados. */
  editing: boolean;
  /** #21 Sem `onEdit`, o texto não se edita e o botão "Editar" não existe: o envio da cobrança não leva texto (o servidor manda o rascunho que guarda, #36). */
  onEdit?: () => void;
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
  const { draft, editing, onEdit, onBodyChange, onSend, onDiscard, onRetry } = props;
  const phase = props.phase;
  if (props.phase === "sent") {
    return (
      <div role="status">
        <Text as="p" variant="body-base">
          {t.sent(shortDate(props.sentOn), props.sentTime, shortDate(draft.dueOn))}
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
      {props.phase === "failed" ? (
        <div role="alert">
          <Text as="p" variant="body-base">
            {props.failure === "mailRefused" ? t.failed.mailRefused : t.failed.unknown}
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
        {editing || onEdit === undefined ? null : (
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
