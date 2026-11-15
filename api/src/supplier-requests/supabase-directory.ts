// #156: o cadastro de contatos dos fornecedores (supplier_contacts): o e-mail de teste por fornecedor.
import { isString, parseOne, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { SupplierDirectory } from './ports.js';

const TABLE = 'supplier_contacts';

type ContactRow = { email: string };
const isContact = shaped<ContactRow>({ email: isString } satisfies Shape<ContactRow>);

export function supabaseSupplierDirectory(rest: SupabaseRest): SupplierDirectory {
  return {
    async emailOf(supplierId: string): Promise<string | null> {
      const [row] = await rest.select(TABLE, { select: 'email', filters: { supplier_id: `eq.${supplierId}` }, limit: 1 });
      return row === undefined ? null : parseOne(row, isContact, TABLE).email;
    },
  };
}
