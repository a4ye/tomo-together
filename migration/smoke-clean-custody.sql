-- Custody half of the smoke-test cleanup. Run against `tomo-together-custody`.
-- Every row is keyed on the `ty_ctest_` external-user prefix; the eleven real
-- ledger users are listed in ht6-atlas-export/ht6_crypto__crypto_users.jsonl and
-- none of them match it.
DELETE FROM crypto_event_rsvps WHERE user_id LIKE 'ty\_ctest\_%' ESCAPE '\'
   OR event_id IN (SELECT id FROM crypto_events WHERE host LIKE 'ty\_ctest\_%' ESCAPE '\');
DELETE FROM crypto_events WHERE host LIKE 'ty\_ctest\_%' ESCAPE '\';
DELETE FROM crypto_withdrawals WHERE external_user_id LIKE 'ty\_ctest\_%' ESCAPE '\';
DELETE FROM crypto_idempotency WHERE external_user_id LIKE 'ty\_ctest\_%' ESCAPE '\';
DELETE FROM crypto_users WHERE external_user_id LIKE 'ty\_ctest\_%' ESCAPE '\';
-- Also drop the diagnostic rows created while proving the service binding.
DELETE FROM crypto_users WHERE external_user_id IN ('ty_ctest_diag01', 'ty_ctest_diagX');
