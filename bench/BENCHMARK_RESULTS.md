# Knowledge-Graph Scaling Benchmark

In-process measurements on Windows / Node 22 / Oxigraph 0.5.8 — bench
scripts in this directory: `inproc_bench.mjs` (full pipeline) and
`isolate_bench.mjs` (per-operation breakdown).

Layout of synthetic data per "fact":
- 4 quads in `urn:ontofelia:worldview` (type, label, livesIn, worksAt)
- 12 quads in `urn:ontofelia:claims` (two `core:Claim` provenance objects)
- 1 quad in `urn:ontofelia:evidence`
- ~17 quads/fact total

## A. Full pipeline cost (`KnowledgeEngine.storeFact()`)

Every call exercises: reasoner.materialize (twice inferTriples) → conflict
SELECT → INSERT worldview triple (flush) → INSERT claim block (flush) →
INSERT evidence block (flush) → optional INSERT inferred triples (flush).

| Facts | Total triples | dataset.nq | Bulk load | Graph dump (worldview) | First store | Steady avg / store |
|---:|---:|---:|---:|---:|---:|---:|
| 0     | 311      | 0 KB    | 10 ms    | 2 ms (7 KB)      | 28 ms      | **21 ms**     |
| 500   | 9 311    | 1 MB    | 69 ms    | 11 ms (201 KB)   | 74 ms      | **111 ms**    |
| 3 000 | 54 311   | 6 MB    | 598 ms   | 76 ms (1.2 MB)   | 325 ms     | **619 ms**    |
| 10 000| 180 391  | 20 MB   | 3.6 s    | 256 ms (4 MB)    | 1.1 s      | **2.2 s**     |
| 30 000| 540 691  | 61 MB   | 37 s     | 1.7 s (12 MB)    | 7.2 s      | **13.2 s**    |
| 60 000| 1 081 141| 122 MB  | **3 min**| 2.3 s (24 MB)    | 10.6 s     | **26.6 s**    |

Boot time is the **bulk load** column — that is how long the gateway takes
to read `dataset.nq` and rehydrate the in-memory store on every restart.

## B. Per-operation cost (isolated, `urn:ontofelia:worldview`)

`reason1` and `reason2` are the two `inferTriples` calls inside
`ReasonableEngine.materialize`. SPARQL queries hit `urn:ontofelia:claims`.

| Facts | Total | ABox dump | `getGraph` | reason base | reason +new | ASK claims | SELECT clms | INSERT+flush |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 000  | 9 198    | 304 KB   | 27 ms   | 42 ms    | 39 ms    | 3 ms  | 2 ms  | 14 ms   |
| 5 000  | 45 203   | 1.5 MB   | 106 ms  | 196 ms   | 193 ms   | 7 ms  | 7 ms  | 113 ms  |
| 15 000 | 135 353  | 4.5 MB   | 403 ms  | 713 ms   | 728 ms   | 18 ms | 18 ms | 279 ms  |
| 30 000 | 270 578  | 9.2 MB   | 596 ms  | 1 770 ms | 1 667 ms | 35 ms | 32 ms | 599 ms  |
| 60 000 | 541 028  | 18 MB    | 1 552 ms| 5 583 ms | 5 171 ms | 72 ms | 66 ms | 1 464 ms|

## C. Where the time goes (≈ 270k triples)

```
storeFact() ≈ 13 s  total
├── getGraph(worldview)        ~600 ms   serialise 9 MB Turtle
├── reasoner.materialize       ~3 400 ms  inferTriples × 2
├── findConflictingClaims      ~30 ms    (negligible, oxigraph index)
├── INSERT worldview triple    ~600 ms   ~30 MB dataset.nq flush
├── INSERT 11 claim triples    ~600 ms   another full flush
├── INSERT 4 evidence triples  ~600 ms   another full flush
├── INSERT N inferred triples  ~600 ms   another full flush
└── ... small overhead from supersession DELETE/INSERT
```

The dominant cost shifts as the KG grows:
- < 10 k triples — reasoner is amortised, mostly INSERT cost
- 10–100 k triples — flush (writing dataset.nq) dominates
- > 100 k — reasoner.materialize dominates (O(N) Turtle parse + reason × 2)

## D. Practical breakpoints

| KG size | Per-message latency | User experience |
|---:|---:|---|
| **≤ 10 000 triples**   | < 100 ms      | snappy, real-time |
| **~ 50 000 triples**   | ~ 600 ms      | noticeable but fine |
| **~ 180 000 triples**  | ~ 2.2 s       | sluggish — visible lag per turn |
| **~ 540 000 triples**  | ~ 13 s        | unusable for interactive chat |
| **~ 1 100 000 triples**| ~ 27 s        | broken; 3 min boot every restart |

At 17 quads/fact this maps to:
- 600 user facts ≈ 10 k triples — comfortable
- 30 000 user facts ≈ 540 k triples — UX failure mode
- 60 000 user facts ≈ 1 M triples — unusable

## E. What scales well, what doesn't

| Component | Cost growth | Note |
|---|---|---|
| Oxigraph SPARQL ASK/SELECT       | **sub-linear**  | indexes are well-built — even 540k triples respond in ~70 ms |
| Oxigraph in-memory store         | O(N) memory     | 1 M quads ≈ ~500 MB resident |
| `dataset.nq` persist (flush)     | **O(N) on every mutation** | architectural — the adapter dumps the whole dataset to disk each update |
| `getGraph` Turtle serialisation  | **O(graph size)** | called once per `storeFact` and once per reasoner pass |
| `inferTriples` (reasonable)      | **~ O(N) Turtle parse + closure** | called TWICE per storeFact |
| Bulk load on boot                | O(N) Turtle parse | 1 M triples ≈ 3 min cold start |

## F. Likely mitigations (not yet implemented)

1. **Stop dumping the entire dataset on every mutation.** The
   `OxigraphAdapter` calls `flush()` after every INSERT / DELETE / putGraph.
   With 30 MB+ datasets that's the single biggest hit per call. Either
   debounce (flush at most every N seconds / N mutations) or switch to
   oxigraph's persistent on-disk backend so writes go straight to disk.

2. **Don't pass the full ABox turtle to the reasoner on every store.**
   Pass only triples touching the new fact's subject (1–2 hops). Drops the
   reasoner from O(N) to O(degree). Materialised closure can be rebuilt
   periodically rather than on the hot path.

3. **Per-graph reasoning gate.** Skip materialisation if
   `aboxBytes > threshold` (e.g. 5 MB) — log it so an offline job can
   reconstruct the inferred graph later. Crucial for chat latency.

4. **Lazy claim/evidence flush.** Group claim, evidence, and inferred
   inserts into one transaction — at most one flush per `storeFact`.

5. **Server-side `dataset.nq` writes via append.** Today the adapter
   writes a temp file then renames; for a 122 MB dataset that's gigabytes
   of write per turn. The N-quads format is line-oriented and trivially
   append-able for inserts.

## G. Reproducing

```powershell
cd %USERPROFILE%\dev\Ontofelia
ontofelia gateway stop
node bench/inproc_bench.mjs "0,500,3000,10000,30000,60000"   # full pipeline
node bench/isolate_bench.mjs "1000,5000,15000,30000,60000"   # per-op
```

Each level spins up its own temp Oxigraph store under
`%TEMP%\ontofelia-bench-*`, runs the bulk load + measurements, then
tears the directory down. The running gateway is not touched (data file
is independent).
