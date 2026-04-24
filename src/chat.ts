// Groq-backed chat layer: natural language → tool call → SQL → formatted answer.
//
// Uses Groq's OpenAI-compatible completions endpoint with function-calling.
// Tools are thin wrappers over the helpers in db.ts. The LLM picks a tool,
// we run the SQL, shove the result back, repeat until no more tool calls.

import {
  allTraitTypes,
  countByTrait,
  getByNumber,
  searchByTraitExact,
  searchByTraitValue,
  totalCount,
  traitValuesFor,
} from "./db";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.1-8b-instant: 500k tokens/day on the Groq free tier (5× the 70b)
// and fast enough for this workshop. The 70b runs out mid-class.
const MODEL = "llama-3.1-8b-instant";
const MAX_ITER = 6;

// === Tool schema for Groq ===

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_by_trait_value",
      description:
        "Case-insensitive substring search across ALL trait values. Use for vague questions like 'yetis with wings', 'orange yetis', 'halo'. Returns up to 30 NFTs.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "substring to search for" },
        },
        required: ["q"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_by_trait_exact",
      description:
        "Exact match on (trait_type, trait_value). Use when the user explicitly names both. Example: type='Fur', value='Orange'. Returns up to 30 NFTs.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "trait type, case-sensitive" },
          value: { type: "string", description: "trait value, case-sensitive" },
        },
        required: ["type", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_by_number",
      description: "Get one specific NFT by its sequence number, e.g. 4737.",
      parameters: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_trait_types",
      description:
        "List every trait type in the collection with unique-value counts. Use when user asks 'what traits exist', 'what can I search for', 'overview'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_trait_values",
      description:
        "List every value for a given trait type, with counts. Use when the user asks 'what fur colors exist', 'show head gear options'.",
      parameters: {
        type: "object",
        properties: { type: { type: "string" } },
        required: ["type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_by_trait",
      description:
        "Count NFTs matching an exact (type, value). Use for 'how many yetis have Fur=Orange'.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string" },
          value: { type: "string" },
        },
        required: ["type", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "collection_summary",
      description:
        "Total NFT count + high-level trait overview. Use when the user asks 'what is this collection', 'how many yetis'.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// === Tool executor ===

function shapeNft(row: any) {
  if (!row) return null;
  return {
    object_id: row.object_id,
    number: row.number,
    name: row.name,
    image_url: row.image_url,
    attributes: row.attributes_json ? JSON.parse(row.attributes_json) : [],
  };
}

// Reduces what we send BACK to the model — just counts + numbers, not full
// attribute arrays. The frontend gets the full data from collectedNfts.
function slimForModel(result: any): any {
  if (Array.isArray(result)) {
    return {
      count: result.length,
      numbers: result.slice(0, 20).map((r: any) => r?.number).filter(Boolean),
    };
  }
  if (result && typeof result === "object" && "number" in result) {
    return { number: result.number, name: result.name };
  }
  return result;
}

function execTool(name: string, args: any) {
  switch (name) {
    case "search_by_trait_value":
      return searchByTraitValue(String(args.q ?? ""), 30).map(shapeNft);
    case "search_by_trait_exact":
      return searchByTraitExact(String(args.type ?? ""), String(args.value ?? ""), 30).map(shapeNft);
    case "get_by_number": {
      const n = Number(args.n);
      if (!Number.isFinite(n)) return { error: "invalid number" };
      const one = getByNumber(n);
      return one ? shapeNft(one) : null;
    }
    case "list_trait_types":
      return allTraitTypes();
    case "list_trait_values":
      return traitValuesFor(args.type);
    case "count_by_trait":
      return { count: countByTrait(args.type, args.value) };
    case "collection_summary":
      return {
        total_indexed: totalCount(),
        trait_types: allTraitTypes(),
      };
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// === Groq call ===

async function groqCall(messages: any[]): Promise<any> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY env var not set");

  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 800,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[groq ${resp.status}]`, body.slice(0, 400));
    throw new Error(`groq ${resp.status}: ${body}`);
  }
  return resp.json();
}

// === Main entry ===

export type ChatResult = {
  answer: string;
  nfts: any[]; // structured NFT rows collected from tool results
  trace: { tool: string; args: any; rows_or_result: any }[];
};

export async function chat(question: string): Promise<ChatResult> {
  const messages: any[] = [
    {
      role: "system",
      content:
        "You are a guide to the LoFi Mystic Yeti NFT collection on Sui mainnet. You have tools to query an indexed database of every revealed yeti. " +
        "Call a tool before answering — never fabricate data. " +
        "Keep answers to one sentence. Do not list NFTs in prose; the frontend renders them. " +
        "Never mention tool names or function syntax in the answer.",
    },
    { role: "user", content: question },
  ];

  const collectedNfts: any[] = [];
  const trace: ChatResult["trace"] = [];

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let resp: any;
    try {
      resp = await groqCall(messages);
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);

      // If we already pulled NFT data before this hiccup, just return it —
      // the user got what they asked for; the model just stumbled on a follow-up.
      if (collectedNfts.length > 0) {
        const n = collectedNfts.length;
        return {
          answer: `Found ${n} matching yeti${n === 1 ? "" : "s"}.`,
          nfts: collectedNfts,
          trace: [...trace, { tool: "__recovered__", args: null, rows_or_result: errMsg.slice(0, 200) }],
        };
      }

      // Rate-limited by Groq — give the user a clear, actionable message.
      if (errMsg.includes("rate_limit_exceeded") || errMsg.includes("groq 429")) {
        const waitMatch = errMsg.match(/try again in ([0-9.]+m?[0-9.]+s?)/);
        const wait = waitMatch ? waitMatch[1] : "a moment";
        return {
          answer: `Groq's free-tier rate limit hit — wait ${wait} and try again, or upgrade the key at console.groq.com.`,
          nfts: collectedNfts,
          trace: [...trace, { tool: "__rate_limited__", args: null, rows_or_result: wait }],
        };
      }

      // No data yet — try nudging the model on a malformed tool call. Up to 3 retries.
      if (errMsg.includes("tool_use_failed") && iter < 4) {
        messages.push({
          role: "user",
          content:
            "Your last response was a malformed tool call. Use this format exactly, nothing else: pick one tool name from the list, pass arguments as a proper JSON object. Example: name=\"get_by_number\", arguments={\"n\": 4737}. Try again.",
        });
        continue;
      }

      return {
        answer:
          "I hit a snag answering that. Try a more specific question — e.g. 'yetis with orange fur', 'yeti #4737', 'what fur colors exist?'",
        nfts: collectedNfts,
        trace: [...trace, { tool: "__error__", args: null, rows_or_result: errMsg.slice(0, 200) }],
      };
    }

    const msg = resp.choices?.[0]?.message;
    if (!msg) return { answer: "(no response from model)", nfts: collectedNfts, trace };

    messages.push(msg);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const content = (msg.content ?? "").trim();
      if (!content && iter === 0) {
        // Model bailed without deciding — nudge it with a hint and retry once.
        messages.push({
          role: "user",
          content:
            "Please pick a tool from the list and call it. If the question is vague, start with collection_summary or list_trait_types.",
        });
        continue;
      }
      return {
        answer:
          content ||
          "I'm not sure how to answer that. Try asking about a specific trait (e.g. 'yetis with orange fur') or a specific yeti number.",
        nfts: collectedNfts,
        trace,
      };
    }

    for (const tc of toolCalls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments ?? "{}");
      } catch {
        // ignore
      }
      const result = execTool(tc.function.name, args);

      trace.push({
        tool: tc.function.name,
        args,
        rows_or_result: Array.isArray(result)
          ? `${result.length} rows`
          : result,
      });

      // Collect NFT rows for frontend rendering
      if (Array.isArray(result) && result.length > 0 && result[0]?.object_id) {
        for (const nft of result) {
          if (!collectedNfts.find((n) => n.object_id === nft.object_id)) {
            collectedNfts.push(nft);
          }
        }
      } else if (result && typeof result === "object" && (result as any).object_id) {
        if (!collectedNfts.find((n) => n.object_id === (result as any).object_id)) {
          collectedNfts.push(result);
        }
      }

      // Send result back to the model — strip heavy fields to save tokens.
      // The full NFTs are collected in collectedNfts already; the model only
      // needs to know what was found, not every attribute.
      const slimPayload = slimForModel(result);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(slimPayload),
      });
    }
  }

  return { answer: "(iteration limit reached)", nfts: collectedNfts, trace };
}
