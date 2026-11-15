// #156: as propostas decididas, com tudo o que a regra da devolução lê: a nota, a decisão, quem decidiu
// (approvals, #211), o recebimento do WMS e o contexto do catálogo de fatos. Só lê.
import type { CaseFile } from '../approval/store.js';
import { SupabaseApprovalStore } from '../approval/supabase-store.js';
import { supabaseConnectors } from '../connectors/supabase-connectors.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { findReceipt, type CheckContext } from '../domain/index.js';
import { loadDossierContext } from '../dossier/context.js';
import type { DecidedCase, DecidedProposalSource } from './ports.js';

const isDecided = (file: CaseFile): boolean => file.proposal.state === 'aprovada' || file.proposal.state === 'alterada';

class SupabaseDecidedProposalSource implements DecidedProposalSource {
  private readonly store: SupabaseApprovalStore;
  private readonly connectors: ReturnType<typeof supabaseConnectors>;

  constructor(rest: SupabaseRest) {
    this.store = new SupabaseApprovalStore(rest);
    this.connectors = supabaseConnectors(rest);
  }

  async listDecided(): Promise<DecidedCase[]> {
    const files = await this.store.listDecided();
    if (files.length === 0) return [];
    // #156: o contexto lê os conectores uma vez por varredura; cada caso tira a própria nota das capturadas (regra 1).
    const context = await loadDossierContext(this.connectors.captureDeps, '');
    return files.map((file) => decidedCase(file, context));
  }

  async find(invoiceAccessKey: string): Promise<DecidedCase | null> {
    const file = await this.store.find(invoiceAccessKey);
    if (!file || !isDecided(file) || !file.approval) return null;
    return decidedCase(file, await loadDossierContext(this.connectors.captureDeps, invoiceAccessKey));
  }
}

function decidedCase(file: CaseFile, context: CheckContext): DecidedCase {
  const key = file.invoice.accessKey;
  return {
    proposal: file.proposal,
    invoice: file.invoice,
    goodsEntered: findReceipt(file.invoice, context.receipts) !== null,
    context: { ...context, capturedInvoices: context.capturedInvoices.filter((i) => i.accessKey !== key) },
    decidedBy: file.approval?.approver ?? null,
  };
}

export function supabaseDecidedProposalSource(rest: SupabaseRest): DecidedProposalSource {
  return new SupabaseDecidedProposalSource(rest);
}
