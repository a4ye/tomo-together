-- Removes everything migration/smoke-write.mjs and migration/smoke-stake.mjs
-- created. Run the first block against `tomo-together` and the second against
-- `tomo-together-custody`. Both are keyed on the `ctest_` username prefix, which
-- no real account can have (the live usernames are checked in
-- ht6-atlas-export/tomoyard__users.jsonl and none of them start with ctest_).

-- ---------------------------------------------------------------- app db --
DELETE FROM confirms WHERE hangout_id IN (
  SELECT hangout_id FROM hangout_members WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\')
);
DELETE FROM hangout_stakes WHERE hangout_id IN (
  SELECT hangout_id FROM hangout_members WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\')
);
DELETE FROM hangout_settlements WHERE hangout_id IN (
  SELECT hangout_id FROM hangout_members WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\')
);
DELETE FROM nfc_tokens WHERE hangout_id IN (
  SELECT hangout_id FROM hangout_members WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\')
);
DELETE FROM hangouts WHERE id IN (
  SELECT hangout_id FROM hangout_members WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\')
);
DELETE FROM hangout_members WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\');
DELETE FROM friendships WHERE a_id IN (SELECT id FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\')
                            OR b_id IN (SELECT id FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\');
DELETE FROM weights WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\');
DELETE FROM users WHERE username LIKE 'ctest\_%' ESCAPE '\';

-- The counters keep advancing, exactly as they would have on Mongo after any
-- write. They are NOT rewound: reusing an id would be worse than a gap.
