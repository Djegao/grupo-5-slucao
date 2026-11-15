/* #156/AC-5: a escolha do canal por configuração. O mock do Worker é o do banco
   (outbox_supplier_emails), da camada de OLTP; o Resend não é desta história. */
import type { SupplierRequestChannel } from '../domain/index.js';
import type { SupplierEmailSender } from './ports.js';

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
