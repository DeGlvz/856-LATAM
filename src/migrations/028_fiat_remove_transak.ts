// 028 — Se retira el proveedor «transak» (rechazado): ya no es un valor válido de fiat_accounts.provider ni de fiat_webhook_events.provider.
// Las cuentas abiertas con ese proveedor se cierran sin borrar nada; sus filas (y depósitos/avisos asociados) se conservan como historial contable.
// La restricción nueva queda NOT VALID para no reescribir ni invalidar filas históricas; solo aplica a filas nuevas o modificadas.
export default /* sql */ `
UPDATE fiat_accounts
   SET status = 'closed', provider_state = 'provider_removed', updated_at = now()
 WHERE provider = 'transak' AND status <> 'closed';

ALTER TABLE fiat_accounts DROP CONSTRAINT IF EXISTS fiat_accounts_provider_check;
ALTER TABLE fiat_accounts ADD CONSTRAINT fiat_accounts_provider_check
  CHECK (provider IN ('monerium','mock','circle')) NOT VALID;

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'fiat_webhook_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%provider%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE fiat_webhook_events DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE fiat_webhook_events ADD CONSTRAINT fiat_webhook_events_provider_check
    CHECK (provider IN ('monerium','mock','circle')) NOT VALID;
END $$;
`;
