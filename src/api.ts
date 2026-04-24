// REST API for the LoFi Mystic Yeti indexed data.
//
// Endpoints:
//   GET  /                           health, counts, trait summary
//   GET  /nfts                       paginated list
//   GET  /nfts/:id                   by object_id
//   GET  /nfts/by-number/:n          by NFT number (e.g. 4737)
//   GET  /nfts/by-owner/:addr        all owned by address
//   GET  /nfts/search?q=wings        case-insensitive substring over ALL trait values
//   GET  /nfts/search?type=Fur&value=Orange    exact trait match
//   GET  /traits                     { trait_type: [{ value, count }, ...] }
//   GET  /traits/:type               values + counts for one trait type

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  allTraitTypes,
  countByTrait,
  getByNumber,
  getByObjectId,
  getTraitsFor,
  listByOwner,
  listNfts,
  searchByTraitExact,
  searchByTraitValue,
  totalCount,
  traitValuesFor,
} from "./db";
import { chat } from "./chat";

const app = new Hono();
app.use("/*", cors());

// Shape nft rows for JSON output — parse attributes_json back into an array.
function shapeNft(row: Record<string, any> | null) {
  if (!row) return null;
  return {
    ...row,
    attributes: row.attributes_json ? JSON.parse(row.attributes_json) : [],
    attributes_json: undefined,
  };
}

app.get("/", (c) =>
  c.json({
    ok: true,
    indexed: totalCount(),
    traits: allTraitTypes(),
  }),
);

app.get("/nfts", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const rows = listNfts(limit, offset).map(shapeNft);
  return c.json({ count: rows.length, rows });
});

app.get("/nfts/by-number/:n", (c) => {
  const n = Number(c.req.param("n"));
  if (!Number.isFinite(n)) return c.json({ error: "invalid number" }, 400);
  const row = shapeNft(getByNumber(n));
  if (!row) return c.json({ error: `no yeti with number ${n}` }, 404);
  return c.json(row);
});

app.get("/nfts/by-owner/:addr", (c) => {
  const addr = c.req.param("addr");
  const rows = listByOwner(addr).map(shapeNft);
  return c.json({ owner: addr, count: rows.length, rows });
});

app.get("/nfts/search", (c) => {
  const q = c.req.query("q");
  const type = c.req.query("type");
  const value = c.req.query("value");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  let rows: Record<string, any>[] = [];
  if (type && value) {
    rows = searchByTraitExact(type, value, limit);
  } else if (q) {
    rows = searchByTraitValue(q, limit);
  } else {
    return c.json({ error: "provide ?q=... or ?type=...&value=..." }, 400);
  }

  return c.json({ query: q ?? `${type}=${value}`, count: rows.length, rows: rows.map(shapeNft) });
});

// Keep /nfts/:id AFTER the specific /nfts/by-... routes above.
app.get("/nfts/:id", (c) => {
  const id = c.req.param("id");
  const row = shapeNft(getByObjectId(id));
  if (!row) return c.json({ error: `no yeti with object_id ${id}` }, 404);
  return c.json(row);
});

app.get("/traits", (c) => c.json(allTraitTypes()));

app.get("/traits/:type", (c) => {
  const type = c.req.param("type");
  return c.json({ trait_type: type, values: traitValuesFor(type) });
});

app.get("/traits/:type/:value/count", (c) =>
  c.json({
    trait_type: c.req.param("type"),
    trait_value: c.req.param("value"),
    count: countByTrait(c.req.param("type"), c.req.param("value")),
  }),
);

// ─── Chat (Groq-backed natural-language interface) ───

app.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.question !== "string" || !body.question.trim()) {
    return c.json({ error: 'POST JSON { "question": "..." }' }, 400);
  }
  try {
    const result = await chat(body.question.trim());
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500);
  }
});

// ─── Mini frontend (single static HTML file) ───

app.get("/ui", async (c) => {
  const html = await Bun.file("web/index.html").text();
  return c.html(html);
});

const port = 4100;
console.log(`api: listening on http://localhost:${port}`);
export default { port, fetch: app.fetch };
