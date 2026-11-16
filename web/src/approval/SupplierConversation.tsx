import type { ReactElement } from "react";
import { Button, Text } from "barte-design-system";
import { formatCurrency } from "@barte-ai-services/barte-ui-kit";
import { GridBadge } from "../components/GridBadge";
import { shortDate, type SupplierBlockStatus, type SupplierConversationView, type SupplierNextStep } from "../components/supplier-request-view";
import { texts } from "../texts";

const t = texts.supplierRequests.conversation;

/** #19 O tom do selo do cabeçalho do bloco. */
const BLOCK_TONE: Record<SupplierBlockStatus, "waiting" | "positive" | "negative" | "info"> = {
  waiting: "waiting",
  waitingCharged: "waiting",
  late: "negative",
  fulfilledToConfirm: "info",
  fulfilled: "positive",
  partiallyFulfilled: "waiting",
  needsYou: "info",
  refused: "negative",
};

export interface SupplierConversationProps {
  conversation: SupplierConversationView;
  /** #5/AC-3 O botão do próximo passo da leitura; quem confirma, encerra ou cobra é sempre uma pessoa. */
  onNextStep: (step: SupplierNextStep) => void;
}

/**
 * #19 A conversa do bloco "Pedido ao fornecedor" (história #5): pedido enviado, resposta do fornecedor e leitura do agente.
 * #19 Cabe dentro do bloco da #3, abaixo da decisão registrada; o pedido e o e-mail em si são da #3.
 * #19 O texto do fornecedor é dado: sai como texto, nunca como marcação, e não muda decisão, título nem valor.
 */
export function SupplierConversation({ conversation, onNextStep }: SupplierConversationProps): ReactElement {
  const { status, sent, reply, asOf, reading } = conversation;
  const nextStep = reading.nextStep;
  return (
    <section aria-label={t.title} style={{ display: "grid", gap: "var(--spacing-md)" }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", margin: 0 }}>
        <Text as="span" variant="label-lg">
          {t.title}
        </Text>
        <GridBadge tone={BLOCK_TONE[status]}>{t.blockStatus[status]}</GridBadge>
      </h3>

      <div>
        <h4 style={{ margin: 0 }}>{t.sentTitle}</h4>
        <Text as="p" variant="body-base">
          {t.sent(sent.document, formatCurrency(sent.amountCents / 100), shortDate(sent.sentOn), sent.sentTime, shortDate(sent.dueOn))}
        </Text>
        {sent.viewHref ? <a href={sent.viewHref}>{t.viewSent}</a> : null}
      </div>

      <div>
        <h4 style={{ margin: 0 }}>{t.replyTitle}</h4>
        {reply ? (
          <>
            <Text as="p" variant="caption-sm" color="var(--content-tertiary)">
              {t.replyReceived(shortDate(reply.receivedOn))}
            </Text>
            <blockquote style={{ margin: 0 }}>{reply.text}</blockquote>
            {reply.attachmentName ? (
              <Text as="p" variant="caption-sm">
                {t.attachment(reply.attachmentName)}
              </Text>
            ) : null}
            <Text as="p" variant="caption-sm" color="var(--content-tertiary)">
              {t.dataNotice}
            </Text>
          </>
        ) : (
          <Text as="p" variant="body-base">
            {t.noReply(shortDate(asOf))}
          </Text>
        )}
        {reading.injectionExcerpt ? (
          <div role="note" style={{ display: "grid", gap: "var(--spacing-2xs)" }}>
            <Text as="p" variant="label-lg">
              {t.injectionTitle}
            </Text>
            <Text as="p" variant="body-base">
              {t.injectionExcerpt(reading.injectionExcerpt)}
            </Text>
            <Text as="p" variant="body-base">
              {t.injectionUnchanged}
            </Text>
          </div>
        ) : null}
      </div>

      <div>
        <h4 style={{ margin: 0 }}>{t.readingTitle}</h4>
        {reading.replyOutcome === "no_reply" ? null : (
          <>
            <Text as="p" variant="body-base">
              {t.outcomeLabel(t.outcome[reading.replyOutcome])}
            </Text>
            {reading.itemsFulfilled ? (
              <Text as="p" variant="body-base">
                {t.itemsFulfilled(reading.itemsFulfilled)}
              </Text>
            ) : null}
            {reading.documentCited ? (
              <Text as="p" variant="body-base">
                {t.documentCited(reading.documentCited)}
              </Text>
            ) : null}
          </>
        )}
        <Text as="p" variant="body-base">
          {t.summary(reading.summary)}
        </Text>
        {nextStep ? (
          <>
            <Text as="p" variant="body-base">
              {t.nextStepLabel}:
            </Text>
            <Button variant="outline" size="base" onClick={() => onNextStep(nextStep)}>
              {t.nextStep[nextStep]}
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}
