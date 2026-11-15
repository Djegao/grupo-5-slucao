// #156: a configuração do pedido ao fornecedor que vem do Env, a mesma no Worker e no Cron.
import type { Env } from '../env.js';
import type { SupabaseSupplierRequestOptions } from './supabase-deps.js';

/**
 * #156: o CNPJ do emitente da nota de devolução quando `ISSUER_CNPJ` não vem ou não tem 14 dígitos. O kit
 * (data/kit) traz o CNPJ dos fornecedores e nenhum da Já Chegou; este é o CNPJ zerado, reservado, de nenhuma empresa.
 */
export const DEFAULT_ISSUER_CNPJ = '00.000.000/0000-00';

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** #156/AC-5: as opções das portas a partir do Env. A chave do Resend é opcional e, com ela, entra na lista que o log nunca mostra. */
export function supplierRequestOptionsFromEnv(env: Env, log: (line: string) => void): SupabaseSupplierRequestOptions {
  const resendApiKey = present(env.RESEND_API_KEY) ?? null;
  const secrets = [
    env.BARTE_ACADEMY_SUPABASE_SECRET_KEY,
    env.BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN,
    env.BARTE_ACADEMY_ANTHROPIC_API_KEY,
    resendApiKey ?? undefined,
  ].filter((s): s is string => typeof s === 'string' && s !== '');
  return { issuerCnpj: issuerCnpjFromEnv(env, log), resendApiKey, log, secrets };
}

/** #156: `ISSUER_CNPJ` precisa de 14 dígitos (com ou sem máscara); fora disso vale o padrão e o log avisa, sem o valor. */
function issuerCnpjFromEnv(env: Env, log: (line: string) => void): string {
  const configured = present(env.ISSUER_CNPJ);
  if (configured === undefined) return DEFAULT_ISSUER_CNPJ;
  if (configured.replace(/\D/g, '').length === 14 && /^[\d./-]+$/.test(configured)) return configured;
  log('ISSUER_CNPJ inválido (precisa de 14 dígitos); vale o CNPJ padrão');
  return DEFAULT_ISSUER_CNPJ;
}
