// LoFi Mystic Yeti NFT indexer.
//
// Pipeline:
//   1. queryEvents on the lofinfts_events module (Reveal, possibly Mint, etc.)
//   2. Extract the NFT object_id from each event's parsedJson.id
//   3. Batch-fetch each object's Display + Content + Owner via multiGetObjects
//   4. Parse attributes, upsert into nfts + nft_traits
//   5. Persist cursor after each page so restarts resume
//
// Backfill from origin on first boot. Resumes from cursor on subsequent runs.

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import {
  getCursor,
  setCursor,
  totalCount,
  upsertNft,
  type NftRow,
} from "./db";

// === Config ===
const PACKAGE_ID =
  "0xb07b09b016d28f989b6adda8069096da0c0a0ff6490f6e0866858c023b061bee";
const EVENT_MODULE = "lofinfts_events";
const NFT_TYPE = `${PACKAGE_ID}::mystic_yeti::MysticYeti`;
const POLL_MS = 5_000;
const EVENT_PAGE = 50;
const MULTI_GET_BATCH = 50;

const client = new SuiClient({ url: getFullnodeUrl("mainnet") });

// ────────────────────────────────────────────────────────────────────────────

type EventRef = {
  id: string;              // NFT object_id
  txDigest: string;
  eventSeq: number;
  timestamp_ms: number | null;
};

/** Pull one page of events, returning the NFT references we should fetch. */
async function fetchEventPage(): Promise<{
  refs: EventRef[];
  nextCursor: { txDigest: string; eventSeq: string } | null;
  hasNextPage: boolean;
}> {
  const cursor = getCursor();
  const resp = await client.queryEvents({
    query: { MoveEventModule: { package: PACKAGE_ID, module: EVENT_MODULE } },
    cursor: cursor ?? null,
    order: "ascending",
    limit: EVENT_PAGE,
  });

  const refs: EventRef[] = [];
  for (const ev of resp.data) {
    const json = ev.parsedJson as { id?: string } | undefined;
    if (!json?.id) continue; // not all events carry an object id; skip
    refs.push({
      id: json.id,
      txDigest: ev.id.txDigest,
      eventSeq: Number(ev.id.eventSeq),
      timestamp_ms: ev.timestampMs ? Number(ev.timestampMs) : null,
    });
  }

  return {
    refs,
    nextCursor: resp.nextCursor ?? null,
    hasNextPage: resp.hasNextPage,
  };
}

/** Fetch the full Display + Content + Owner for a batch of NFT object ids. */
async function fetchNftBatch(
  ids: string[],
): Promise<Map<string, Record<string, any>>> {
  const out = new Map<string, Record<string, any>>();
  if (ids.length === 0) return out;

  // Chunk into MULTI_GET_BATCH-sized requests.
  for (let i = 0; i < ids.length; i += MULTI_GET_BATCH) {
    const chunk = ids.slice(i, i + MULTI_GET_BATCH);
    const resp = await client.multiGetObjects({
      ids: chunk,
      options: {
        showType: true,
        showDisplay: true,
        showContent: true,
        showOwner: true,
      },
    });
    for (const r of resp) {
      if (r.data) out.set(r.data.objectId, r.data);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────

/** Parse a raw object response into an NftRow the DB can accept. */
function parseNft(
  obj: Record<string, any>,
  ref: EventRef,
): NftRow | null {
  if (obj.type !== NFT_TYPE) return null; // event might point at a non-Yeti

  const display = obj.display?.data ?? {};
  const content = obj.content?.fields ?? {};

  // Extract attributes from display (most reliable) or fall back to content.
  let attributes: { trait_type: string; value: string }[] = [];

  const displayAttr = display?.attributes;
  if (displayAttr?.map?.contents) {
    for (const entry of displayAttr.map.contents) {
      if (entry.key != null && entry.value != null) {
        attributes.push({ trait_type: String(entry.key), value: String(entry.value) });
      }
    }
  }

  if (attributes.length === 0) {
    const contentAttr = content?.attributes?.fields?.map?.fields?.contents;
    if (Array.isArray(contentAttr)) {
      for (const entry of contentAttr) {
        const k = entry?.fields?.key;
        const v = entry?.fields?.value;
        if (k != null && v != null) {
          attributes.push({ trait_type: String(k), value: String(v) });
        }
      }
    }
  }

  const numberStr = display?.number ?? content?.number;
  const number = numberStr != null ? Number(numberStr) : null;

  // Owner parsing (Sui returns a tagged union)
  let owner_kind: string | null = null;
  let owner_address: string | null = null;
  const owner = obj.owner;
  if (typeof owner === "string") {
    owner_kind = owner; // "Immutable"
  } else if (owner?.AddressOwner) {
    owner_kind = "AddressOwner";
    owner_address = owner.AddressOwner;
  } else if (owner?.ObjectOwner) {
    owner_kind = "ObjectOwner";
    owner_address = owner.ObjectOwner;
  } else if (owner?.Shared) {
    owner_kind = "Shared";
  }

  return {
    object_id: obj.objectId,
    number,
    name: display?.name ?? content?.name ?? null,
    description: display?.description ?? null,
    image_url: display?.image_url ?? content?.image_url ?? null,
    attributes,
    owner_kind,
    owner_address,
    revealed_at_ms: ref.timestamp_ms,
    tx_digest: ref.txDigest,
    event_seq: ref.eventSeq,
  };
}

// ────────────────────────────────────────────────────────────────────────────

async function pollOnce(): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0,
    updated = 0,
    skipped = 0;

  while (true) {
    const { refs, nextCursor, hasNextPage } = await fetchEventPage();

    if (refs.length === 0 && !hasNextPage) {
      // No events, no more pages. Persist cursor just in case we got a nextCursor anyway.
      if (nextCursor) setCursor(nextCursor);
      return { inserted, updated, skipped };
    }

    // Dedup by object_id — multiple events for the same NFT in one page (Reveal + transfer, e.g.)
    const idToRef = new Map<string, EventRef>();
    for (const r of refs) {
      const existing = idToRef.get(r.id);
      if (!existing || r.eventSeq > existing.eventSeq) idToRef.set(r.id, r);
    }

    const ids = [...idToRef.keys()];
    const objects = await fetchNftBatch(ids);

    for (const id of ids) {
      const obj = objects.get(id);
      const ref = idToRef.get(id)!;
      if (!obj) {
        skipped++;
        continue;
      }
      const row = parseNft(obj, ref);
      if (!row) {
        skipped++;
        continue;
      }
      const res = upsertNft(row);
      if (res === "inserted") inserted++;
      else updated++;
    }

    if (nextCursor) setCursor(nextCursor);

    if (!hasNextPage) return { inserted, updated, skipped };
    // Otherwise loop immediately — we're in backfill mode.
  }
}

async function main() {
  console.log(`indexer: watching ${PACKAGE_ID.slice(0, 16)}...::${EVENT_MODULE}::*`);
  console.log(`indexer: ${totalCount()} NFTs already in db`);
  const cursor = getCursor();
  console.log(
    cursor
      ? `indexer: resuming from cursor ${cursor.txDigest.slice(0, 10)}… seq ${cursor.eventSeq}`
      : "indexer: no cursor — backfilling from origin",
  );

  while (true) {
    try {
      const t0 = Date.now();
      const { inserted, updated, skipped } = await pollOnce();
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (inserted || updated || skipped) {
        console.log(
          `indexer: +${inserted} inserted · ${updated} updated · ${skipped} skipped · total ${totalCount()} · ${dt}s`,
        );
      }
    } catch (e) {
      console.error("indexer: poll failed —", e instanceof Error ? e.message : e);
    }
    await Bun.sleep(POLL_MS);
  }
}

main();
