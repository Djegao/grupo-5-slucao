import { useReducer, type ReactElement } from "react";
import { Drawer } from "barte-design-system";
import type { LoadState } from "@barte-ai-services/barte-ui-kit";
import { FollowUpDraft } from "../approval/FollowUpDraft";
import { SupplierConversation } from "../approval/SupplierConversation";
import { texts } from "../texts";
import { SupplierRequestList } from "./SupplierRequestList";
import {
  applyCharges,
  countByChip,
  INITIAL_STATE,
  screenReducer,
  visibleRows,
  type FollowUpFlow,
  type SendResult,
} from "./supplier-request-state";
import type { FollowUpDraftView, SupplierConversationView, SupplierNextStep, SupplierRequestRow } from "./supplier-request-view";

export interface SupplierRequestsProps {
  state: LoadState;
  /** #20 Todas as solicitações, como a carga as entrega; a #21 liga isto ao contrato. */
  rows: SupplierRequestRow[];
  onRetry: () => void;
  /** #20 A conversa e a leitura do agente de uma solicitação, para o bloco da gaveta. */
  conversationOf: (row: SupplierRequestRow) => SupplierConversationView;
  /** #20 O rascunho da cobrança de uma solicitação (follow_up_draft da #157), com o prazo de 3 dias úteis já calculado. */
  draftOf: (row: SupplierRequestRow) => FollowUpDraftView;
  /** #20 Envia a cobrança; devolve quando saiu ou o motivo fechado da falha. Uma rejeição vira "unknown": o erro de fora não chega à tela. */
  send: (row: SupplierRequestRow, draft: FollowUpDraftView) => Promise<SendResult>;
  /** #20 Os próximos passos da leitura que não são cobrar (encerrar, confirmar, responder) são de outra camada; chegam por aqui. */
  onNextStep?: (row: SupplierRequestRow, step: SupplierNextStep) => void;
}

/** #5/AC-4 A gaveta mínima desta tela: hospeda só o bloco "Pedido ao fornecedor"; a proposta da #3 não cabe aqui, pois a linha não traz chave de acesso (#20). */
function DrawerBody(props: {
  conversation: SupplierConversationView;
  flow: FollowUpFlow | null;
  draft: FollowUpDraftView;
  onNextStep: (step: SupplierNextStep) => void;
  onEdit: () => void;
  onBodyChange: (body: string) => void;
  onSend: () => void;
  onDiscard: () => void;
}): ReactElement {
  const { conversation, flow, draft, onNextStep, onEdit, onBodyChange, onSend, onDiscard } = props;
  return (
    <div style={{ display: "grid", gap: "var(--spacing-lg)", padding: "var(--spacing-lg)" }}>
      <SupplierConversation conversation={conversation} onNextStep={onNextStep} />
      {flow ? (
        <FollowUpDraft
          draft={draft}
          editing={flow.editing}
          onEdit={onEdit}
          onBodyChange={onBodyChange}
          onSend={onSend}
          onDiscard={onDiscard}
          onRetry={onSend}
          {...flow.phase}
        />
      ) : null}
    </div>
  );
}

/** #5/AC-4 O rascunho que a pessoa vê e envia: o do dado, com o texto que ela editou, se editou. */
function currentDraft(base: FollowUpDraftView, flow: FollowUpFlow | null): FollowUpDraftView {
  return { ...base, body: flow?.body ?? base.body };
}

/** #5 A tela "Pedidos ao fornecedor": liga a lista, a gaveta e o rascunho da cobrança ao estado da #20, sem API. */
export function SupplierRequests(props: SupplierRequestsProps): ReactElement {
  const { state, rows, onRetry, conversationOf, draftOf, send, onNextStep } = props;
  const [screen, dispatch] = useReducer(screenReducer, INITIAL_STATE);
  const current = applyCharges(rows, screen.charged);
  const openRow = screen.drawer ? current.find((row) => row.id === screen.drawer?.requestId) : undefined;
  const flow = screen.drawer?.followUp ?? null;

  async function sendFollowUp(row: SupplierRequestRow): Promise<void> {
    if (!flow || flow.phase.phase === "sending" || flow.phase.phase === "sent") return;
    const draft = currentDraft(draftOf(row), flow);
    dispatch({ type: "sendStarted", id: row.id });
    let result: SendResult;
    try {
      result = await send(row, draft);
    } catch {
      // #20 O erro de quem enviou não é lido nem mostrado: a tela só conhece o motivo fechado "unknown" (layer-exposure).
      result = { ok: false, failure: "unknown" };
    }
    dispatch(
      result.ok
        ? { type: "sendSucceeded", id: row.id, dueOn: draft.dueOn, sentOn: result.sentOn, sentTime: result.sentTime }
        : { type: "sendFailed", id: row.id, failure: result.failure },
    );
  }

  function handleNextStep(row: SupplierRequestRow, step: SupplierNextStep): void {
    if (step === "follow_up") dispatch({ type: "openFollowUp", id: row.id });
    else onNextStep?.(row, step);
  }

  return (
    <>
      <SupplierRequestList
        state={state}
        filter={screen.filter}
        counts={countByChip(current)}
        rows={visibleRows(current, screen.filter)}
        onFilterChange={(filter) => dispatch({ type: "filter", filter })}
        onOpenRow={(row) => dispatch({ type: "openRow", id: row.id })}
        onFollowUp={(row) => dispatch({ type: "openFollowUp", id: row.id })}
        onRetry={onRetry}
        onShowAll={() => dispatch({ type: "filter", filter: "all" })}
      />
      {openRow ? (
        <Drawer isOpen title={texts.fila.drawerTitle(openRow.invoiceNumber)} onClose={() => dispatch({ type: "close" })} className="shell-connection-panel">
          <DrawerBody
            conversation={
              screen.charged[openRow.id]
                ? // #5/AC-4 Pedido já cobrado nesta sessão: o bloco fica "Aguardando (cobrado)" e sem próximo passo (estado 9 do wireframe, #20).
                  { ...conversationOf(openRow), status: "waitingCharged", reading: { ...conversationOf(openRow).reading, nextStep: null } }
                : conversationOf(openRow)
            }
            flow={flow}
            draft={currentDraft(draftOf(openRow), flow)}
            onNextStep={(step) => handleNextStep(openRow, step)}
            onEdit={() => dispatch({ type: "edit" })}
            onBodyChange={(body) => dispatch({ type: "changeBody", body })}
            onSend={() => void sendFollowUp(openRow)}
            onDiscard={() => dispatch({ type: "discard" })}
          />
        </Drawer>
      ) : null}
    </>
  );
}
