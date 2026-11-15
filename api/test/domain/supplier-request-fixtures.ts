import {
  DockAction,
  Invoice,
  Money,
  Quantity,
  type DecidedProposal,
  type InvoiceView,
} from '../../src/domain/index.js';

// #156: o cenário da história: NF 20046 do fornecedor F11, E2, 40 UN de Shampoo 350 ml a R$ 54,08.

export const ORIGIN_KEY = '35261174055489000148550010000200461174512643';

export const originInvoice = (): InvoiceView =>
  Invoice.receive({
    accessKey: ORIGIN_KEY,
    number: '20046',
    series: '1',
    supplierId: 'F11',
    store: 'CD-01',
    issuedOn: '2026-11-09',
    purchaseOrderRef: 'OC-2026-42328',
    entryChannel: 'SEFAZ',
    items: [
      {
        supplierCode: 'F11-001',
        sku: 'SKU-2001',
        description: 'Shampoo 350 ml',
        quantity: Quantity.of(40, 'UN'),
        unitPrice: Money.ofCents(5408),
        total: Money.ofCents(216320),
      },
      {
        supplierCode: 'F11-002',
        sku: 'SKU-2002',
        description: 'Sabonete 90 g',
        quantity: Quantity.of(100, 'UN'),
        unitPrice: Money.ofCents(250),
        total: Money.ofCents(25000),
      },
    ],
    total: Money.ofCents(241320),
  });

export const partialReturn = (sku = 'SKU-2001', amount = 40): DockAction =>
  DockAction.partial([{ sku, quantity: Quantity.of(amount, 'UN'), disposition: 'devolver' }]);

export const decided = (
  classification: DecidedProposal['classification'],
  dockAction: DockAction,
  state: DecidedProposal['state'] = 'aprovada',
): DecidedProposal => ({ classification, state, dockAction });
