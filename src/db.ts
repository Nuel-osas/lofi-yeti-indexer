// SQLite layer for the LoFi Mystic Yeti NFT indexer.
//
// Two tables:
//   nfts        — one row per NFT, full display metadata
//   nft_traits  — normalized trait rows for fast attribute search
// Plus:
//   kv          — cursor persistence (resume across restarts)

import { Database } from "bun:sqlite";

const db = new Database("yetis.db");
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS nfts (
    object_id         TEXT PRIMARY KEY,
    number            INTEGER,
    name              TEXT,
    description       TEXT,
    image_url         TEXT,
    attributes_json   TEXT,             -- full attributes as JSON array
    owner_kind        TEXT,             -- 'AddressOwner' | 'ObjectOwner' | 'Shared' | 'Immutable'
    owner_address     TEXT,             -- the actual owner string
    revealed_at_ms    INTEGER,
    tx_digest         TEXT,
    event_seq         INTEGER,
    indexed_at_ms     INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_nfts_number ON nfts(number);
  CREATE INDEX IF NOT EXISTS idx_nfts_owner  ON nfts(owner_address);

  CREATE TABLE IF NOT EXISTS nft_traits (
    object_id    TEXT NOT NULL,
    trait_type   TEXT NOT NULL,
    trait_value  TEXT NOT NULL,
    PRIMARY KEY (object_id, trait_type),
    FOREIGN KEY (object_id) REFERENCES nfts(object_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_traits_type_value
    ON nft_traits(trait_type, trait_value);
  CREATE INDEX IF NOT EXISTS idx_traits_value_lower
    ON nft_traits(trait_value COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// === Cursor ===

export function getCursor(): { txDigest: string; eventSeq: string } | null {
  const row = db.query("SELECT value FROM kv WHERE key = ?").get("cursor") as
    | { value: string }
    | null;
  return row ? JSON.parse(row.value) : null;
}

export function setCursor(cursor: { txDigest: string; eventSeq: string }) {
  db.run(
    "INSERT INTO kv(key, value) VALUES('cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(cursor)],
  );
}

// === NFT insertion ===

export type NftRow = {
  object_id: string;
  number: number | null;
  name: string | null;
  description: string | null;
  image_url: string | null;
  attributes: { trait_type: string; value: string }[];
  owner_kind: string | null;
  owner_address: string | null;
  revealed_at_ms: number | null;
  tx_digest: string | null;
  event_seq: number | null;
};

const insertNftStmt = db.prepare(`
  INSERT INTO nfts (
    object_id, number, name, description, image_url,
    attributes_json, owner_kind, owner_address,
    revealed_at_ms, tx_digest, event_seq, indexed_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(object_id) DO UPDATE SET
    owner_kind = excluded.owner_kind,
    owner_address = excluded.owner_address,
    indexed_at_ms = excluded.indexed_at_ms
`);

const insertTraitStmt = db.prepare(`
  INSERT OR REPLACE INTO nft_traits (object_id, trait_type, trait_value)
  VALUES (?, ?, ?)
`);

export function upsertNft(row: NftRow): "inserted" | "updated" {
  const isNew = !db.query("SELECT 1 FROM nfts WHERE object_id = ?").get(row.object_id);

  insertNftStmt.run(
    row.object_id,
    row.number,
    row.name,
    row.description,
    row.image_url,
    JSON.stringify(row.attributes),
    row.owner_kind,
    row.owner_address,
    row.revealed_at_ms,
    row.tx_digest,
    row.event_seq,
    Date.now(),
  );

  // Wipe + rewrite traits on every upsert so attribute changes land.
  db.run("DELETE FROM nft_traits WHERE object_id = ?", [row.object_id]);
  for (const attr of row.attributes) {
    insertTraitStmt.run(row.object_id, attr.trait_type, attr.value);
  }

  return isNew ? "inserted" : "updated";
}

// === Query helpers ===

export function totalCount(): number {
  return (db.query("SELECT COUNT(*) as c FROM nfts").get() as { c: number }).c;
}

export function getByObjectId(id: string) {
  return db
    .query(`SELECT * FROM nfts WHERE object_id = ?`)
    .get(id) as Record<string, any> | null;
}

export function getByNumber(n: number) {
  return db
    .query(`SELECT * FROM nfts WHERE number = ?`)
    .get(n) as Record<string, any> | null;
}

export function listNfts(limit = 20, offset = 0) {
  return db
    .query(`SELECT * FROM nfts ORDER BY number ASC LIMIT ? OFFSET ?`)
    .all(limit, offset) as Record<string, any>[];
}

export function listByOwner(owner: string, limit = 50) {
  return db
    .query(`SELECT * FROM nfts WHERE owner_address = ? ORDER BY number ASC LIMIT ?`)
    .all(owner, limit) as Record<string, any>[];
}

/** Case-insensitive substring match over ALL trait values. "wing" matches "Wings", "Angel Wings", etc. */
export function searchByTraitValue(needle: string, limit = 50) {
  return db
    .query(
      `SELECT n.* FROM nfts n
       JOIN nft_traits t ON t.object_id = n.object_id
       WHERE t.trait_value LIKE ? COLLATE NOCASE
       GROUP BY n.object_id
       ORDER BY n.number ASC
       LIMIT ?`,
    )
    .all(`%${needle}%`, limit) as Record<string, any>[];
}

/** Exact match on trait_type + trait_value. */
export function searchByTraitExact(type: string, value: string, limit = 50) {
  return db
    .query(
      `SELECT n.* FROM nfts n
       JOIN nft_traits t ON t.object_id = n.object_id
       WHERE t.trait_type = ? AND t.trait_value = ?
       ORDER BY n.number ASC
       LIMIT ?`,
    )
    .all(type, value, limit) as Record<string, any>[];
}

export function countByTrait(type: string, value: string): number {
  return (
    db
      .query(
        `SELECT COUNT(*) as c FROM nft_traits WHERE trait_type = ? AND trait_value = ?`,
      )
      .get(type, value) as { c: number }
  ).c;
}

export function allTraitTypes(): { trait_type: string; unique_values: number; total_rows: number }[] {
  return db
    .query(
      `SELECT trait_type, COUNT(DISTINCT trait_value) as unique_values, COUNT(*) as total_rows
       FROM nft_traits GROUP BY trait_type ORDER BY trait_type`,
    )
    .all() as { trait_type: string; unique_values: number; total_rows: number }[];
}

export function traitValuesFor(type: string): { trait_value: string; count: number }[] {
  return db
    .query(
      `SELECT trait_value, COUNT(*) as count
       FROM nft_traits WHERE trait_type = ?
       GROUP BY trait_value ORDER BY count DESC`,
    )
    .all(type) as { trait_value: string; count: number }[];
}

export function getTraitsFor(objectId: string) {
  return db
    .query(`SELECT trait_type, trait_value FROM nft_traits WHERE object_id = ?`)
    .all(objectId) as { trait_type: string; trait_value: string }[];
}

export { db };
