# Subscription Policy

**What happens to your store if a payment fails.**

This is the policy Optionia commits to. It exists because the honest answer to
*"what happens if my card expires?"* should be written down before you need it,
not discovered when it does.

---

## The short version

**We do not switch off your shop because a card failed.**

Your storefront keeps serving the options your customers see, on the
configuration you last published, for as long as the policy below describes.
What pauses first is your ability to *change* things — never your customers'
ability to *buy* things.

---

## What happens, and when

### Day 0 — a payment fails

Your subscription enters a **14-day grace period**.

- Everything works exactly as before. Nothing is restricted.
- We email the workspace owner and anyone with a billing role.
- You can fix the payment method at any point, and the clock stops.

We send **one** message per failed billing cycle, not one per retry attempt.
Four identical warnings read as a broken system, so your card provider's
retries do not each produce an email.

### Day 14 — the grace period ends

If the payment has still not gone through:

- **Your storefront keeps working.** Customers see your options, priced and
  rendered exactly as before, from your last published configuration.
- **Editing pauses.** You can still sign in and see all of your work — but new
  or changed configuration is not accepted until the balance is settled.

Nothing is deleted. Nothing is hidden from your customers.

### Day 44 — rendering pauses

If the account is still unpaid 30 days after the grace period ends, option
rendering on your storefront is suspended.

**You get 7 days' written notice before this happens**, to the same addresses
as the original warning. This is the first step that changes what your
customers see, and it is deliberately the last resort.

### Day 134 — data removal

Your configuration is retained for **90 days** after rendering is suspended, so
that settling the account restores your work intact. After that it is deleted
under our retention policy.

---

## What we will never do

- **Switch off your storefront without warning.** Every step that affects what
  a customer sees is preceded by notice to a verified address.
- **Delete your work silently.** If a plan change leaves you over a limit, we
  tell you what and by how much, and you decide what to remove. We never choose
  for you.
- **Hide your work from you.** Your configuration stays visible in the
  dashboard in every state described above, including after rendering is
  suspended and until the retention period ends.

---

## Plan limits

Separately from payment, each plan includes a set allowance — option sets,
connected stores, team seats, product assignments and storage.

**Storage is enforced on your own server, because that is where the files are.**
We cannot refuse an upload from here — it never reaches us — so we tell your
plugin how much of your allowance is left, and it declines new customer uploads
once it is used. Everything else on your shop keeps working, nothing is deleted,
and your dashboard says so plainly.

**Reaching a limit blocks new work, never existing work.** If you create your
tenth option set on a plan that includes ten, the tenth keeps working and the
eleventh is refused, with a message naming your allowance, your current usage,
and the plan that would raise it.

**If you downgrade below what you already use**, nothing is deleted and your
storefront is unaffected. Your dashboard shows which limits you are over, and
you choose what to remove.

---

## Questions this policy is meant to answer

**"My card expired while I was on holiday. Is my shop down?"**
No. You have 14 days of full function, then your storefront continues serving
while editing pauses. Nothing breaks on day one.

**"I downgraded to Free and I had 30 option sets. Did you delete 20?"**
No. All 30 keep working. You cannot create a 31st, and the dashboard shows you
are over, but nothing is removed unless you remove it.

**"I cancelled. How long do I have to change my mind?"**
Your subscription runs to the end of the period you paid for. After that the
timeline above applies from the day access lapses.

---

## Implementation status

**This section is for our own engineers and is not part of the merchant-facing
promise.** It records which stages are enforced by software today and which are
operational — because publishing a lifecycle the software does not implement is
worse than publishing nothing.

| Stage | Status | Where |
|---|---|---|
| 14-day grace on failed payment | ✅ enforced | `GRACE_DAYS = 14` in `subscription-lifecycle.service.ts` |
| One dunning email per lapse | ✅ enforced | first failure sets `graceEndsAt`; later retries are no-ops |
| **Storefront keeps serving** | ✅ **structural** | `config-delivery` reads no billing state — there is no dependency to fail |
| Over-limit blocks new work only | ✅ enforced | `PlanLimitGuard`, with usage reported on the subscription summary |
| Storefront told the plan state | ✅ shipped | `plan.read_only` and `plan.grace_ends_at` in the config document (M24.5) |
| Storage (`file_storage_mb`) | ✅ **enforced** | plugin-side by necessity: the bytes are on the merchant's own server, so the heartbeat carries the cloud's verdict and `UploadEndpoint` refuses on it. An admin notice tells the merchant, because the refusal itself is deliberately opaque |
| Dashboard read-only after grace | ✅ **enforced** | `SubscriptionGuard`, global via `APP_GUARD`: every tenant-realm mutation is refused once `graceEndsAt` has passed, with `SUBSCRIPTION_LAPSED`. Reads, the storefront and the billing routes are exempt |
| Rendering suspended at day 44 | 🔴 not implemented | operational until built |
| 90-day retention and deletion | 🔴 not implemented | owned by Phase 26b |

✏️ **Two export promises were written and removed before this shipped.** The
first draft said *"you can sign in, see everything, and export"* and *"export is
available throughout"*. `DATA_EXPORT` exists as a capability and **no route
implements it** — it is declared and used by nothing, and export belongs to
Phase 26b / GATE 3. Promising it here would have been a commitment to merchants
that the software cannot keep.

🔴 **The strongest promise is the one that is structurally true.** "We do not
switch off your shop because a card failed" holds because the delivery path has
no billing dependency at all — not because a flag is set correctly. That is the
guarantee least likely to regress, and it is the one merchants care most about.

✅ **Read-only enforcement landed 2026-09-28, and it was this document's own
gap for four days.** M24.5 shipped `plan.read_only` to the storefront and F137
had the plugin render a notice from it, while every write path still accepted
the edit the notice said was paused — so a merchant was *told* their editing had
stopped and it had not. `SubscriptionGuard` closes it with one global guard
rather than 56 route edits, which is what ADR-116 specified and why a new
endpoint is refused by default instead of being silently unguarded.

🔴 **Three things are deliberately still allowed while lapsed**, and each is a
promise in its own right: **reading** everything you have built, because the
policy says you can still sign in and see your work; the **storefront**, which
never stops serving; and the **billing routes**, because a read-only state that
blocked the payment which would lift it is a trap rather than a policy. The last
is enforced as a ceiling — `check-billing-provider.sh` fails if more than two
controllers ever claim the exemption.
