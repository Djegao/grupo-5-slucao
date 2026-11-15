// #156: os resultados dos casos de uso; a camada de API os traduz em HTTP (ok 200, not_found 404, conflict 409, invalid 422).
import type { ReturnNote, SupplierRequestSnapshot } from '../domain/index.js';

export type NotFound = { readonly kind: 'not_found' };

export type ConflictReason =
  | 'wrong_state'
  | 'open_request_exists'
  | 'stale'
  | 'no_longer_qualifies'
  | 'no_supplier_email'
  | 'queue_mismatch'
  | 'queue_not_pending';

export type Conflict = { readonly kind: 'conflict'; readonly reason: ConflictReason };

export type Invalid = { readonly kind: 'invalid'; readonly reason: string };

export type Changed = { readonly kind: 'ok'; readonly request: SupplierRequestSnapshot } | NotFound | Conflict;

export const NOT_FOUND: NotFound = { kind: 'not_found' };
export const conflict = (reason: ConflictReason): Conflict => ({ kind: 'conflict', reason });

export type WriteDraftResult =
  | { readonly kind: 'ok'; readonly status: 'draft' | 'discarded'; readonly request: SupplierRequestSnapshot }
  | NotFound
  | Conflict;

export type EditBodyResult = Changed | Invalid;

export type DeliveryResult =
  | {
      readonly kind: 'ok';
      readonly status: 'sent' | 'send_failed';
      readonly request: SupplierRequestSnapshot;
      readonly note: ReturnNote;
    }
  | NotFound
  | Conflict;
