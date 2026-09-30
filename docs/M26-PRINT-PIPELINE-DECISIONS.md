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

**Recommendation: ship the TTFs in the repository.** The files are needed
server-side for the order image regardless, so fetching them at runtime buys
nothing and adds a failure mode. A font that cannot load is a print file that
cannot be produced.

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
