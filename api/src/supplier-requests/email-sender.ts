// #156/AC-5: a escolha do canal por configuração e o envio mock em memória. O mock do banco
// (outbox_supplier_emails) é do OLTP; o Resend não é desta história.
import type { SupplierRequestChannel } from '../domain/index.js';
import type { SendResult, SupplierEmail, SupplierEmailSender } from './ports.js';

export type SupplierEmailConfig = { readonly resendApiKey?: string | null };

export type SupplierEmailAdapters = {
  readonly mock: SupplierEmailSender;
  /** #156: monta o envio pelo Resend com a chave; ausente enquanto o Resend não existe. */
  readonly resend?: (apiKey: string) => SupplierEmailSender;
};

/** #156/AC-5: sem a chave do Resend (ou sem o adaptador) o canal é o mock, sem erro. */
export function selectSupplierEmail(
  config: SupplierEmailConfig,
  adapters: SupplierEmailAdapters,
): { readonly channel: SupplierRequestChannel; readonly sender: SupplierEmailSender } {
  const key = config.resendApiKey?.trim() ?? '';
  if (key !== '' && adapters.resend) return { channel: 'resend', sender: adapters.resend(key) };
  return { channel: 'mock', sender: adapters.mock };
}

/** #156: o envio em memória, para teste e para o Worker sem banco: guarda o que "enviou". */
export class InMemorySupplierEmailSender implements SupplierEmailSender {
  readonly sent: SupplierEmail[] = [];
  private failure: string | null = null;

  /** #156: a próxima chamada falha com este motivo. */
  failNextWith(reason: string): void {
    this.failure = reason;
  }

  async send(email: SupplierEmail): Promise<SendResult> {
    if (this.failure !== null) {
      const reason = this.failure;
      this.failure = null;
      return { ok: false, reason };
    }
    this.sent.push(email);
    return { ok: true, providerMessageId: `mock-${this.sent.length}`, channel: 'mock' };
  }
}
