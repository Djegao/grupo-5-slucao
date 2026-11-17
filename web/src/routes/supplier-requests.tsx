import { useMemo, useState, type ReactElement } from "react";
import { supplierReplyApi, type SupplierReplyReason } from "../api/supplier-reply";
import { InvoiceDrawer } from "../approval/InvoiceDrawer";
import { SupplierRequests, type DrawerShell } from "../components/SupplierRequests";
import {
  conversationOf,
  countsOf,
  draftOf,
  FILTER_OF_CHIP,
  isEmptyList,
  rowsOf,
  sendResultOf,
  todayInSaoPaulo,
} from "../components/supplier-request-map";
import { INITIAL_STATE, type SendResult } from "../components/supplier-request-state";
import type { SupplierFilter, SupplierFilterValue, SupplierRequestRow } from "../components/supplier-request-view";
import { useLoad } from "../components/useLoad";
import { useRequestDetail } from "../components/useRequestDetail";
import { texts } from "../texts";
import type { RouteProps } from "./types";

/** #21 O que a lista leu do servidor: as linhas do filtro, as contagens dos quatro chips e a chave de acesso de cada linha (a gaveta a usa). */
interface Loaded {
  rows: SupplierRequestRow[];
  counts: Record<SupplierFilter, number>;
  accessKeys: Record<string, string>;
  empty: boolean;
}

/** #5/AC-2 Um chip é um filtro do servidor; "Ver todos" lê os quatro, que não se repetem: cada pedido cai em um só. */
async function loadList(filter: SupplierFilterValue, signal: AbortSignal): Promise<Loaded> {
  const wanted = filter === "all" ? Object.values(FILTER_OF_CHIP) : [FILTER_OF_CHIP[filter]];
  const lists = await Promise.all(wanted.map((wantedFilter) => supplierReplyApi.list(wantedFilter, signal)));
  const [first] = lists;
  if (first === undefined) throw new Error("nenhum filtro pedido");
  return {
    rows: lists.flatMap(rowsOf),
    counts: countsOf(first),
    accessKeys: Object.fromEntries(lists.flatMap((list) => list.requests.map((request) => [String(request.id), request.invoiceAccessKey] as const))),
    empty: isEmptyList(first),
  };
}

const drawerError = (reason: SupplierReplyReason | null): string => texts.supplierRequests.drawer.errors[reason ?? "unknown"];

/** #5/AC-3 ADR-004 /pedidos-fornecedor: os pedidos ao fornecedor com a leitura da resposta (#4); a gaveta abre no bloco do pedido e "Cobrar" abre o rascunho para revisar e enviar. */
export default function SupplierRequestsRoute(_props: RouteProps): ReactElement {
  const [filter, setFilter] = useState<SupplierFilterValue>(INITIAL_STATE.filter);
  const { state, data, retry } = useLoad((signal) => loadList(filter, signal), (loaded) => loaded.empty);
  const [openId, setOpenId] = useState<string | null>(null);
  const keyOf = (id: string): string | null => data?.accessKeys[id] ?? null;
  const open = useRequestDetail(openId === null ? null : keyOf(openId), supplierReplyApi.detail);
  const today = useMemo(() => todayInSaoPaulo(), []);

  /** #21 O pedido lido só vale para a linha de que veio: trocando de linha, a gaveta espera o pedido da nova. */
  const detailOf = (row: SupplierRequestRow) => (open.detail && open.detail.invoiceAccessKey === keyOf(row.id) ? open.detail : undefined);

  const choose = (value: SupplierFilterValue): void => {
    setFilter(value);
    retry();
  };

  const send = async (row: SupplierRequestRow): Promise<SendResult> => {
    const accessKey = keyOf(row.id);
    if (accessKey === null) throw new Error("linha sem chave de acesso");
    return sendResultOf(await supplierReplyApi.sendFollowUp(accessKey));
  };

  // #21 A gaveta da nota (#209), a mesma das outras grids: a proposta da #3 e o bloco "Pedido ao fornecedor" dela vêm dali, e o bloco desta tela entra acima.
  const shell: DrawerShell = ({ row, title, onClose, children }) => (
    <InvoiceDrawer key={row.id} invoiceAccessKey={keyOf(row.id) ?? ""} title={() => title} onClose={onClose}>
      {children}
    </InvoiceDrawer>
  );

  return (
    <SupplierRequests
      state={state}
      rows={data?.rows ?? []}
      counts={data?.counts}
      onFilterChange={choose}
      onRetry={retry}
      conversationOf={(row) => {
        const detail = detailOf(row);
        return detail ? conversationOf(row, detail, today) : null;
      }}
      draftOf={(row) => {
        const detail = detailOf(row);
        return detail ? draftOf(detail, today) : null;
      }}
      send={send}
      drawerState={open.state}
      drawerError={drawerError(open.reason)}
      onDrawerRetry={open.retry}
      onDrawerChange={setOpenId}
      editableDraft={false}
      renderDrawer={shell}
    />
  );
}
