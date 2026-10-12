# Unaided tester session — Gate 2

> **Gate 2 criterion:** *"Builder usable without documentation (validated on 3
> non-team testers)."*
>
> 🔴 **"Unaided" is the whole measurement.** Phase 20 ticked this once and the
> tick was downgraded to `[~]`, because it had graded the team's own usability
> from the inside. A session where the observer explains anything measures the
> explanation, not the builder.

This is the observer's script. The tester never reads it.

---

## Before the session

**Each tester needs a fresh account.** The funnel is per-tenant and retroactive,
so a reused account starts mid-way and the run measures nothing.

Have ready, and do not send in advance:

- the dashboard URL
- a WooCommerce store they can connect, with at least one product
- somewhere to record timings

**Recruit outside the team.** Anyone who has seen the builder, read the plan, or
heard it described is not a non-team tester. Three people who run an online shop
is the target; three people who have built one is the useful minimum.

---

## What you say, exactly once

> *"You sell a product that customers can personalise — engraving, a colour, a
> size, whatever fits. Set that up so it appears on your product page and a
> customer can buy it. I'm not going to help, and that isn't rudeness: I'm
> measuring whether the product explains itself. Think aloud if you can. If you
> get stuck for five minutes, say so and we'll stop — that's data, not failure."*

Then say nothing. **Not even encouragement** — "you're nearly there" tells them
they are on the right path, which is the thing being measured.

If they ask a direct question, answer: *"What would you do if I weren't here?"*

---

## The eight steps you are timing

These are the product's own funnel stages, in its own words. A tester reaching
`published` has met the criterion.

| # | The product's label | Reached when |
|---|---|---|
| 1 | Create your account | registration completes |
| 2 | Verify your email | they click the link |
| 3 | Install the Optionia plugin | the plugin is active on their store |
| 4 | Connect your store | the dashboard shows the store connected |
| 5 | Sync your products | their catalogue appears |
| 6 | Create your first option set | a set exists with at least one option |
| 7 | Assign it to a product | the set names a product |
| 8 | **Publish** | ⬅ **the criterion** |

Two further stages exist and are **not** part of this criterion — note them if
they happen, do not steer toward them: *A customer chooses an option* and *An
order arrives with options*.

---

## What to write down

For each step: **start time, end time, and every stuck moment.**

A stuck moment is anything that costs more than ~30 seconds of visible
searching, re-reading, or a wrong turn they then undo. Record what they tried
first — the wrong first guess is usually the finding.

Also record:

- **where they looked for help** — a menu, a tooltip, the top of the page, or
  straight to a search engine. The last one means the product did not explain
  itself
- **what they called things.** If they say "add-on" or "extra" where the product
  says "option set", that is a vocabulary mismatch worth more than most bugs
- **anything they tried that did nothing.** A control that looks clickable and
  is not reads as broken

⚠️ **Stop the clock at five minutes stuck on a single step.** Record it as not
reached and move on, or end the session. A tester grinding for twenty minutes
produces a frustrated person and one data point you already had at minute five.

---

## Afterwards — ask these, in this order

1. *"Walk me through what you just did."* — a tester who cannot narrate it did
   not learn the model, even if they reached publish
2. *"What did you expect to happen that didn't?"*
3. *"Was there a point you nearly gave up?"*
4. *"If a friend asked what this does, what would you say?"* — their answer is
   your positioning, tested

**Do not ask whether they liked it.** They will say yes.

---

## What closes the criterion

**Three testers reach step 8 unaided.** Not "with a nudge", not "after I showed
them where the button was". A session where you intervened is a session that
measures something else — keep it, label it, and run another.

A tester who does not reach publish is a result, not a wasted session. The step
they stopped at is the most valuable output this exercise produces.

---

## Recording the result

The funnel measures this already: **`GET /v1/activation/me`**, authenticated as
that tester. After three sessions:

- confirm each tester's tenant reached `published` in the funnel, not only in
  your notes. ⚠️ **There is no platform-wide funnel route**, deliberately —
  `ActivationService.funnel()` exists and the controller states it is *"not
  exposed here"*. So this is three per-tenant checks, each signed in as the
  tester, not one aggregate query
- the funnel is **retroactive and deliberately not monotone**: a tester who
  connected and later disconnected still counts as having reached `connected`.
  That is correct, not a bug

Then the Gate 2 line can move from `[ ]` to `[x]` **with the evidence attached**
— three tenant ids and their timings. The gate block's own rule: *"a tick with
nothing after the dash is a tick nobody can check."*
