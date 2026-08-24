# End-to-end tests

These run against a **real MySQL database**, not a mock. That is deliberate: the
defects this suite has caught — a `= NULL` comparison that matched nothing, a
transaction deadlocking against its own connection, a `select: false` column
arriving undefined — are all invisible to a mocked repository, which returns
whatever it was told.

## They run serially

`maxWorkers: 1` in `jest-e2e.json`.

Every suite shares one database. With parallel workers, one suite's cleanup runs
while another counts rows, and the failure is intermittent by construction — the
symptom that led here passed four consecutive runs and failed the fifth, which is
the worst possible signal: enough to look fixed, not enough to be.

Serial execution costs a few seconds. An intermittent e2e failure costs far more,
because the reasonable response to one is to re-run it, and a suite people re-run
is a suite that no longer blocks anything.

## Each suite owns its data

Suites namespace their fixtures (`httpauth-`, `authsvc-`) and delete only their
own rows. Keep that even with serial execution: a suite that deletes by a broad
pattern is one that breaks the next suite to adopt a similar name, and the
failure surfaces far from the cause.
