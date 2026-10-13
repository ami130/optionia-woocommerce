# Applying a new dashboard design

> Written 2026-10-13, before the design arrived, so the answer to *"where do
> these values go"* is a file rather than a search.

**The short version: the dashboard is already themeable.** Colour, radii,
typography and shadows all resolve through tokens defined in one place. There
are **no hardcoded colours anywhere** in the 18 pages and 38 components.

---

## Where the values live

All of it is `src/app/globals.css`, in three blocks:

| Block | What it does |
| ----- | ------------ |
| `@theme` | maps a Tailwind utility to a CSS variable — `--color-primary: var(--primary)` |
| `:root` | the **light** values |
| `.dark` | the **dark** values |

A new palette is largely a matter of replacing the `:root` and `.dark` values.
The `@theme` block only changes if the design introduces a token that does not
exist yet.

---

## The token set as it stands

**Colour** — `background`, `foreground`, `card`, `popover`, `primary`,
`secondary`, `muted`, `accent`, `destructive`, **`success`**, `border`,
`input`, `ring`, plus a parallel `sidebar-*` family.

Each has a `-foreground` partner where text sits on it.

**Radii** — `--radius` with `sm`, `md`, `lg`, `xl` derived from it.

**Type** — `--font-sans`, `--font-heading`, `--font-mono`. `heading` currently
points at `sans`; a design with a separate display face changes one line.

**Values are `oklch`**, not hex. Perceptually uniform, so lightness is
comparable across hues — worth preserving, and worth telling the designer, as
converting a hex palette loses that property.

---

## ✏️ `--success` was added on 2026-10-13, and why it matters

The palette could say *"this failed"* (`--destructive`) and not *"this
succeeded"*. So the two published-state badges reached for raw Tailwind green:

    option-sets/page.tsx       bg-green-100 text-green-900 dark:bg-green-950 …
    option-sets/[id]/page.tsx  border-green-600/30 bg-green-600/10 text-green-700 …

🔴 **Those were the only three hardcoded colours in the dashboard, and they
would not have followed a new design.** A green badge on a palette with no
green is the kind of thing nobody notices until a screenshot.

`--success` now sits beside `--destructive`, at the same lightness and chroma
with the hue rotated, so the pair reads as one family. **If the new design
supplies a success colour, it replaces two values.** If it does not, this is a
question worth asking the designer rather than a gap to leave.

---

## What is NOT tokenised, and is fine

A handful of arbitrary values, each deliberate:

- `rounded-[min(var(--radius-md),10px)]` on small buttons — **token-derived**,
  capping the radius so a 24px control does not read as a pill
- `w-[calc(100%-2rem)]`, `w-[96px]`, `p-[3px]` — single-use layout, not theme

None of these resist a palette change.

---

## What a designer needs to supply

To apply a design cleanly, the useful deliverable is **values, not screens**:

1. the colour pairs above, light and dark, ideally in `oklch`
2. a base radius
3. font families for body, heading and mono
4. a success colour, or a decision that `primary` should carry that meaning

Screens are still worth having — for layout, density and anything the token set
cannot express — but the handover is faster if the values come separately.

---

## What applying it will NOT cover

⚠️ **The storefront runtime is a different codebase.**
`optioniaWooCommercePlugin/assets/css/frontend.css` renders on the *merchant's*
site and inherits the *merchant's* theme by design — see M21c.1 and
`check-theme-inheritance.sh`. A dashboard design does not reach it, and should
not.

⚠️ **The Design Lab canvas** (`src/components/design/`) carries its own
stylesheet, gated by `check-design-store.sh` — which asserts a rule exists for
all **18 canvas classes** and all **38 panel classes** separately. It will
follow the tokens it uses, but a redesign of the canvas itself is separate
work.
