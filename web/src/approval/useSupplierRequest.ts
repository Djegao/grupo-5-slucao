/**
 * #3 Liga o estado do bloco "Pedido ao fornecedor" às chamadas (#16): carrega o pedido, consulta de
 * tempos em tempos enquanto o Claude escreve (AC-2) e traduz cada ação em pendente, feito ou recusado.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { SupplierRequestBlockProps, SupplierRequestPending, SupplierRequestView } from "./SupplierRequestBlock";
import {
  initialSupplierRequestState,
  supplierRequestError,
  supplierRequestReducer,
  viewOf,
  type SupplierRequestPort,
} from "./supplier-request-state";

/** #3/AC-2 Intervalo padrão da consulta enquanto o pedido está sendo escrito; quem monta a gaveta pode trocar. */
export const DEFAULT_POLL_MS = 3000;

export type SupplierRequestHandlers = Omit<SupplierRequestBlockProps, "viewer">;

export function useSupplierRequest(port: SupplierRequestPort, accessKey: string, pollMs: number = DEFAULT_POLL_MS): SupplierRequestHandlers {
  const [state, dispatch] = useReducer(supplierRequestReducer, initialSupplierRequestState);
  const portRef = useRef(port);
  portRef.current = port;
  const live = useRef(true);
  const writing = state.request?.status === "writing";

  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    portRef.current
      .load(accessKey, controller.signal)
      .then((request) => {
        if (!controller.signal.aborted) dispatch({ type: "loaded", request });
      })
      // #3/AC-1 Sem conseguir buscar, o bloco não aparece: a gaveta segue com o resto da proposta.
      .catch(() => undefined);
    return () => {
      live.current = false;
      controller.abort();
    };
  }, [accessKey]);

  useEffect(() => {
    if (!writing) return undefined;
    const controller = new AbortController();
    const timer = setInterval(() => {
      portRef.current
        .load(accessKey, controller.signal)
        .then((request) => {
          if (!controller.signal.aborted) dispatch({ type: "loaded", request });
        })
        // #3/AC-2 Uma consulta que falha não derruba o bloco: a próxima tenta de novo.
        .catch(() => undefined);
    }, pollMs);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [writing, accessKey, pollMs]);

  const act = useCallback(async (pending: SupplierRequestPending, call: () => Promise<SupplierRequestView>) => {
    dispatch({ type: "started", pending });
    try {
      const request = await call();
      if (live.current) dispatch({ type: "done", request });
    } catch (reason) {
      if (live.current) dispatch({ type: "failed", error: supplierRequestError(reason) });
    }
  }, []);

  return {
    request: viewOf(state),
    pending: state.pending,
    error: state.error,
    draftText: state.draftText,
    onSend: () => void act("send", () => portRef.current.send(accessKey)),
    onResend: () => void act("resend", () => portRef.current.resend(accessKey)),
    onDiscard: () => void act("discard", () => portRef.current.discard(accessKey)),
    onRedo: () => void act("redo", () => portRef.current.redo(accessKey)),
    onSave: () => void act("save", () => portRef.current.saveText(accessKey, state.draftText)),
    onEdit: () => dispatch({ type: "editStarted" }),
    onCancelEdit: () => dispatch({ type: "editCancelled" }),
    onDraftTextChange: (text) => dispatch({ type: "textChanged", text }),
  };
}
