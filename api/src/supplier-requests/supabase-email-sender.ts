// #156/AC-5: o envio mock do e-mail ao fornecedor: grava em outbox_supplier_emails e devolve o id do envio.
// Idempotente por request_id: reenviar o mesmo pedido devolve o provider_message_id guardado.
import { isString, parseOne, shaped, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { SendResult, SupplierEmail, SupplierEmailSender } from './ports.js';

const TABLE = 'outbox_supplier_emails';

type StoredRow = { provider_message_id: string };
const isStored = shaped<StoredRow>({ provider_message_id: isString } satisfies Shape<StoredRow>);

export type SupabaseEmailSenderOptions = {
  /** #156: o gerador do sufixo do id do envio; o padrão é um UUID. */
  readonly newId?: () => string;
};

class SupabaseSupplierEmailSender implements SupplierEmailSender {
  private readonly newId: () => string;

  constructor(
    private readonly rest: SupabaseRest,
    options: SupabaseEmailSenderOptions,
  ) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async send(email: SupplierEmail): Promise<SendResult> {
    const [inserted] = await this.rest.insert(
      TABLE,
      [
        {
          request_id: email.requestId,
          provider_message_id: `mock-${this.newId()}`,
          to_address: email.to,
          subject: email.subject,
          body: email.body,
          attachments: email.attachments,
        },
      ],
      { onConflict: 'request_id', ignoreDuplicates: true },
    );
    const [stored] = inserted
      ? [inserted]
      : await this.rest.select(TABLE, {
          select: 'provider_message_id',
          filters: { request_id: `eq.${email.requestId}` },
          limit: 1,
        });
    if (stored === undefined) throw new SupabaseRestError('select', TABLE, 0, 'o envio do pedido não foi encontrado depois do conflito');
    return { ok: true, providerMessageId: parseOne(stored, isStored, TABLE).provider_message_id, channel: 'mock' };
  }
}

export function supabaseSupplierEmailSender(rest: SupabaseRest, options: SupabaseEmailSenderOptions = {}): SupplierEmailSender {
  return new SupabaseSupplierEmailSender(rest, options);
}
