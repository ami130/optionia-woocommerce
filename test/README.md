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

## Coverage is measured here, not by `test:cov`

`npm run test:cov` instruments the **unit** run only. Almost every guard, service
and repository in the auth and tenancy layers has no unit test by design — they
are exercised against a real database — so that report showed them at **0%** and
the overall figure at **28.95%**.

That number was misleading in the dangerous direction. It understated coverage, so
nobody trusted it, so nobody watched it, and the real figure for the security code
was simply unknown.

`npm run test:e2e:cov` reports what these suites actually cover:

```text
All files                     88.19% statements
  jwt-auth.guard.ts          100%
  audit.service.ts           100%
  sessions.service.ts         98%
  tenant.guard.ts             95%
  capability.guard.ts         95%
  team.service.ts             94%
  auth.service.ts             93%
  tenant-scoped.repository.ts 93%
```

Read both. Neither alone describes the codebase: the unit report covers the pure
logic — money and bigint transformers, the permission matrix, config validation,
crypto primitives — and this one covers everything that needs a database to be
meaningful.

## A passing test count is not a passing run

`Tests: 265 passed` can appear beside `Test Suites: 1 failed`. A suite that fails
to **typecheck** contributes zero tests rather than failing ones, so the count
stays green while a whole file did not execute.

This misled three separate mutation checks during Phase 7. Each reported a lower
count than the known total — `0 total`, `35 of 54` — and each looked like a pass
until the suite list was read.

Two habits follow:

- **Read `Test Suites`, not only `Tests`.** The suite line is where a compile
  failure shows up.
- **Treat a count below the known total as a skip, not a pass.** If the suite
  usually runs 54 tests and reports 35, thirteen did not run and the reason is
  almost always a type error introduced by the change under test.

`npm run check` exits non-zero in this case, so CI is not fooled — but a human
reading the summary line is.
