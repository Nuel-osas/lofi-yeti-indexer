# lofi-yeti-indexer

**Talk to an on-chain NFT collection in natural language.**

A complete reference for the *"index a Sui NFT collection and chat with the data"* pattern. You run three things — an indexer, a REST API, and a tiny browser UI — and by the end a user can type *"show me yetis with halos"* and see 29 cards pop up with images and traits.

The code works as-is against the **LoFi Mystic Yeti** collection on Sui mainnet. Change three constants and it points at any other Sui NFT collection.

**Target package:** [`0xb07b09b0…061bee::mystic_yeti::MysticYeti`](https://suivision.xyz/package/0xb07b09b016d28f989b6adda8069096da0c0a0ff6490f6e0866858c023b061bee) (mainnet, ~5,500 revealed)

---

## Table of contents

1. [Quick start](#quick-start) ← start here
2. [Try these questions](#try-these-questions)
3. [What it does](#what-it-does)
4. [Architecture](#architecture)
5. [Data model](#data-model)
6. [REST endpoints](#rest-endpoints)
7. [Chat endpoint + Groq integration](#chat-endpoint--groq-integration)
8. [Frontend at `/ui`](#frontend-at-ui)
9. [The local-vs-LLM router](#the-local-vs-llm-router)
10. [Rate limits — the honest reality](#rate-limits--the-honest-reality)
11. [Configuration](#configuration)
12. [Troubleshooting](#troubleshooting)
13. [Forking for a different collection](#forking-for-a-different-collection)
14. [License](#license)

---

## Quick start

You need **Bun** (one-line install) and a **free Groq API key** (2-minute signup at [console.groq.com](https://console.groq.com)). That's it — no Docker, no Postgres, no paid services.

```bash
# 1. clone
git clone https://github.com/Nuel-osas/lofi-yeti-indexer.git
cd lofi-yeti-indexer
bun install
```

Then open **two terminals**.

**Terminal 1 — the indexer** (backfills from chain, then live-tails forever):

```bash
bun run indexer
```

You'll see:
```
indexer: watching 0xb07b09b016d28f...::lofinfts_events::*
indexer: 0 NFTs already in db
indexer: no cursor — backfilling from origin
indexer: +50 inserted · 0 updated · 0 skipped · total 50 · 1.2s
indexer: +50 inserted · 0 updated · 0 skipped · total 100 · 1.1s
...
```

Full backfill takes **5–10 minutes** for ~5,500 NFTs on Sui's free public RPC.

**Terminal 2 — the API + UI** (needs your Groq key):

```bash
export GROQ_API_KEY=gsk_your_key_here
bun run api
```

You'll see:
```
api: listening on http://localhost:4100
```

Then open your browser to **http://localhost:4100/ui** and start asking questions.

---

## Try these questions

Open the UI and try each of these — the chat box handles them all. Notice the small `· indexed` or `· via LLM` tag under each answer showing which path handled it.

| Question | Routes to | Why |
|---|---|---|
| `yeti #4737` | indexed | regex match → REST endpoint |
| `yetis with halos` | indexed | trait substring search |
| `show me orange furred yetis` | indexed | trait substring search |
| `what fur colors exist` | indexed | trait-values lookup |
| `how many yetis have halos` | indexed | search + count |
| `yetis with wings` | indexed | 0 matches + suggests alternatives |
| `show me the rarest yetis` | via LLM | Groq picks the right tools |
| `tell me the most unique ones` | via LLM | same |
| `hello` | via LLM | Groq responds naturally |

**~90% of real questions skip the LLM entirely.** Only fuzzy or abstract questions hit Groq, keeping you well under the free-tier rate limit.

---

## What it does

Runs **three processes** that share one SQLite file:

| Process | Role | Port |
|---|---|---|
| **Indexer** | Polls `lofinfts_events`, batch-fetches NFT objects, upserts metadata | — |
| **API** | Hono REST server + Groq-backed `/chat` + static `/ui` | `:4100` |
| **Frontend** | Single `web/index.html` served by the API | `/ui` |

End-to-end flow:

```
Sui mainnet events                        indexed queries
────────────────                          ───────────────
lofinfts_events ──▶ indexer ──▶ SQLite ──▶ REST API ──▶ frontend (/ui)
                     (+ multiGetObjects                │
                      for full Display)                ▼
                                          pattern router (local regex)
                                                │           │
                                     indexed ◀──┘           └──▶ /chat (Groq LLM)
                                     (instant)                   (fallback)
```

Result: students type questions in natural language, frontend answers most of them from local SQL (instant, no rate limit), routes only the fuzzy ones to Groq.

---

## Architecture

### The indexer (`src/indexer.ts`)

- Polls [`suix_queryEvents`](https://docs.sui.io/sui-api-ref#suix_queryevents) for `MoveEventModule { package, module: "lofinfts_events" }`
- Extracts each event's `parsedJson.id` — the NFT object ID
- Dedupes IDs within a page, then batch-fetches via `sui_multiGetObjects` with `showDisplay: true, showContent: true, showOwner: true`
- Parses the attribute `VecMap<String, String>` from `display.attributes.map.contents`
- Upserts a row in `nfts` + wipes-and-rewrites rows in `nft_traits` (so trait changes land on re-reveal)
- Persists the cursor in a `kv` table after every page — safe to kill + restart

Backfill from origin on first boot (about 5–10 minutes for 5,500 NFTs at public-node rate limits), then settles into a 5-second live-tail poll.

### The API (`src/api.ts`)

Hono routes:

- 12 REST endpoints for NFTs, traits, and trait queries (see [REST endpoints](#rest-endpoints))
- `POST /chat` — Groq-backed natural-language interface
- `GET /ui` — serves `web/index.html`

### The chat layer (`src/chat.ts`)

- OpenAI-compatible Groq Chat Completions API
- 7 tools exposed to the model (search, count, get-by-number, list traits, etc.)
- Tool-call loop with retry nudging for malformed calls
- Rate-limit detection with user-actionable wait-time messages
- Current model: `llama-3.1-8b-instant` (500k tokens/day free tier)

### The frontend (`web/index.html`)

Single HTML file, vanilla JS, no build step. Has a **client-side pattern router** that handles most questions via REST before touching the LLM — see [the local-vs-LLM router](#the-local-vs-llm-router).

---

## Requirements

| Tool | Version | Install |
|---|---|---|
| **Bun** | 1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| **Groq API key** | any | free tier at [console.groq.com](https://console.groq.com) |

No Docker, Postgres, or any other service needed. Bun ships SQLite natively with WAL journaling.

---

## Quick start

```bash
git clone https://github.com/Nuel-osas/lofi-yeti-indexer.git
cd lofi-yeti-indexer
bun install
```

Then open **two terminals**:

```bash
# terminal 1 — indexer (backfills from origin, then live-tails)
bun run indexer
```

```bash
# terminal 2 — API + UI (needs your Groq key in the env)
export GROQ_API_KEY=gsk_your_key_here
bun run api
```

Then open **http://localhost:4100/ui**.

What you'll see on first boot:

- Terminal 1: `indexer: fresh db — backfilling from origin`, then `+N inserted · N updated · … total N · Xs` lines as each page of events is processed. Full backfill finishes in ~5–10 minutes on Sui mainnet public RPC.
- Terminal 2: `api: listening on http://localhost:4100` immediately.
- Frontend is live even while the indexer is still backfilling — it reads whatever's in the DB at query time.

### Single-line alternative (bun shell pipelining)

```bash
cd lofi-yeti-indexer && bun install && \
  GROQ_API_KEY=gsk_your_key_here bun run api &
bun run indexer
```

Starts the API in background, then runs the indexer in the foreground so you see backfill progress. `pkill -f 'bun run'` kills both.

---

## Data model

Two tables + a KV:

```sql
CREATE TABLE nfts (
  object_id        TEXT PRIMARY KEY,
  number           INTEGER,               -- e.g. 4737
  name             TEXT,                  -- "Mystic Yeti #4737"
  description      TEXT,                  -- collection blurb
  image_url        TEXT,                  -- https://mysticyetinft.wal.app/images/4737.png
  attributes_json  TEXT,                  -- [{trait_type:"Fur", value:"Orange"}, ...]
  owner_kind       TEXT,                  -- AddressOwner | ObjectOwner | Shared | Immutable
  owner_address    TEXT,                  -- address or kiosk id
  revealed_at_ms   INTEGER,               -- event timestamp
  tx_digest        TEXT,
  event_seq        INTEGER,
  indexed_at_ms    INTEGER NOT NULL
);

CREATE TABLE nft_traits (
  object_id    TEXT NOT NULL,
  trait_type   TEXT NOT NULL,
  trait_value  TEXT NOT NULL,
  PRIMARY KEY (object_id, trait_type),
  FOREIGN KEY (object_id) REFERENCES nfts(object_id) ON DELETE CASCADE
);
CREATE INDEX idx_traits_type_value  ON nft_traits(trait_type, trait_value);
CREATE INDEX idx_traits_value_lower ON nft_traits(trait_value COLLATE NOCASE);

CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- cursor persistence
```

Both storage shapes serve different queries:

- **Full NFT record** → returned in full as a card in the UI
- **Normalized traits** → fast JOIN for "all yetis with Fur=Orange" kind of queries, case-insensitive

---

## REST endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/` | health + indexed count + trait summary |
| `GET` | `/nfts` | paginated list (`?limit=` default 20, `?offset=`) |
| `GET` | `/nfts/:object_id` | full NFT by Sui object ID |
| `GET` | `/nfts/by-number/:n` | full NFT by sequence number (e.g. 4737) |
| `GET` | `/nfts/by-owner/:addr` | all yetis owned by an address / kiosk |
| `GET` | `/nfts/search?q=wings` | case-insensitive substring over ALL trait values |
| `GET` | `/nfts/search?type=Fur&value=Orange` | exact (type, value) match |
| `GET` | `/traits` | `[{trait_type, unique_values, total_rows}, ...]` |
| `GET` | `/traits/:type` | `{trait_type, values: [{trait_value, count}, ...]}` |
| `GET` | `/traits/:type/:value/count` | integer count of matches |
| `POST` | `/chat` | Groq-backed natural language — body: `{"question": "..."}` |
| `GET` | `/ui` | serves the static frontend |

Example:

```bash
curl http://localhost:4100/nfts/by-number/4737 | jq
curl "http://localhost:4100/nfts/search?q=halo" | jq
curl http://localhost:4100/traits/Fur | jq
curl -X POST http://localhost:4100/chat \
  -H 'content-type: application/json' \
  -d '{"question":"show me the rarest yetis"}' | jq
```

---

## Chat endpoint + Groq integration

The `POST /chat` endpoint wraps a Groq Chat Completions call with **7 tools** the model can pick from:

| Tool | When the model calls it |
|---|---|
| `search_by_trait_value(q)` | Vague substring queries — "halo", "orange", "wings" |
| `search_by_trait_exact(type, value)` | Named pair — "Fur = Orange" |
| `get_by_number(n)` | "Show me yeti 4737" |
| `list_trait_types()` | "What traits exist" |
| `list_trait_values(type)` | "What fur colors are there" |
| `count_by_trait(type, value)` | "How many have Fur=Orange" |
| `collection_summary()` | "How many yetis total" |

Each tool is a thin wrapper over a helper in `src/db.ts`. The model picks, we execute the SQL, we send the result back, we repeat until the model is done calling tools.

### Groq specifics

- **Endpoint:** `https://api.groq.com/openai/v1/chat/completions` (OpenAI-compatible)
- **Model:** `llama-3.1-8b-instant`
  - Free tier: **6,000 TPM**, **500,000 TPD**
  - Switched from `llama-3.3-70b-versatile` because the 70B hit daily limits mid-session
- **Key:** read from `GROQ_API_KEY` env var, never stored on disk
- **Response shape** from `/chat`:
  ```json
  {
    "answer": "Found 29 matching yetis.",
    "nfts": [ /* shaped NFT records */ ],
    "trace": [{ "tool": "search_by_trait_value", "args": {"q":"halo"}, "rows_or_result": "29 rows" }]
  }
  ```

### Error handling

- Malformed tool calls from the model (known Groq/Llama issue) → retry up to 4 times with an explicit nudge
- Rate limits → surface the actual "try again in Ns" window to the user instead of a generic error
- If NFTs were already collected before a failure, return them with a "Found N matching yetis" answer rather than hiding them behind an error

---

## Frontend at `/ui`

Single file `web/index.html`. Vanilla JS, inline CSS, no build, no React, no framework.

Features:
- **Chat input** with history, user + assistant message bubbles
- **Suggested query chips** — halos, orange fur, yeti #4737, wings (graceful no-match), etc.
- **NFT grid** that renders cards with image + top 4 attributes as chips
- **Loading dots** during LLM calls
- **Error banners** for rate-limits / network issues
- **Source tag** — every answer shows a dim "· indexed" or "· via LLM" label so students see which path fired

The HTML is served by the API (`GET /ui`), so there's no separate frontend server and no CORS config needed.

---

## The local-vs-LLM router

The frontend inspects every question before it fires. If the question matches a known pattern, it routes to a direct REST endpoint and skips Groq entirely. If no pattern matches, it falls back to `/chat`.

**Routing rules**, in order:

1. `/#?(\d{1,5})/` → `GET /nfts/by-number/N`
2. `"how many X"`, `"count X"` → `GET /nfts/search?q=X` → return `.rows.length`
3. `"what traits"`, `"list traits"` → `GET /traits`
4. `"what <type>s exist"` → `GET /traits/:type`
5. Single trait-word queries ("halo", "orange fur", "yetis with wings") → `GET /nfts/search?q=…`
6. Fuzzy / abstract ("rare", "most unique", "best") → `POST /chat` (Groq)

Why it matters:

- **90% of real student questions hit paths 1–5** → instant response, zero Groq tokens
- **The 10% that really need reasoning** → LLM still there, but now well within the TPM budget
- **Transparency** — every answer shows `· indexed` or `· via LLM` so it's honest about what's happening

If you want to see the routing in action, look at `tryLocalRoute()` in `web/index.html`.

---

## Rate limits — the honest reality

Groq free tier on `llama-3.1-8b-instant`:

| Bucket | Limit |
|---|---|
| Tokens per minute (TPM) | 6,000 |
| Tokens per day (TPD) | 500,000 |
| Requests per minute (RPM) | 30 |

A typical chat query uses ~1,500–2,000 tokens round-trip (system prompt + tools + user + tool-call + tool-result + final answer). That's **3–4 LLM queries per minute** at free-tier ceilings.

**The client-side router is how we dodge this:** by routing 90% of queries straight to REST, the 6k-TPM budget is plenty for the rest.

If you need more headroom for a workshop with 20+ students hammering the UI:

- Top up at [console.groq.com/settings/billing](https://console.groq.com/settings/billing) — $5 one-time deposit pushes you to Dev Tier (30k TPM / millions TPD)
- Or swap the URL + model in `src/chat.ts` to point at Ollama (`http://localhost:11434/v1/chat/completions`, model `qwen2.5:7b-instruct`) for unlimited local inference at the cost of laptop heat

---

## Configuration

All config is in env vars and a handful of constants:

### Env vars

| Name | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | yes | — | Bearer token for Groq. If missing, `/chat` returns 500 with a clear message. |

### Constants in `src/indexer.ts`

| Name | Default | Change when… |
|---|---|---|
| `PACKAGE_ID` | MysticYeti mainnet pkg | Forking for a different collection |
| `EVENT_MODULE` | `"lofinfts_events"` | Target uses a different event module |
| `NFT_TYPE` | `<PACKAGE>::mystic_yeti::MysticYeti` | Different NFT struct type |
| `POLL_MS` | `5000` | You want snappier or slower polling |
| `EVENT_PAGE` | `50` | Different `queryEvents` page size |

### Constants in `src/chat.ts`

| Name | Default | Change when… |
|---|---|---|
| `GROQ_URL` | Groq API | Swapping to Ollama / another provider |
| `MODEL` | `"llama-3.1-8b-instant"` | Different model or tier |
| `MAX_ITER` | `6` | Chat loop needs more / fewer rounds |

---

## Troubleshooting

**Indexer fills up but then shows 0 new events for a long time**
You're at live tail. New reveals are infrequent on a ~fully minted collection. The indexer is healthy.

**`Error: script "indexer" was terminated by signal SIGTERM`**
Something killed the process (probably a `pkill`). Just restart with `bun run indexer`. The cursor persists, so it resumes where it left off.

**`api: listening on :4100` but `/ui` returns 404**
You started the API from the wrong working dir. `cd` into `lofi-yeti-indexer/` first — the static file read is relative.

**Chat returns `"I hit a snag…"` every time**
You're probably rate-limited. Check `/tmp/yeti-api.log` — if you see `[groq 429]`, either wait for the TPM window or top up / swap model.

**Frontend loads but images don't render**
NFT images are hosted at `mysticyetinft.wal.app` (Walrus). If your network can't reach that domain, images show broken. Metadata is still in the DB.

**Query for a number that doesn't exist (`yeti #9999`)**
Returns `{"error":"no yeti with number 9999"}`. Normal behavior — most of those numbers don't exist or aren't revealed yet.

**`GROQ_API_KEY env var not set` on first `/chat`**
You started the API without the env var. Kill and restart with `GROQ_API_KEY=gsk_... bun run api`.

**The model answer says "this yeti has wings" but the NFT grid shows no wings**
Llama 8B sometimes confabulates text summaries. The grid is the source of truth — attributes displayed there come straight from the indexed Display data, not the model.

---

## Forking for a different collection

Three constants in `src/indexer.ts`, one file in `web/`, done.

1. **Find your target:**
   - Package ID
   - Event module that emits mint / reveal events (check [Suivision](https://suivision.xyz/))
   - NFT struct type (e.g. `0xpkg::my_nft::MyNFT`)

2. **Edit `src/indexer.ts` constants:**
   ```ts
   const PACKAGE_ID = "0xYOUR_PACKAGE";
   const EVENT_MODULE = "your_events_module";
   const NFT_TYPE = `${PACKAGE_ID}::your_module::YourType`;
   ```

3. **Adjust `parseNft()` if your attribute shape differs.** The default handles Sui's canonical `Display` + `VecMap<String, String>` pattern — works for ~90% of Sui NFTs. If your collection uses a custom attribute struct, update the parser.

4. **Update the suggested chips** in `web/index.html` to match your collection's traits.

5. **Update the system prompt** in `src/chat.ts` to reference your collection's name instead of "Mystic Yeti".

Everything else — the API, the client-side router, the chat loop — is collection-agnostic.

---

## License

Apache-2.0.

## Credits

Built by [@minting_ruru](https://x.com/minting_ruru) as a workshop reference for the Sui Dev Ambassador program. Indexed data is the property of [LoFi NFTs](https://lofinfts.com). LoFi Mystic Yeti collection details at [mysticyetinft.wal.app](https://mysticyetinft.wal.app).
