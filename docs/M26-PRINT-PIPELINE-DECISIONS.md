# The print pipeline — four decisions before any Design Lab code

**Status: a proposal for review. Nothing here is built.**

Written 2026-09-30. Design Lab's deliverable is a print-ready image on an order,
not an editor — *"if you can't produce a print-ready PNG, the editor is
decorative."* Four things are undecided, every one of them upstream of the
first line of code, and each was verified in this repository rather than
assumed.

---

## What the code already settles, and what it rules out

🔴 **The cloud cannot return a print file through the existing client. At all.**

`Api\Client` enforces two ceilings, both with reasons recorded beside them:

| Constant | Value | Why it exists |
|---|---|---|
| `TIMEOUT` | **8 s** per attempt | — |
| `MAX_TOTAL_SECONDS` | **20 s** total | PHP's default `max_execution_time` is 30 s; a process killed mid-flight can leave *"the cache describing itself incorrectly"* |
| `MAX_RESPONSE_BYTES` | **5 MB** | *"A hostile or malfunctioning endpoint must not be able to exhaust a merchant's PHP memory limit"* |

A print-resolution PNG is commonly **5–20 MB**. So a synchronous
render-and-return is not *risky* — it is **excluded by a limit that already
exists for a good reason**, and raising that limit to fit artwork would undo the
protection it was written for.

✅ **And the repository already contains the pattern that replaces it.**
`Connection\PushEndpoint` (M9.4) is how the cloud tells a plugin something is
ready: *"The push carries a version and nothing else. The plugin then **pulls**
through `Config\Synchroniser`, over its own authenticated conditional request —
which is what lets this endpoint be public without trusting anything it
receives."*

📌 **Notify, then pull.** Whatever is decided below, the large payload never
travels inside the request that triggers it.

---

## Decision 1 — Where does the backend actually run?

🔴 **`ENVIRONMENTS.md` says "managed instance" and names no platform**, and this
is the decision every other one waits on.

⚠️ **Rasterisation is a native dependency, not a library choice.** `sharp` ships
platform-specific binaries and needs system libraries; `optionia-app` also
proves that its rasteriser (librsvg) **cannot render `<textPath>` and has no
webfonts at all**, which is why that codebase converts every glyph to an outline
path server-side. A spike that works on this laptop and fails on the production
host verifies nothing.

**Recommendation: a container.** Not for preference — because the dependency is
native and a container is the only way to make "it works here" mean "it works
there". `optionia-app` already ships a `Dockerfile`; this backend has none.

### ✅ Answered 2026-09-30: DigitalOcean

The owner named DigitalOcean. That settles the platform and leaves one sub-choice
that genuinely changes the build, so it is recorded rather than assumed.

📌 **The backend containerises cleanly today.** Verified rather than hoped: it
writes nothing to disk — `grep` for `writeFileSync|mkdirSync|createWriteStream`
across `src/` matches **nothing** outside tests. Its only filesystem read is
`plugin-download.service.ts` listing built plugin zips, which is a build artefact
baked into the image rather than state.

| | What it is | For rasterisation |
|---|---|---|
| **App Platform** | DO's managed PaaS; builds from a Dockerfile | ✅ Works with a Dockerfile — system libraries are ours to install. ⚠️ Ephemeral disk, so no font cache survives a restart, which is another reason fonts ship in the image (Decision 4) |
| **Droplet + Docker** | A VM we administer | ✅ Full control, and a persistent disk if one is ever wanted. ⚠️ Patching, backups and uptime become ours |

**Recommendation: App Platform with a Dockerfile.** The native dependency needs a
controlled image, which a Dockerfile gives; the *server* underneath it does not
need administering, and making it ours would add an operational burden this
project has no other reason to carry.

⚠️ **Either way the disk is treated as ephemeral.** That is not a DigitalOcean
limitation to work around — it is the property that makes Decision 3 (the print
file lives on the merchant's WordPress) and Decision 4 (fonts ship in the image)
correct rather than merely convenient. A pipeline that needed local persistence
would be one restart from losing a merchant's print file.

🔴 **What still needs deciding is memory, and it is not a formality.**
Rasterising at print resolution is memory-bound: a 3000×3000 RGBA bitmap is
~36 MB **decoded**, before the source images composited into it. The smallest App
Platform instances are 512 MB–1 GB, and a render that exceeds the container's
memory is killed by the kernel with no error the application can catch or report.
Sizing is part of Stage 0's spike, not an afterthought — and it is the reason the
spike must run on the real platform rather than on a laptop with 32 GB.

---

## Decision 2 — Who renders, and when?

| | Cost | Trade |
|---|---|---|
| **A. Cloud renders, asynchronously** ✅ | Node + a rasteriser + a job the cron drain already resembles | Needs a queue and a "not ready yet" state on the order |
| **B. Cloud renders, synchronously** ❌ | — | **Ruled out above**: 8 s, 20 s, 5 MB |
| **C. Plugin renders** ❌ | Imagick/GD on shared hosting | Quality is unreliable and untestable across hosts; `optionia-app` shows even a *server* rasteriser cannot do the text |

**Recommendation: A.** The plugin sends the design payload — small, well under
every ceiling — and the render happens where the fonts, the memory and the CPU
are. The customer never waits for it, because the customer has already checked
out.

⚠️ **This introduces a state the order must carry: *not rendered yet*.** A
fulfiller opening an order in the first seconds must see *"the print file is
being prepared"*, never a broken image and never silence. That is a milestone,
not a detail.

---

## Decision 3 — Where does the print file live?

🔴 **This one inverts a decided architecture, whichever way it goes**, so it must
be decided rather than drifted into.

**What is true today:** customer files live on the **merchant's own WordPress**.
`Upload\UploadStore` writes to `wp-content/uploads/`, and M15.6 meters storage
**plugin-side** *because the bytes never reach the cloud* — the heartbeat carries
the cloud's verdict and `UploadEndpoint` refuses there.

| | Cost | Trade |
|---|---|---|
| **A. Cloud stores it** | Object storage — none exists today (`grep` for `s3\|r2\|bucket\|cdn` in `.env.example` matches **nothing**) | Inverts the file architecture; an ongoing bill that scales with merchants' customers, not merchants |
| **B. Plugin stores it** ✅ | Reuse `UploadStore` | Keeps the bytes where every other customer file already is, and where the quota already counts them |

**Recommendation: B**, and the reason is that the hard part is already solved and
**measured**. `UploadStore`'s docblock records a probe: a file written to
`wp-content/uploads/` on a real site and fetched over HTTPS answered **200** —
*"There is no `.htaccess` and no `index.php` in that directory on a default
install — every byte WordPress puts there is served to anyone who knows the
path."* Three layers close it.

⚠️ **A print file needs exactly those layers and one more thought.** It is
*more* sensitive than an upload, not less: it is the customer's artwork composed
onto a product, and a leaked one is a leaked order.

📌 **Flowing with M15.6 rather than against it**: a print file counts against the
merchant's storage quota, which is already built, already enforced, and already
explained to the merchant by `Admin\StorageNotice`.

---

## Stage 0 spike — measured 2026-09-30

Run before writing any Design Lab code, on `@resvg/resvg-js` 2.6.2. Every number
below is from a run on this machine, not an estimate.

### 🔴 The finding that removes a subsystem

**`resvg` renders `<textPath>` from a font FILE. librsvg cannot do either.**

That is the entire reason `optionia-app` converts every glyph to an outline path
server-side — `text-to-path.server.ts` (243 lines) plus `text-fonts.server.ts`
(225 lines), the Google Fonts fetch, the `opentype.js` parse, the synthesised
italic and bold, and the `os.tmpdir()` cache. **~470 lines and a third-party
runtime dependency, all of it working around a limitation `resvg` does not have.**

Verified three ways rather than assumed: a byte-count against an identical blank
canvas (4,506 vs 957 — glyphs drew), and two rendered images inspected directly,
one at 600×200 and one at 3000×3000 composited over a dense source. Kerning,
baseline and curve were correct in both.

### Measured cost, with a photo-like source

| Canvas | PNG out | RSS delta | Time |
|---|---|---|---|
| 2000×2000 | 0.2 MB | +45 MB | 73 ms |
| 3000×3000 | 0.4 MB | +76 MB | 145 ms |
| 4000×4000 | 0.6 MB | +128 MB | 252 ms |

Peak process RSS across the whole run: **300 MB**.

### What the numbers change

✅ **A 1 GB App Platform instance is sufficient**, with room for concurrency. The
earlier worry — that a 3000×3000 RGBA bitmap is ~36 MB decoded and might exceed a
512 MB container — is real but not close: the measured delta at that size is
76 MB including the source.

⚠️ **The PNG is 0.4 MB, not the 5–20 MB assumed in Decision 2.** That is *within*
`MAX_RESPONSE_BYTES` (5 MB). 🔴 **It does not reopen the synchronous option.** The
ceiling was only one of three reasons; the 8-second attempt and 20-second total
budget stand, a real product photograph compresses worse than this synthetic
source, and a merchant's print file must not depend on a customer's checkout
request completing. Async stays — but the reasoning is now the timeout, not the
size, and that correction belongs in the record.

📌 **145 ms at 3000×3000 means the job is quick and the queue is short.** The
async design is about *reliability*, not duration.

### Audit, same day — six findings, two of which change the design

Stage 0's result was re-interrogated rather than accepted. Three claims held, two
things are genuinely wrong, and **one of my own findings was itself wrong**.

#### ✅ Held

- **Embedded rasters, clip-paths and opacity all render** — data URIs are how a
  product photo is composited, and clip-paths are the frames/shapes system.
- **A remote `href` is IGNORED**, in 7 ms. No fetch, so no SSRF from a
  merchant-supplied SVG and no hidden network call in the order path. ⚠️ Worth
  stating because `optionia-app` *does* fetch fonts at render time.
- **A missing font family falls back** rather than vanishing.

#### 🔴 F1 — An unbounded canvas is an OOM kill, and it killed the test run

The first hostile-input batch **died at exit 137 — OS-killed.** Isolated:

| Input | Result |
|---|---|
| Billion laughs | ✅ throws catchably |
| Malformed XML | ✅ throws catchably |
| Empty string | ✅ throws catchably |
| **50000×50000 canvas** | 🔴 **rendered — 46 s, 9.8 MB PNG, ~10 GB RGBA** |

🔴 **Three fail safely; the fourth SUCCEEDS, which is worse.** It consumes the
container until the kernel kills it, and a kernel kill produces **no error the
application can catch, log, or report**. `optionia-app` has no such bound either.

**Dimensions must be validated against a ceiling before any render call exists**,
together with a hard render timeout — 46 seconds was reachable on a laptop.

#### ✏️ F2 — Corrected: this is tofu, not blanks, and it is far less severe

**My first measurement was wrong, and the method was the reason.** A byte-count
heuristic classified Greek, Hebrew and Arabic as "blank" against a threshold.
Rendering them and **looking** disproved it: with only Arial supplied, Greek,
Hebrew and **Arabic all draw correctly, shaped and right-to-left**. Arial covers
them.

The real gap is narrower and **visible rather than silent**: Japanese renders as
`□□□□□` — tofu boxes. A merchant sees something is wrong instead of receiving a
blank print file.

📌 **`resvg` chains fallback across supplied font files**, verified: given Latin
plus a CJK file, `Gift ありがとう` renders in one string. So coverage is a
packaging decision, not an architectural one.

**Cost of closing it:** CJK is the expensive script — ~25 MB for a Hiragino-class
family — where Arabic is under 1 MB and Greek/Hebrew/Cyrillic are free with a
normal Latin font.

⚠️ **The lesson is methodological and applies beyond fonts**: a byte-count
threshold is a proxy, and a proxy that decides a finding must be checked against
the thing itself. Two of the three "blank" results were artefacts of my test, not
defects in the renderer.

#### ⚠️ F3 — ~470 lines is an estimate of mine, not a measurement

`text-to-path.server.ts` (243) plus `text-fonts.server.ts` (225) is a file count.
Some metric work may still be needed for the editor's shrink-to-fit, so this is
**"~470 lines avoided", not "470 lines deleted"**.

#### Gaps carried forward

- **G1** No dimension ceiling and no render timeout anywhere — F1 makes both
  prerequisites rather than hardening.
- **G2** Font packaging: Latin covers more than expected, CJK costs ~25 MB, and
  the failure is tofu rather than silence. Decided below.

---

## Decision 4 — Fonts

🔴 **Self-hosted, and this is the one place to diverge from `optionia-app`
without hesitation.**

What that codebase does, and why it is a warning rather than a model:

- librsvg has no webfonts and cannot render `<textPath>`, so **every glyph is
  converted to an outline path** server-side. That part is necessary and should
  be ported.
- The TTFs are fetched **from Google Fonts at request time**, parsed with
  `opentype.js`, cached in `os.tmpdir()` — **ephemeral on containers**, so cold
  starts re-fetch. A third-party dependency sitting inside the order pipeline.
- Italic and bold are **synthesised** (oblique skew, stroke-bolding) for families
  lacking those faces, to match what a browser does.
- The curated font list is a **landmine**: *"A combined CSS2 request that asks
  for an unavailable axis … makes Google return HTTP 400 for the WHOLE
  stylesheet, so none of the fonts load."* One wrong entry silently kills every
  font on the storefront.

**Recommendation: ship the TTFs in the repository**, and with `resvg` this is
simpler still: the renderer is handed font *files* directly and needs no
conversion step at all. A font that cannot load is a print file that cannot be
produced, and a font fetched at request time is one network call away from that.

### Licensing — verified 2026-10-02, SIGN-OFF OUTSTANDING

🔴 **M26d.3 asks for this explicitly and nothing recorded it.** The milestone's
wording is unusually emphatic — *"a curated, licence-cleared list — **verify
print/embedding rights**, not just web use"* — because a webfont licence and a
print-embedding licence are different grants, and print-on-demand is commercial
reproduction of the glyphs. `TEXT_FONTS` had shipped eight families into the
type system with no licence check anywhere in the repository.

**What was verified**, against `github.com/google/fonts` — Google's own
repository, which is where the TTFs will come from:

| Font | Directory | `license:` | Reserved Font Name |
| --- | --- | --- | --- |
| Roboto | `ofl/roboto` | OFL | no |
| Open Sans | `ofl/opensans` | OFL | no |
| Montserrat | `ofl/montserrat` | OFL | no |
| Lato | `ofl/lato` | OFL | **yes** |
| Oswald | `ofl/oswald` | OFL | no |
| Playfair Display | `ofl/playfairdisplay` | OFL | **yes** |
| Dancing Script | `ofl/dancingscript` | OFL | **yes** |
| Pacifico | `ofl/pacifico` | OFL | no |

**All eight are SIL Open Font License.** The OFL text grants, verbatim:

> *"Permission is hereby granted, free of charge, to any person obtaining a copy
> of the Font Software, to use, study, copy, merge, **embed**, modify,
> redistribute, and sell modified and unmodified copies"*

and

> *"The fonts, including any derivative works, can be **bundled, embedded,
> redistributed and/or sold** with any software"*

📌 **That is the grant M26d.3 was asking about**, and it is explicit about
embedding and about selling. Two conditions attach, and neither binds us:

- **Fonts may not be sold by themselves.** We sell a design service; the fonts
  travel inside it.
- **A Reserved Font Name may not be used by a MODIFIED version.** Three of the
  eight declare one. We ship the TTFs unmodified, so the clause does not
  engage — but it would the moment anyone subset, re-hint or rename a file,
  which a print pipeline is exactly the sort of thing to do later.

⚠️ **Verifying a licence was a reading task; accepting the exposure was not.**
What the OFL says is above and was checked against Google's own repository.
Whether to carry someone else's fonts inside a paid product is a commercial and
legal judgement, and belongs to the business rather than to the implementation.

### ✅ SIGNED OFF — 2026-10-02, by the project owner (Omi Hasan)

🔴 **Accepted: the eight OFL families may ship as font FILES in this
repository.** The owner was shown the grant, the two conditions and the three
Reserved Font Names before accepting, in those terms. This line is the record
that it happened and when.

**What the acceptance covers, exactly:**

- The **eight families named in the table above**, and no others. A ninth font
  is a new decision, not an extension of this one — `TEXT_FONTS` and the shipped
  files are gated against each other for that reason.
- The files **unmodified**, as published by `github.com/google/fonts`. This is
  what keeps the Reserved Font Name clause from engaging on Lato, Playfair
  Display and Dancing Script.

⚠️ **What would re-open it.** Subsetting, re-hinting, renaming or otherwise
modifying a file engages the RFN clause on those three, and selling the fonts by
themselves is forbidden outright by the OFL. Neither is in scope; both are the
kind of thing a print pipeline reaches for later, which is why they are written
down here rather than remembered.

📌 **Why the files are needed at all, measured rather than assumed**: the Stage 0
spike found that `resvg` renders `<textPath>` **from a font file**, which is what
deletes `optionia-app`'s ~470-line outline-conversion subsystem. M26e.4's
requirement that *"no font needs installing at render time"* is met by shipping
the files, not by converting glyphs.

### Coverage, decided 2026-09-30

The owner answered *"yes maybe"* to non-Latin merchants at launch. **That is the
answer to design for**, because it rules out the one unacceptable outcome: a
merchant discovering the limit from a customer's order rather than from us.

📌 **Latin-plus covers more than expected, for free.** A normal Latin face carries
Greek, Cyrillic, Hebrew and Arabic — all verified rendering correctly, Arabic
shaped and right-to-left. So the gap is **CJK specifically**, not "non-Latin".

**Ship Latin-plus, add CJK when a merchant needs it, and make the limit visible
rather than silent.** The three parts matter together:

1. **Latin-plus at launch** — covers most of the world's shops for ~1 MB.
2. **CJK as an added font pack** (~25 MB) rather than always in the image, because
   it is 25× every other script combined and most merchants never type a kana.
3. 🔴 **Detect unsupported glyphs at AUTHORING time and say so**, in the editor,
   before an order exists. Tofu in a print file is visible but it is visible *to
   the merchant's customer*; the same fact shown in the editor is a supported
   limitation instead of a defect.

⚠️ **Point 3 is the one that must not be dropped for schedule.** Without it this
decision is "we support fewer scripts than we implied", which is the shape of
complaint no amount of documentation answers.

---

## What this unblocks, in order

```text
D1  deployment target        ✅ DigitalOcean, container (2026-09-30)
D2  async render             → the order's "not rendered yet" state
D3  plugin-side storage      → reuse UploadStore's three measured layers
D4  self-hosted fonts        → the rasteriser can be chosen at all
─────────────────────────────────────────────────────────────────────
then Stage 0: spike SVG in → print-resolution PNG out → stored and fetchable
then 26c geometry → 26d authoring → 26e storefront and order
```

⚠️ **Stage 0 cannot be spiked before these four.** A spike picks a runtime, a
transfer model, a storage location and a font strategy **by accident** if they
are not chosen first — and then the spike is the decision, taken silently.

---

## The honest summary

✅ **D1 is answered: DigitalOcean, containerised.** The remaining three are mine
to recommend and yours to accept. None of them is about Design Lab's features,
and all of them decide whether it can ship at all.

⚠️ **One consequence of D1 is not a decision but a measurement**: how much memory
a print-resolution render needs. It is the first thing Stage 0 establishes,
because getting it wrong shows up as a container killed without an error rather
than as a failure the application can report.

📌 **The cheapest finding here is the oldest code.** `UploadStore` already
measured the thing that would otherwise have been discovered by a merchant: that
`wp-content/uploads/` is public by default. Reusing it makes Decision 3 the least
risky part of this pipeline rather than the most.

---

## Stage 26c.0 — what to port, read line by line (2026-09-30)

Before porting `designScene.ts`, it was read rather than estimated. Four things
the plan asserts are **confirmed**, and **one finding of mine was wrong**.

### ✅ Confirmed: the port closure is small and genuinely framework-free

`designScene.ts` is **881 lines, of which 551 are code** — the other 331 are
comments, and they are the *reason to port rather than rewrite*: they carry the
parity reasoning that would otherwise be re-derived.

Its only imports are two local ones: a **type-only** import from `types.ts`, and
exactly **one function** (`clampInside`) from `helpers.ts`. So `helpers.ts` does
not port wholesale — one 4-line function does.

📌 **No React, no Remix, no platform dependency.** The plan's claim holds exactly.

### ✅ Confirmed: the `1.25` line-height defect, counted independently

Five genuine line-height sites across four files — `designScene.ts`,
`DesignSvg.tsx`, `TextDesignLabModal.tsx` (twice) and `text-to-path.server.ts` —
each a bare literal, nothing linking them. (A sixth `1.25` is an unrelated zoom
step in `useCanvasViewport.ts`.) **Export it as a named constant on the way in.**

### ✅ Confirmed, and it moves work OUT of 26c

🔴 **`designScene.ts` contains NONE of the four measured defects.** `grep` for
`object-fit`, `getBoundingClientRect` and `devicePixelRatio` inside it matches
**nothing**. All four live in `useCanvasViewport.ts`, `DesignCanvas.tsx`,
`TextDesignLabModal.tsx` and `text-to-path.server.ts` — which are **26d and 26e**
surfaces, not 26c's.

⚠️ **So M26c.1's instruction to "fix two things on the way in" is misfiled.** The
geometry module is clean; the fixes belong with the editor and the storefront
overlay that actually mix screen space with local space.

### ✅ And `resvg` deletes one of the four outright

The `hhea` baseline defect exists only in `text-to-path.server.ts`, which
computes a baseline from `(ascender + descender) / 2 / unitsPerEm`. `resvg`
renders `<text>` natively and applies `dominant-baseline` itself, so **that file
does not port and that defect does not travel**. Three remain, all in 26d/26e.

### ✏️ Corrected: my "textPath fallback is dead code" finding was wrong

I claimed `designScene.ts` carries droppable librsvg-only machinery, citing a
comment about *"a renderer without `<textPath>`"*.

**Reading the function disproved it.** `arcGeometryFromR` returns the path `d`,
the exact bounding box **and** `ArcParams` from one computation — they are not
separable, and the geometry is shared by every surface. What *is* droppable is
the **consumer**: `ArcParams` is used only by `text-to-path.server.ts`, which
`resvg` makes unnecessary. So a 243-line consumer goes and the producer stays.

📌 **The lesson repeats the font one**: a comment describing why something exists
is not evidence that it can be removed. Both errors came from reading a comment
instead of the code under it.

### The honest port size

| | Lines | Ported? |
|---|---|---|
| `designScene.ts` | 881 (551 code) | ✅ whole |
| `types.ts` — the seven imported types | ~120 of 253 | ✅ the geometry subset |
| `helpers.ts` — `clampInside` | 4 of 168 | ✅ one function |
| `text-to-path.server.ts` | 243 | ❌ `resvg` replaces it |
| `text-fonts.server.ts` | 225 | ❌ fonts ship in the image |

**~1,000 lines in, ~470 avoided** — the earlier "~470 avoided" estimate survives
scrutiny, and is now a count rather than a guess.

---

## Decision 5 — aspect ratio (M26c.3), decided 2026-09-30

🔴 **Every stored coordinate is a fraction of the canvas**, so a design authored
on a square mug photo and assigned to a tall bottle photo **reflows**: text that
fitted the mug stretches down the bottle. The plan is explicit that this must be
decided *"in M26c.3, not after merchants have data"*, because changing it later
is a migration over artwork people have already composed.

⚠️ **`optionia-app` does not solve this.** `buildScene({ width, height, … })`
takes whatever dimensions the caller supplies and nothing records what the design
was authored against — verified in `types.ts`, which has no aspect field. So the
reference has exactly the failure this decision exists to prevent, and porting it
faithfully would port that too.

**Decided: store the authoring aspect with the design and letterbox into it.**

A design records that it was composed at, say, 1:1. On a 2:3 product it renders
inside a centred 1:1 box; the rest of the photo is left alone. The artwork looks
exactly as the merchant composed it, on every product it is assigned to.

📌 **This is what print-on-demand tooling does, and the reason is not aesthetic.**
A design that silently reshapes produces a physical object that is wrong — and
the merchant discovers it after printing, not before. A band of unused photo is a
visible, correctable compromise; a stretched engraving is a reprint.

⚠️ **The rejected alternatives, recorded so they are not re-proposed as new:**

- **Scope a design to one assignment.** Most faithful — nothing reflows because
  nothing is reused — and it makes a merchant with thirty products in one option
  set compose thirty times. The tedium is the defect: they will reuse one design
  anyway by copying, and arrive at the same problem with more steps.
- **Let it reflow and warn.** Cheapest, and matches the reference. The failure is
  invisible until a physical product is wrong, which is the one outcome this
  whole pipeline exists to avoid.

🔴 **The consequence for the persistence contract, stated now rather than
discovered:** the stored aspect is part of the design, not of the assignment. Two
products of different shapes share one design and one authoring aspect; the
*letterbox* differs per product and is computed at render time, never stored.
## Stage 26c.5a — `resvg` vs a browser on curved text, measured 2026-09-30

This gate exists because the arc geometry (`radiusForBox`, `textArcPath`,
`curveBoxTop`, `curveBoxPlace`, `curveRotOrigin`, `arcTextAnchor` — ~500 lines)
was written against a browser's `<textPath>` implementation. If `resvg` places
glyphs differently, every one of those functions needs a compensation layer and
the 26c estimate changes. **Measure before porting, not after.**

**Method.** One SVG, rendered twice: Chromium via Playwright, and `resvg` 2.6.2
with the same font file. A 600 px-wide arc, `startOffset="50%"`,
`text-anchor="middle"`, 48 px Arial, the string `Sarah and James`.

### ✅ The verdict: port the arc geometry unchanged

| Measurement | Result |
|---|---|
| Ink bounding box | **identical to the pixel** — `x[211..584] y[0..52]` both |
| Centroid shift | **(−0.039, +0.123) px** — sub-pixel |
| Best integer offset over ±3 px (49 candidates) | **dx=0, dy=0** — zero wins |
| Column-profile correlation | **0.9977** |
| Mean per-pixel delta | **0.232 / 255** |
| Ink mass ratio (resvg ÷ browser) | **0.888** |

📌 **Glyph *placement* agrees; only *weight* differs.** The bbox matching
exactly, and zero offset beating all 48 alternatives, is the property the port
depends on: `resvg` resolves `startOffset`, `text-anchor` and the arc parameterisation
the same way the browser does. The 11% ink deficit is anti-aliasing — `resvg`
renders glyph edges slightly lighter (`resvg`-only ink: 7 px; browser-only: 224 px,
i.e. one-directional edge softness, not displacement). At print DPI it is invisible,
and it moves nothing.

**No compensation layer is needed. 26c.5c ports the arc functions as written.**

### 🔴 The first measurement was wrong, and it was my decoder, not `resvg`

The first pixel-diff reported **99.35% of pixels differing** and `resvg` ink at
2,297 px against the browser's 317,653 — which would have read as "`resvg` renders
curved text blank." Both images look identical to the eye, so the two disagreed.

⚠️ **The cause: the two PNGs have different colour types.** Chromium wrote
`colorType=2` (RGB, 3 bytes/px); `resvg` wrote `colorType=6` (RGBA, 4 bytes/px).
My decoder hardcoded 4 bytes per pixel for both, so the browser image was
un-filtered with a one-byte-per-row drift that corrupted every row after the first.
**The 99% was measuring my bug.** Reading `IHDR` and decoding each file by its own
colour type gave the numbers above.

📌 **This is the fourth false proxy this session**, after the Arabic byte-count, the
1366×768 aspect assumption, and the shell-grep clip-path comparison. The pattern
is consistent and worth naming: *a cheap proxy that returns a dramatic number is
more likely to be broken than to be a discovery.* The tell here was direction —
a decoder bug cannot make `resvg` render blank while the PNG plainly shows text,
so the implausible result indicted the instrument. The diff now asserts
`raw.length === h * (stride + 1)` and throws on an unsupported colour type or
filter byte, which is the check that would have caught it on the first run.

## Stage 26c.5b — the flat-text path, ported and fuzzed (2026-09-30)

`src/design/text-geometry.ts`: `CHAR_ADVANCE`, `estimateTextLength`,
`wrapTextLines`, `fitTextToBox`, `resolveSceneText`, `textAnchorFor`,
`flatBlockFirstY`, `SceneText`. Port-fidelity ledger: **12 of 27 symbols**, up
from 6.

### ✅ The `1.25` defect, fixed by naming it once

The line height is written out **five times across four files** in `optionia-app`
— `fitTextToBox` (as a local `LINE_H` carrying the comment *"must match
serializeTextNode / the editor line height"*), `serializeTextNode`,
`DesignSvg.tsx`, and twice in `TextDesignLabModal.tsx`. Nothing enforces the
agreement that comment requests.

🔴 **The failure mode is a reprint, not a glitch.** `fitTextToBox` uses the value
to decide how many lines fit and therefore what size to shrink to; the renderer
uses it to space the lines it draws. If they ever differ, text is *measured* at
one line height and *drawn* at another — it fits in the editor and overflows the
print file. The port exports `LINE_HEIGHT` once and both consumers read it.

### ✅ Verified by differential fuzz, not by inspection

The port is a transcription, and a transcription is exactly the kind of work that
looks right while being subtly wrong. Both implementations were compiled and run
side by side over **180,003 comparisons**: Latin, Arabic, Hebrew, Greek,
Cyrillic, Japanese, emoji, combining marks, zero/negative/huge dimensions, and
every present/absent/zero combination of the optional `TextDesign` fields.

**Zero mismatches.** Plus 37 unit tests, including the two subtleties the port
documents:

- **`||` vs `??` is load-bearing.** `wPct || 0.5` treats a stored `0` as
  "unrecorded" and defaults to half the canvas; `xPct ?? 0.5` keeps a `0`,
  because that is a legitimate left edge. Swapping either changes where text
  lands.
- **Code points, not UTF-16 units.** `[...text]` and `for...of` mean an emoji
  counts as one glyph and a surrogate pair is never split across a line break.
  `.length` would measure it as two and shrink text that did not need shrinking.

### ⚠️ Two gates fail by design until 26c.5d, and both are exempted with a stage

`check-reachable` and `check-symbol-reachable` both correctly report the module
as test-only: nothing in the product calls it until `buildScene` lands. Both
exemptions name **M26c.5d** as the removal stage, and the file-scoped exemption
was re-proven non-blanket — a fresh dead symbol in `src/design/` still fails.

### 🔴 Two more false proxies, both self-inflicted, both caught by implausibility

- **The pixel-diff decoder** (26c.5a above) — hardcoded 4 bytes/px across two
  different PNG colour types.
- **The fuzz harness itself.** The first run reported `flatBlockFirstY`
  mismatching wildly. The cause: I called `pick(NUMS)` *separately* in the
  original's and the port's argument lists, and `pick` advances a shared PRNG —
  so the two sides were fed **different inputs**. The other five functions passed
  only because their arguments were bound to variables first. Binding them gave
  zero mismatches.

📌 **Five false proxies this session now**, and the pattern has not varied: a
cheap measurement returning a dramatic number is more often a broken instrument
than a discovery. Each was caught the same way — by asking whether the *magnitude*
was physically possible, not by re-reading the code. A decoder bug cannot make
`resvg` render blank when the PNG visibly contains text; a faithful transcription
cannot be wrong only in its fifth function.

### ⚠️ A gate went quiet, and only its own output said so

Landing 26c.5b exempted the fifth and last file in `check-symbol-reachable.sh`'s
watch path, and the gate reported **"all 0 watched symbol(s) have a consumer
(5 file(s) exempt)"** — passing green while verifying nothing.

Its existing guard was `CHECKED -eq 0 && EXEMPT -eq 0`, which distinguishes
"the parser broke" from "everything is legitimately exempt" — correct, but it
left no signal for the second case. Since every exemption here is temporary by
construction, the gate was set to go silent exactly while the port is most
exposed to drift.

📌 **Now warned, not failed, and that choice is the point.** All-exempt is a true
and expected state, not a defect. Failing on it would block every commit until a
removal stage lands, which teaches people to bypass the gate — the habit that
makes a check worthless. Proven both ways: the warning appears only when there is
nothing to check, and a single non-exempt dead symbol still fails with exit 1.

## M26c.1 complete — 27 of 27 symbols, verified byte-for-byte (2026-09-30)

`buildScene`, `serializeTextNode`, `sceneToSvgString` and the five scene
interfaces land in `src/design/design-scene.ts`, completing the port.

### ✅ The strongest verification available: identical SVG bytes

This module emits strings, so the port could be checked against the original at
the byte level rather than by comparing numbers. Both modules were compiled and
run side by side over **46,837 comparisons** of complete SVG documents, plus
their intermediate scenes and individual text nodes.

**Zero mismatches.** Branch coverage was then confirmed rather than assumed —
across 12,000 generated scenes the fuzz produced clip paths (5,843), alpha masks
(810), curved `<textPath>` (7,969), wrapped `<tspan>` (4,031), inner rotation
(1,400), backgrounds (6,040) and XML escaping (all 12,000). The byte-identical
result is earned, not vacuous.

📌 **This also proves `LINE_HEIGHT` changed nothing.** The sixth occurrence of
`1.25` lived in `serializeTextNode`, which now reads the named constant — and the
emitted markup is byte-identical to the source that used the literal.

### ⚠️ Retiring four exemptions exposed the honest state, and the gates said so

Landing `buildScene` retired the exemptions for `design-geometry.types`,
`layer-geometry`, `text-geometry` and `arc-geometry` — each had named this
milestone as its removal stage, and each now reaches production through
`buildScene`. That is a removal stage working as designed.

🔴 **What it revealed: the geometry tree is complete and nothing in the product
renders a design.** Both gates reported it independently — `check:reachable`
named `design-scene.ts` as the unreachable root, and the symbol gate listed 19
individual symbols with no consumer. Neither was noise.

The four scattered exemptions were replaced by **one at the root**, naming the
real removal stage (M26d.6 dashboard preview, or M26e.1 storefront overlay —
whichever renders a design first). Consolidating at the root is what keeps the
other four modules honest: they are checked normally, and only the root is
excused.

### ✏️ Corrected: a stale milestone label in the gate's own warning

The symbol gate's all-exempt warning named "M26c.5d" — one of the sub-stage
labels F1 established were my invention rather than the plan's. It now names
M26d.6 / M26e.1, which exist.

### 📌 Three test-fixture defects, all caught by the compiler

Writing the tests surfaced three places where my fixtures had invented a shape
the types do not have: `DesignLayer` uses `name` (not `id`) with required `hPct`,
`rot` and `style`; `LayerCrop` requires every field; and `shapeSrc` is
`string | undefined`, not nullable. **Each was a defect in the test, not the
port** — verified against `optionia-app/types.ts` field by field before changing
anything.

⚠️ One genuine inconsistency in the source, recorded rather than silently
resolved: `types.ts` declares `shapeSrc?: string`, while `effectiveShape`'s
inline parameter type widens it to `string | null`. The port follows the
authoritative declaration.

## M26c.2 — the fractions gate, and a rule that had to be narrowed (2026-09-30)

`bin/check-design-fractions.sh` — the 26th gate, satisfying M26c.2's exit clause
*"a CI check that fails on an absolute pixel constant inside the geometry
module"*.

### 🔴 The first spelling was too blunt, and its own first run proved it

The obvious rule — flag any literal ≥ 2 in the geometry module — produced three
hits immediately, and **all three were false positives**:

```
design-scene.ts:131   opacity: (l.opacity ?? 100) / 100
design-scene.ts:152   opacity: ((l.opacity ?? 100) / 100) * ((c?.opacity ?? 100) / 100)
text-geometry.ts:83   curve: Math.max(-100, Math.min(100, design.curve ?? 0))
```

⚠️ **Opacity is a percentage and curve is a slider bound.** Both are unitless and
identical at every canvas size, so neither violates a contract about *spatial*
quantities scaling with the viewBox. A pixel constant is one that **should have
scaled and did not**.

📌 **A rule that cannot tell those apart gets switched off within a week**, which
is how a gate stops being read — the same way an exemption list stops being read
once it holds a symbol nobody can justify. The match is now anchored to the
spatial vocabulary the module actually uses (`x`, `y`, `w`, `h`, `cx`, `cy`,
`fontSize`, `letterSpacing`, `boxW`, `sceneH`, …) assigned a two-digit-or-larger
literal.

### ✅ Proven in three directions, not one

| Probe | Expected | Result |
|---|---|---|
| `const w = 460` (hardcoded width) | FAIL | ✅ caught |
| `fontSize: 48` (hardcoded size) | FAIL | ✅ caught |
| A **comment** reading *"width = 460 and height = 221"* | PASS | ✅ ignored |

🔴 **The third probe is the one that matters.** This project's recurring gate
defect is reading documentation instead of code — the screen-reachability gate
passed *both* its probes by matching a field name inside a comment. These
geometry files are heavily commented and several comments quote real pixel
measurements (*"~221px of drift"*, *"8px on a 460-tall canvas"*). Those are prose
about the defect, not the defect. Comments, block comments, template literals and
string literals are all stripped **before** matching.

The gate also asserts the inverse — that the fraction vocabulary is still present
(117 `Pct` references) — because a rule that only forbids passes trivially on a
module that has stopped doing geometry at all.

## ✏️ Correction — my sub-stage numbering was invented (2026-09-30)

I labelled the port work **26c.5a–5e**. The plan's **M26c.5 is "Cross-surface
parity fixtures"**, something else entirely; the porting work belongs to
**M26c.1**. Commits `e1c261f`, `49be7ea` and the exemptions they added therefore
read as if parity fixtures were underway when they were not.

⚠️ **The work and its ordering were correct; only the labels were wrong.** They
are reconciled from `78f5ed0` onward, and the stale "M26c.5d" in the symbol
gate's warning now names M26d.6 / M26e.1, which exist.

## Where M26c stands

| Stage | Requirement | State |
|---|---|---|
| M26c.1 | Port `designScene.ts` | ✅ **27 of 27**, byte-verified |
| M26c.1 | Name the `1.25` line-height | ✅ `LINE_HEIGHT`, all six occurrences |
| M26c.1 | Fix two visible measured defects | ➡️ **Moved to M26e.1 / M26e.2** — they live in the storefront overlay script, not the geometry module |
| M26c.2 | Fractions enforced in CI | ✅ **Gate 26**, proven in three directions |
| M26c.3 | Aspect policy decided | ✅ Letterbox (Decision 5) |
| M26c.4 | Persist the measured advance ratio | ❌ **Not started** — needs a design entity and migration |
| M26c.5 | Cross-surface parity fixtures | ❌ Not started — the exit gate |

## Audit follow-up — four findings closed (2026-09-30)

An adversarial audit of the M26c.1/M26c.2 work raised four findings. All four are
fixed, and each fix is proven by a probe that made it fail first.

### F1 ✅ The port gate proved NAMES; it now proves more, and says what it cannot

`check-port-fidelity.sh` matched exported symbol names between source and port —
so the source's **seven private functions were invisible to it**, and those are
where the geometry actually lives. `arcGeometryFromR` alone builds every arc path
and bbox. A port that dropped one would still have reported *"every symbol
ported"*, because the gate was never looking.

⚠️ **Found by auditing the gate, not by it.** All seven were present when checked
by hand — but "I checked once" is not a gate, and the next private helper the
source grows would have gone unnoticed. They are now asserted by name, with a
staleness check so the list cannot silently stop matching the source.

📌 **The gate also now states what it does NOT prove.** It matches names; a
symbol whose body is wrong passes every check in it. The behavioural evidence is
the differential fuzzing, and a fourth assertion fails if that evidence
disappears from this document — so the cheap check and the strong one are read
together rather than the cheap one being mistaken for proof.

### F2 ✅ The widened public surface is declared, not left to be rediscovered

The source exports 28 symbols; the port exports 50. That gap looks alarming until
itemised — and an unexplained gap is exactly how an accidental leak hides among
deliberate ones. Thirteen come from `types.ts` and `helpers.ts`, files this port
merges in, so they were always public. The remaining ten are deliberate and are
now listed in the gate with their reasons. **An undeclared new export fails.**

### F3 ✅ The fractions gate watched one directory; design code is coming to three

`check-design-fractions.sh` scoped to the backend's `src/design` alone — correct
on the day it was written, and quietly wrong within one milestone. **M26d builds
a canvas editor in the frontend and M26e a storefront overlay in the plugin**,
and both hold geometry.

🔴 **The editor is the likeliest violator of the three**, because it genuinely
works in pixels — that is its job, and M26c.2's contract is precisely that the
conversion happens in two functions and nowhere else. A gate stopping at the
backend would have been silent exactly where the rule is hardest to keep. It now
scans every design directory across all three repositories, reports how many it
found, and was proven to catch a pixel constant in a frontend directory that did
not exist when it was written.

### F4 ✅ Decision 5 was recorded but not wired — `buildScene` now applies it

The letterbox was decided in M26c.3, documented, tested and **never called**.
`buildScene` is render time, Decision 5 says the letterbox is computed at render
time, and it did not compute one. **A design assigned to a differently-shaped
product would still have reflowed** — the exact defect the decision exists to
prevent, with a passing test suite either side of it.

`DesignScene` now carries a derived `letterbox`, and `buildScene` takes the
optional `authoring` canvas. Legacy designs — every one predating M26c.3 — yield
the full canvas and render exactly as before.

📌 **Proven not to change what renders today**: 12,000 SVG comparisons against
the original with `authoring` varying randomly, **zero mismatches**. The
letterbox is carried for the surfaces that will consume it without altering
current output.

⚠️ **This retired `letterbox.ts`'s module exemption and exposed a real dead
symbol**: `willLetterbox` has no caller. It is not deleted — it answers *"will
this design sit inside a band?"* for the editor to warn a merchant **before** they
save, which its own docblock gives the reason for. Exempted per file, naming
M26d.1. Telling a merchant their artwork will be letterboxed is a supported
limitation; letting them find out from a customer's order is the same defect
wearing different clothes.

### F5 ⚠️ Text alpha is wired for the BROWSER and unverified against `resvg`

**M26d.3 asks for "colour with alpha"**, `TextDesign` documents its colour as
*"Hex colour, with alpha"*, and the source editor records that text opacity is
carried there rather than in a field of its own — *"opacity is handled via the
text color's alpha (ColorInputField isAlphaUsed), no separate slider"*.

The editor now does the same. `composeColor` writes `#rrggbbaa`, and the colour
reaches the SVG as a `fill` attribute untouched by either conversion point.
Browsers accept eight-digit hex in `fill`, so the Design Lab and the storefront
draw it correctly.

🔴 **What is NOT verified: whether `resvg` honours eight-digit hex in a `fill`
attribute.** The rasteriser is not installed yet — it arrives with M26e — so
there was nothing to measure against. Every other claim in this document was
measured; this one cannot be yet, and is recorded as open rather than assumed.

⚠️ **The failure mode if it does not, is silent and total**: an unrecognised
colour value makes an SVG renderer fall back to black, so semi-transparent text
would print as solid black rather than as a lighter shade. That is a wrong
print file, not a missing feature.

📌 **What to do at M26e**, before any print file is produced: render a text at
50% alpha through `resvg` and compare the pixel against the browser's. If it
disagrees, the fix is in the renderer's serializer — emit `fill` plus
`fill-opacity` instead of eight-digit hex — and NOT in the stored shape, which
`TextDesign` has always defined as carrying alpha.
