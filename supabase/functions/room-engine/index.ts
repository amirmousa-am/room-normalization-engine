// Supabase Edge Function — the engine's only server-side home.
// Routes (this function is deployed as "normalize"):
//   POST /normalize/normalize        { raw_name, options? }              -> single result
//   POST /normalize/normalize-batch  { raw_names: string[], options? }   -> { results: [...] }
//   POST /normalize/refresh          {}                                  -> force dictionary reload
//
// Both the userscript and the dashboard call this same function, so the
// normalization logic only ever lives in one place (_shared/engine.js).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildLookup, normalize, ENGINE_VERSION } from "../_shared/engine.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DICT_CACHE_TTL_MS = 10 * 60 * 1000; // same TTL the userscript used locally

// service-role client: talks to Postgres directly from inside the
// function's own network, not over the public REST API — no anon-key
// round trip, and this is the only place with write-level dictionary access.
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Module-level cache. Edge Function instances stay warm between
// invocations, so this avoids hitting Postgres on every single call —
// the same role GM_getValue/DICT_CACHE_KEY played in the userscript.
let dictCache: { dict: ReturnType<typeof buildLookup>; fetchedAt: number } | null = null;

async function loadDictionaryRows() {
  const { data, error } = await supabase
    .from("dictionary_terms")
    .select("id,synonyms,canonical_term,category,action,priority")
    .order("priority", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(`Dictionary load failed: ${error.message}`);
  return data;
}

async function getDictionary(force = false) {
  if (dictCache && !force && Date.now() - dictCache.fetchedAt < DICT_CACHE_TTL_MS) {
    return dictCache.dict;
  }
  const rows = await loadDictionaryRows();
  const dict = buildLookup(rows);
  dictCache = { dict, fetchedAt: Date.now() };
  return dict;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const url = new URL(req.url);
  // Supabase mounts this under /functions/v1/normalize/*
  const route = url.pathname.split("/").pop();

  try {
    if (route === "refresh" && req.method === "POST") {
      const dict = await getDictionary(true);
      return json({ ok: true, terms_loaded: dict.lookup.size, engine_version: ENGINE_VERSION });
    }

    if (route === "normalize" && req.method === "POST") {
      const { raw_name, options } = await req.json();
      if (!raw_name || typeof raw_name !== "string") {
        return json({ error: "raw_name (string) is required" }, 400);
      }
      const dict = await getDictionary();
      const result = await normalize(raw_name, dict, options || {});
      return json(result);
    }

    if (route === "normalize-batch" && req.method === "POST") {
      const { raw_names, options } = await req.json();
      if (!Array.isArray(raw_names) || raw_names.length === 0) {
        return json({ error: "raw_names (non-empty string[]) is required" }, 400);
      }
      if (raw_names.length > 5000) {
        return json({ error: "Batch too large — split into chunks of 5000 or fewer" }, 400);
      }
      const dict = await getDictionary(); // fetched ONCE for the whole batch
      const results = [];
      const errors: { raw_name: string; error: string }[] = [];
      for (const raw_name of raw_names) {
        try {
          results.push(await normalize(raw_name, dict, options || {}));
        } catch (err) {
          errors.push({ raw_name, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return json({ results, errors, engine_version: ENGINE_VERSION });
    }

    return json({ error: "Not found. Use /normalize, /normalize-batch, or /refresh." }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
