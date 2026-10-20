// 029 — Limpieza de rieles: se elimina el riel 'otc-limitless' (sembrado por 024) y todos los rieles manuales archivados.
// Mismas reglas que la eliminación desde la consola: no se borra un riel con cuentas aprobadas ni uno que otro riel
// vigente use como alterno; esos quedan archivados y se listan con RAISE NOTICE. Se borran también sus propuestas
// pendientes y asignaciones a clientes. Cada riel eliminado deja una entrada de auditoría 'fiat_rail_deleted'
// (actor 'sistema:migracion'; solo rail_id y label, nunca valores de cuenta). Idempotente y segura en una base vacía.
export default /* sql */ `
DO $$
DECLARE
  cand text[];
  n int;
  r record;
BEGIN
  SELECT COALESCE(array_agg(rail_id), '{}') INTO cand
    FROM fiat_rails WHERE rail_id = 'otc-limitless' OR (kind = 'manual' AND is_archived);

  cand := ARRAY(SELECT x FROM unnest(cand) x
                 WHERE NOT EXISTS (SELECT 1 FROM fiat_rail_accounts a WHERE a.rail_id = x AND a.approved_by IS NOT NULL));
  LOOP
    n := cardinality(cand);
    cand := ARRAY(SELECT x FROM unnest(cand) x
                   WHERE NOT EXISTS (SELECT 1 FROM fiat_rails f WHERE f.fallback_of = x AND NOT (f.rail_id = ANY(cand))));
    EXIT WHEN cardinality(cand) = n;
  END LOOP;

  FOR r IN SELECT rail_id FROM fiat_rails
            WHERE (rail_id = 'otc-limitless' OR (kind = 'manual' AND is_archived)) AND NOT (rail_id = ANY(cand)) LOOP
    RAISE NOTICE '029: el riel % se conserva archivado (tiene historial o es alterno de otro riel)', r.rail_id;
  END LOOP;

  IF cardinality(cand) > 0 THEN
    PERFORM set_config('app.rail_delete', 'on', true);
    INSERT INTO audit_log (actor, action, target, status, metadata)
      SELECT 'sistema:migracion', 'fiat_rail_deleted', rail_id, 200,
             jsonb_build_object('rail_id', rail_id, 'label', label, 'source', 'migration_029')
        FROM fiat_rails WHERE rail_id = ANY(cand);
    UPDATE fiat_rails SET fallback_of = NULL WHERE rail_id = ANY(cand) AND fallback_of IS NOT NULL;
    DELETE FROM fiat_rail_accounts WHERE rail_id = ANY(cand);
    DELETE FROM fiat_rail_clients WHERE rail_id = ANY(cand);
    DELETE FROM fiat_rails WHERE rail_id = ANY(cand);
  END IF;
END $$;
`;
