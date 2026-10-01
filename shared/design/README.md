# Design geometry — shared by the API and the dashboard

🔴 **One copy, two consumers, and that is the whole point.** This is the port of
`optionia-app/app/components/design-lab/designScene.ts` (M26c.1): the geometry
that decides where a customer's name lands on a physical object. The editor, the
storefront preview and the print file must agree to the pixel, and the plan calls
re-deriving it *"the most expensive avoidable work in this project."*

It began in `optioniaWooCommerceBackend/src/design/` because the backend was the
only consumer. M26d.1's canvas store is the second, and it lives in the
dashboard — so the geometry moved here before either depended on it, which is
the cheapest moment it will ever be.

## How it is consumed

Both projects alias `@shared/*` to this directory in their own `tsconfig.json`.
There is **no build step and no published package**: these three projects live in
one git repository, so a path alias to TypeScript source is enough, and a
registry would add a version to keep in step for no benefit.

⚠️ **Framework-free, deliberately.** Nothing here imports NestJS, React, Next or
the DOM. A single `import` of either framework would make this unusable by the
other consumer, which is why `check-shared-design.sh` asserts it.

## What is checked

- `check-port-fidelity.sh` — every symbol of the source is ported, including the
  private ones, and the differential-fuzz evidence is recorded.
- `check-design-fractions.sh` — stored geometry is fractions, never pixels.
- `check-shared-design.sh` — this code stays framework-free and importable by
  both projects.
