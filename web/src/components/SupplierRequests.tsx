import { useEffect, useReducer, useRef, type ReactElement, type ReactNode } from "react";
import { Button, Drawer, Text } from "barte-design-system";
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
import type {
  FollowUpDraftView,
  SupplierConversationView,
  SupplierFilter,
  SupplierFilterValue,
  SupplierNextStep,
  SupplierRequestRow,
} from "./supplier-request-view";

const drawerTexts = texts.supplierRequests.drawer;

/** #21 A casca da gaveta: o que abre em volta do bloco. A padrão é a gaveta do DS; a rota usa a gaveta da nota (InvoiceDrawer, #209). */
export type DrawerShell = (args: { row: SupplierRequestRow; title: string; onClose: () => void; children: ReactNode }) => ReactElement;

const defaultShell: DrawerShell = ({ title, onClose, children }) => (
  <Drawer isOpen title={title} onClose={onClose} className="shell-connection-panel">
    {children}
  </Drawer>
);

export interface SupplierRequestsProps {
  state: LoadState;
  /** #20 As solicitações como a carga as entrega: todas, ou, com `onFilterChange`, as do filtro que o servidor devolveu. */
  rows: SupplierRequestRow[];
  /** #21 As contagens dos chips como o servidor as calculou (#36); sem elas, a #20 conta as linhas. */
  counts?: Record<SupplierFilter, number>;
  /** #21 O chip mudou: a rota pede ao servidor as linhas do filtro novo. */
  onFilterChange?: (filter: SupplierFilterValue) => void;
  onRetry: () => void;
  /** #20 A conversa e a leitura do agente de uma solicitação, para o bloco da gaveta; nulo enquanto o pedido não chegou. */
  conversationOf: (row: SupplierRequestRow) => SupplierConversationView | null;
  /** #20 O rascunho da cobrança de uma solicitação (follow_up_draft da #157), com o prazo de 3 dias úteis já calculado; nulo sem rascunho. */
  draftOf: (row: SupplierRequestRow) => FollowUpDraftView | null;
  /** #20 Envia a cobrança; devolve quando saiu ou o motivo fechado da falha. Uma rejeição vira "unknown": o erro de fora não chega à tela. */
  send: (row: SupplierRequestRow, draft: FollowUpDraftView) => Promise<SendResult>;
  /** #20 Os próximos passos da leitura que não são cobrar (encerrar, confirmar, responder) são de outra camada; chegam por aqui. */
  onNextStep?: (row: SupplierRequestRow, step: SupplierNextStep) => void;
  /** #21 O pedido da gaveta aberta (ou nulo, fechada): a rota o lê da API. Sem isto, a gaveta está sempre pronta. */
  drawerState?: LoadState;
  /** #21 A mensagem fechada de uma leitura que falhou; nunca o texto da API. */
  drawerError?: string;
  onDrawerRetry?: () => void;
  /** #21 Avisa qual linha está aberta na gaveta (`null`: nenhuma), para a rota buscar o pedido dela. */
  onDrawerChange?: (id: string | null) => void;
  /** #21 Falso: o texto da cobrança não se edita (o envio não o leva ao servidor, #36). */
  editableDraft?: boolean;
  renderDrawer?: DrawerShell;
}

/** #5/AC-4 O corpo da gaveta desta tela: o bloco "Pedido ao fornecedor" e o rascunho da cobrança. */
function DrawerBody(props: {
  conversation: SupplierConversationView;
  flow: FollowUpFlow | null;
  draft: FollowUpDraftView | null;
  editable: boolean;
  onNextStep: (step: SupplierNextStep) => void;
  onEdit: () => void;
  onBodyChange: (body: string) => void;
  onSend: () => void;
  onDiscard: () => void;
}): ReactElement {
  const { conversation, flow, draft, editable, onNextStep, onEdit, onBodyChange, onSend, onDiscard } = props;
  return (
    <div style={{ display: "grid", gap: "var(--spacing-lg)", padding: "var(--spacing-lg)" }}>
      <SupplierConversation conversation={conversation} onNextStep={onNextStep} />
      {flow && draft ? (
        <FollowUpDraft
          draft={draft}
          editing={flow.editing}
          onEdit={editable ? onEdit : undefined}
          onBodyChange={onBodyChange}
          onSend={onSend}
          onDiscard={onDiscard}
          onRetry={onSend}
          {...flow.phase}
        />
      ) : null}
      {flow && !draft ? (
        <div role="status">
          <Text as="p" variant="body-base">
            {texts.supplierRequests.draft.unavailable}
          </Text>
        </div>
      ) : null}
      {flow && !draft && flow.phase.phase === "failed" ? (
        // #5/AC-4 O servidor releu o pedido e já não há rascunho (409 sem rascunho): a falha fechada aparece mesmo assim, nunca o texto do servidor.
        <div role="alert">
          <Text as="p" variant="body-base">
            {texts.supplierRequests.draft.failed[flow.phase.failure]}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

/** #21 A gaveta enquanto o pedido não chegou, ou quando a leitura falhou: o erro é a mensagem fechada, com "Tentar de novo". */
function DrawerPending({ failed, message, onRetry }: { failed: boolean; message: string; onRetry?: () => void }): ReactElement {
  return (
    <div role={failed ? "alert" : "status"} style={{ display: "grid", gap: "var(--spacing-sm)", padding: "var(--spacing-lg)" }}>
      <Text as="p" variant="body-base">
        {message}
      </Text>
      {failed && onRetry ? (
        <Button variant="outline" size="base" onClick={onRetry}>
          {drawerTexts.retry}
        </Button>
      ) : null}
    </div>
  );
}

/** #5/AC-4 O rascunho que a pessoa vê e envia: o do dado, com o texto que ela editou, se editou. */
function currentDraft(base: FollowUpDraftView, flow: FollowUpFlow | null): FollowUpDraftView {
  return { ...base, body: flow?.body ?? base.body };
}

/** #5 A tela "Pedidos ao fornecedor": liga a lista, a gaveta e o rascunho da cobrança ao estado da #20; os dados entram por props (a rota os lê, #21). */
export function SupplierRequests(props: SupplierRequestsProps): ReactElement {
  const { state, rows, counts, onFilterChange, onRetry, conversationOf, draftOf, send, onNextStep } = props;
  const { drawerState = "ready", drawerError, onDrawerRetry, onDrawerChange, editableDraft = true, renderDrawer = defaultShell } = props;
  const [screen, dispatch] = useReducer(screenReducer, INITIAL_STATE);
  // #5/AC-4 Só a cobrança desta sessão muda a linha (Aguardando, cobrado). A que o servidor já enviou fica no chip dele e sem "Cobrar" (`alreadyCharged`, #21).
  const charged = screen.charged;
  const current = applyCharges(rows, charged);
  const openRow = screen.drawer ? current.find((row) => row.id === screen.drawer?.requestId) : undefined;
  const flow = screen.drawer?.followUp ?? null;

  const changed = useRef(onDrawerChange);
  changed.current = onDrawerChange;
  const openId = openRow?.id ?? null;
  useEffect(() => {
    changed.current?.(openId);
  }, [openId]);

  async function sendFollowUp(row: SupplierRequestRow): Promise<void> {
    if (!flow || flow.phase.phase === "sending" || flow.phase.phase === "sent") return;
    const base = draftOf(row);
    if (!base) return;
    const draft = currentDraft(base, flow);
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
        ? { type: "sendSucceeded", id: row.id, dueOn: draft.dueOn, sentOn: result.sentOn, sentTime: result.sentTime, sentBy: result.sentBy }
        : { type: "sendFailed", id: row.id, failure: result.failure },
    );
  }

  function handleNextStep(row: SupplierRequestRow, step: SupplierNextStep): void {
    if (step === "follow_up") dispatch({ type: "openFollowUp", id: row.id });
    else onNextStep?.(row, step);
  }

  function drawerContent(row: SupplierRequestRow): ReactElement {
    if (drawerState === "error") return <DrawerPending failed message={drawerError ?? drawerTexts.errors.unknown} onRetry={onDrawerRetry} />;
    const loaded = drawerState === "ready" ? conversationOf(row) : null;
    if (!loaded) return <DrawerPending failed={false} message={drawerTexts.loading} />;
    // #5/AC-4 Pedido cobrado nesta sessão vale como o que o servidor já cobrou: atrasado lê "Atrasado (cobrado)", os demais mantêm o status, e nenhum tem próximo passo (#20).
    const conversation: SupplierConversationView = charged[row.id]
      ? { ...loaded, status: row.status === "late" ? "lateCharged" : loaded.status, reading: { ...loaded.reading, nextStep: null } }
      : loaded;
    const base = draftOf(row);
    return (
      <DrawerBody
        conversation={conversation}
        flow={flow}
        draft={base ? currentDraft(base, flow) : null}
        editable={editableDraft}
        onNextStep={(step) => handleNextStep(row, step)}
        onEdit={() => dispatch({ type: "edit" })}
        onBodyChange={(body) => dispatch({ type: "changeBody", body })}
        onSend={() => void sendFollowUp(row)}
        onDiscard={() => dispatch({ type: "discard" })}
      />
    );
  }

  return (
    <>
      <SupplierRequestList
        state={state}
        filter={screen.filter}
        counts={counts ?? countByChip(current)}
        rows={visibleRows(current, screen.filter)}
        onFilterChange={(filter) => {
          dispatch({ type: "filter", filter });
          onFilterChange?.(filter);
        }}
        onOpenRow={(row) => dispatch({ type: "openRow", id: row.id })}
        onFollowUp={(row) => dispatch({ type: "openFollowUp", id: row.id })}
        onRetry={onRetry}
        onShowAll={() => {
          dispatch({ type: "filter", filter: "all" });
          onFilterChange?.("all");
        }}
      />
      {openRow ? renderDrawer({ row: openRow, title: texts.fila.drawerTitle(openRow.invoiceNumber), onClose: () => dispatch({ type: "close" }), children: drawerContent(openRow) }) : null}
    </>
  );
}
