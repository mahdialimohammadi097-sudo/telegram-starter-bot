-- Ledger table and trigger definitions from the 2026-11-11 read-only catalog audit.
-- Objects resolve inside the integration test's temporary schema.
-- The external users table is represented only by its referenced key.
CREATE TABLE users (id bigint PRIMARY KEY);

CREATE TABLE ledger_accounts (
  id bigserial PRIMARY KEY,
  user_id bigint REFERENCES users(id),
  account_code varchar(100) NOT NULL UNIQUE,
  account_type varchar(30) NOT NULL,
  currency varchar(10) NOT NULL DEFAULT 'USDT',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_type, currency)
);

CREATE TABLE ledger_transactions (
  id bigserial PRIMARY KEY,
  transaction_type varchar(30) NOT NULL,
  reference_id varchar(100),
  idempotency_key varchar(150) UNIQUE,
  description text,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','reversed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES ledger_transactions(id),
  account_id bigint NOT NULL REFERENCES ledger_accounts(id),
  entry_type varchar(10) NOT NULL CHECK (entry_type IN ('debit','credit')),
  amount numeric(36,18) NOT NULL CHECK (amount > 0),
  currency varchar(10) NOT NULL DEFAULT 'USDT',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION validate_posted_transaction(p_transaction_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_status VARCHAR;
BEGIN
    SELECT status
    INTO v_status
    FROM ledger_transactions
    WHERE id = p_transaction_id;

    IF NOT FOUND OR v_status <> 'posted' THEN
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM ledger_entries
        WHERE transaction_id = p_transaction_id
    ) THEN
        RAISE EXCEPTION
            'Posted transaction % has no ledger entries',
            p_transaction_id;
    END IF;

    IF EXISTS (
        SELECT currency
        FROM ledger_entries
        WHERE transaction_id = p_transaction_id
        GROUP BY currency
        HAVING
            COUNT(*) < 2
            OR SUM(
                CASE
                    WHEN entry_type = 'debit' THEN amount
                    ELSE 0
                END
            ) <>
            SUM(
                CASE
                    WHEN entry_type = 'credit' THEN amount
                    ELSE 0
                END
            )
    ) THEN
        RAISE EXCEPTION
            'Transaction % is not balanced',
            p_transaction_id;
    END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION check_ledger_balance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_transaction_id BIGINT;
    v_status VARCHAR;
BEGIN
    IF TG_TABLE_NAME = 'ledger_transactions' THEN
        v_transaction_id := NEW.id;
        PERFORM validate_posted_transaction(v_transaction_id);
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
        PERFORM validate_posted_transaction(OLD.transaction_id);
    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM validate_posted_transaction(OLD.transaction_id);
        PERFORM validate_posted_transaction(NEW.transaction_id);
    ELSE
        PERFORM validate_posted_transaction(NEW.transaction_id);
    END IF;

    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION protect_posted_entries()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_status VARCHAR;
    v_id BIGINT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT status INTO v_status
        FROM ledger_transactions
        WHERE id = OLD.transaction_id
        FOR UPDATE;

        IF v_status = 'posted' THEN
            RAISE EXCEPTION
                'Entries of posted transactions cannot be changed.';
        END IF;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT status INTO v_status
        FROM ledger_transactions
        WHERE id = NEW.transaction_id
        FOR UPDATE;

        IF v_status = 'posted' THEN
            RAISE EXCEPTION
                'Cannot add entries to a posted transaction.';
        END IF;
    END IF;

    RETURN CASE
        WHEN TG_OP = 'DELETE' THEN OLD
        ELSE NEW
    END;
END;
$function$;

CREATE OR REPLACE FUNCTION protect_posted_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.status = 'posted' THEN
        RAISE EXCEPTION
            'Posted transactions are immutable. Use a reversal transaction.';
    END IF;

    RETURN CASE
        WHEN TG_OP = 'DELETE' THEN OLD
        ELSE NEW
    END;
END;
$function$;

CREATE CONSTRAINT TRIGGER ledger_transactions_balance_check AFTER INSERT OR UPDATE ON ledger_transactions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_balance();
CREATE CONSTRAINT TRIGGER ledger_entries_balance_check AFTER INSERT OR DELETE OR UPDATE ON ledger_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_balance();
CREATE TRIGGER protect_posted_transactions BEFORE DELETE OR UPDATE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION protect_posted_transaction();
CREATE TRIGGER protect_posted_ledger_entries BEFORE INSERT OR DELETE OR UPDATE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION protect_posted_entries();
