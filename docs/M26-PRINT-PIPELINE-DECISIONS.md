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