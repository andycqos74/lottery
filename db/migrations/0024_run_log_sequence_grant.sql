-- 0024_run_log_sequence_grant — let the application insert into run_log.
--
-- 0007's ALTER DEFAULT PRIVILEGES covers new TABLES only, and run_log (0023)
-- is the first table since then with a serial key, so lottery_app could not
-- take ids from its sequence ("permission denied for sequence run_log_id_seq").
-- Granted per sequence, as 0007 did, rather than by default for every future
-- one; the security test now checks lottery_app can use every sequence.

GRANT USAGE, SELECT ON SEQUENCE run_log_id_seq TO lottery_app;
