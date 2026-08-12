// ============================================================
// ROOM NORMALIZER ENGINE — pure, host-agnostic
// ------------------------------------------------------------
// No GM_*, no DOM, no fetch. This file only takes data in and
// returns data out, so the exact same code runs unmodified in:
//   - the Supabase Edge Function (Deno)
//   - a Node backend (dashboard bulk jobs)
//   - a browser, if ever needed directly
//
// Extracted verbatim (algorithm untouched) from
// room-normalizer-panel.user.js v1.8.0. Only two things changed
// on the way out, both purely structural:
//   1. Dictionary loading/caching is the CALLER's job now.
//      buildLookup(rows) is still here; init()/GM caching is not.
//   2. LAST_DIAGNOSTICS was a module-level mutable — unsafe once
//      this runs in a server handling concurrent requests. It is
//      now returned per-call as result.diagnosticsReport instead.
// ============================================================

export const ENGINE_VERSION = "1.8.0";

// ------------------------------------------------------------
// STRUCTURAL ANCHORS
// ------------------------------------------------------------
const BED_ANCHOR = new Set(["bed", "beds", "bd", "bds"]);
const BEDROOM_ANCHOR = new Set(["bdrm", "bdrms", "bedroom", "bedrooms", "bdr", "bdrs", "br", "brs"]);
const VIEW_ANCHOR = new Set(["view", "vw", "vws"]);
const OCCUPANCY_ANCHORS = new Set(["pax", "guest", "guests", "adult", "adults", "person", "persons", "people"]);

const WORD_NUMBERS = new Map([
  ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10]
]);

function parseNumber(text) {
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  return WORD_NUMBERS.get(text.toLowerCase()) || null;
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

// ------------------------------------------------------------
// DIAGNOSTICS — TWO INDEPENDENT, PARALLEL SIDECARS
// Neither ever participates in matching, claiming, bucket
// selection, or output assembly. They only ever *observe*.
//   1) DiagnosticCollector ("diag") — per-run token-indexed
//      event trace. Powers the Token Decisions UI. Returned as
//      result.diagnosticsReport (was a module global; now
//      per-call so concurrent server requests never collide).
//   2) createDiagnostics ("telemetry") — review-queue-oriented
//      events + rule hits (+ optional full trace). Merged onto
//      the result as result.diagnostics / rule_hits / trace,
//      which createCollector() (still lives client-side) batches
//      up for Supabase.
// ------------------------------------------------------------
function diagnosticToken(token) {
  return {
    index: token.idx,
    text: token.text,
    claimedBy: token.claimedBy,
    resolved: token.resolved ? { ...token.resolved } : null,
  };
}

class DiagnosticCollector {
  constructor() { this.events = []; this.nextId = 1; }
  emit(stage, type, tokens, explanation, metadata) {
    const event = { id: `diag_${this.nextId++}`, stage, type, tokens: (tokens || []).map(diagnosticToken), explanation };
    if (metadata !== undefined) event.metadata = metadata;
    this.events.push(event);
  }
  snapshot(stage, tokens) {
    this.emit(stage, "trace.snapshot", tokens, "Token state after this stage.");
  }
  report() { return { version: 1, events: this.events }; }
}

function snapshotTokens(tokens) {
  return tokens.map((t) => ({
    text: t.text,
    position: t.idx,
    claimed_by: t.claimedBy,
    resolved: t.resolved ? { ...t.resolved } : null,
  }));
}

function createDiagnostics(rawName, traceEnabled) {
  const diagnostics = [];
  const ruleHits = new Map();
  const trace = [];
  return {
    stage(name, tokens, details = null) {
      if (traceEnabled) trace.push({ stage: name, tokens: snapshotTokens(tokens), details });
    },
    review(event) {
      diagnostics.push({ severity: "review", ...event });
    },
    ruleHit(ruleKey, termId = null) {
      const key = `${ruleKey}|${termId || ""}`;
      const previous = ruleHits.get(key);
      ruleHits.set(key, {
        rule_key: ruleKey,
        term_id: termId,
        hit_count: (previous?.hit_count || 0) + 1,
      });
    },
    result() {
      return { diagnostics, rule_hits: [...ruleHits.values()], trace };
    },
  };
}

// ------------------------------------------------------------
// DICTIONARY
// ------------------------------------------------------------
// buildLookup() is pure: rows in, lookup structure out. The
// caller (edge function / userscript / dashboard) is responsible
// for fetching `rows` from wherever the dictionary lives and for
// any caching/TTL around that fetch.
export function buildLookup(rows) {
  const lookup = new Map();
  let maxPhraseLen = 1;

  const DYNAMIC_BED_TYPES = new Set();
  const DYNAMIC_VIEW_CORE = new Set();
  const DYNAMIC_VIEW_MOD = new Set();
  const DYNAMIC_VIEW_MOD_POSITIONAL = new Set();
  const VIEW_COMPOUND_VOCAB = new Set();
  const EXPANSIONS = new Map();

  for (const row of rows) {
    for (const rawSyn of row.synonyms.split(",")) {
      const syn = rawSyn.trim().toLowerCase().replace(/\s+/g, " ");
      if (!syn) continue;

      if (row.action === "EXPAND") {
        EXPANSIONS.set(syn, (row.canonical_term || "").toLowerCase());
        continue;
      }

      lookup.set(syn, { termId: row.id, canonical: row.canonical_term, category: row.category, action: row.action });
      maxPhraseLen = Math.max(maxPhraseLen, syn.split(" ").length);

      if (row.category === "BEDDING_TYPE") {
        DYNAMIC_BED_TYPES.add(syn);
        if (row.canonical_term) DYNAMIC_BED_TYPES.add(row.canonical_term.toLowerCase());
      } else if (row.category === "VIEW_CORE") {
        DYNAMIC_VIEW_CORE.add(syn);
        if (row.canonical_term) DYNAMIC_VIEW_CORE.add(row.canonical_term.toLowerCase());
      } else if (row.category === "VIEW_MODIFIER") {
        DYNAMIC_VIEW_MOD.add(syn);
        if (row.canonical_term) DYNAMIC_VIEW_MOD.add(row.canonical_term.toLowerCase());
      } else if (row.category === "VIEW_MODIFIER_POSITIONAL") {
        DYNAMIC_VIEW_MOD_POSITIONAL.add(syn);
        if (row.canonical_term) DYNAMIC_VIEW_MOD_POSITIONAL.add(row.canonical_term.toLowerCase());
      }
    }
  }

  for (const w of DYNAMIC_VIEW_CORE) VIEW_COMPOUND_VOCAB.add(w);
  for (const w of DYNAMIC_VIEW_MOD) VIEW_COMPOUND_VOCAB.add(w);
  for (const w of DYNAMIC_VIEW_MOD_POSITIONAL) VIEW_COMPOUND_VOCAB.add(w);
  for (const w of VIEW_ANCHOR) VIEW_COMPOUND_VOCAB.add(w);

  return {
    lookup, maxPhraseLen,
    DYNAMIC_BED_TYPES, DYNAMIC_VIEW_CORE, DYNAMIC_VIEW_MOD, DYNAMIC_VIEW_MOD_POSITIONAL,
    VIEW_COMPOUND_VOCAB, EXPANSIONS,
  };
}

// ------------------------------------------------------------
// TOKENIZATION
// ------------------------------------------------------------
function sanitize(raw, diag) {
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9\s/]/g, " ").replace(/\s+/g, " ").trim();
  if (sanitized !== raw) diag?.emit("sanitize", "input.sanitized", [], "Input text was normalized before tokenization.", { raw, sanitized });
  return sanitized;
}

function splitFusedViewWord(word, dict) {
  if (word.length < 6) return null;
  if (dict.lookup.has(word)) return null;
  for (let i = 3; i <= word.length - 3; i++) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    if (dict.VIEW_COMPOUND_VOCAB.has(left) && dict.VIEW_COMPOUND_VOCAB.has(right)) return `${left} ${right}`;
  }
  return null;
}

function expandCompounds(sanitized, dict, diag) {
  const words = sanitized.split(" ");
  const out = [];
  for (const [idx, w] of words.entries()) {
    if (dict.EXPANSIONS.has(w)) {
      const expansion = dict.EXPANSIONS.get(w);
      diag?.emit("expandCompounds", "compound.expanded", [{ idx, text: w, claimedBy: null, resolved: null }], "A manual expansion dictionary entry split this compound.", { expansion, source: "manual" });
      out.push(expansion);
      continue;
    }
    const split = splitFusedViewWord(w, dict);
    if (split) diag?.emit("expandCompounds", "compound.expanded", [{ idx, text: w, claimedBy: null, resolved: null }], "The view vocabulary splitter split this compound.", { expansion: split, source: "view_vocabulary" });
    out.push(split || w);
  }
  return out.join(" ");
}

function tokenize(raw, dict, diag) {
  const sanitized = sanitize(raw, diag);
  const expanded = expandCompounds(sanitized, dict, diag);
  const tokens = expanded.split(" ").filter(Boolean).map((text, idx) => ({ text, idx, claimedBy: null, resolved: null }));
  diag?.emit("tokenize", "tokens.created", tokens, "Input was split into parser tokens.");
  return { tokens, sanitized, expanded };
}

function* unclaimedWindows(tokens, maxLen) {
  const n = tokens.length;
  for (let length = maxLen; length >= 1; length--) {
    for (let start = 0; start + length <= n; start++) {
      const window = tokens.slice(start, start + length);
      if (window.every((t) => t.claimedBy === null)) yield { start, end: start + length, window };
    }
  }
}

function* patternWindows(tokens, maxLen) {
  const n = tokens.length;
  for (let length = maxLen; length >= 1; length--) {
    for (let start = 0; start + length <= n; start++) {
      const window = tokens.slice(start, start + length);
      if (window.every((t) => t.claimedBy === null || t.claimedBy.startsWith("dict:"))) {
        yield { start, end: start + length, window };
      }
    }
  }
}

function claim(tokens, start, end, ruleName) {
  for (let i = start; i < end; i++) tokens[i].claimedBy = ruleName;
}

function tokenAvailable(t) {
  return t.claimedBy === null || t.claimedBy.startsWith("dict:");
}

function pass1(tokens, dict, diag, telemetry) {
  for (const { start, end, window } of unclaimedWindows(tokens, dict.maxPhraseLen)) {
    const phrase = window.map((t) => t.text).join(" ");
    const match = dict.lookup.get(phrase);
    if (!match) continue;
    const { termId, canonical, category, action } = match;
    telemetry?.ruleHit(`DICT:${termId || `${category}:${phrase}`}`, termId || null);
    if (action === "DELETE") {
      claim(tokens, start, end, `dict:${category}:DELETE`);
      diag?.emit("pass1_dictionary", "dictionary.match", window, "A dictionary DELETE rule claimed these tokens.", { termId, phrase, canonical, category, action });
      continue;
    }
    if (window.length === 1) {
      window[0].text = canonical ? canonical.toLowerCase() : window[0].text;
      window[0].resolved = { termId, canonical, category, action };
    } else {
      claim(tokens, start, end, `dict:${category}:REPLACE`);
      window.forEach((t) => (t.resolved = { termId, canonical, category, action }));
    }
    diag?.emit("pass1_dictionary", "dictionary.match", window, "A dictionary entry resolved these tokens.", { termId, phrase, canonical, category, action });
  }
  if (diag) {
    for (const token of tokens) {
      if (token.claimedBy === null && token.resolved === null) {
        diag.emit("pass1_dictionary", "dictionary.miss", [token], "No dictionary entry matched this token.", { token: token.text });
      }
    }
  }
}

function compact(tokens, diag) {
  return tokens.filter((t) => {
    if (!(t.claimedBy && t.claimedBy.endsWith(":DELETE"))) return true;
    if (BED_ANCHOR.has(t.text) || BEDROOM_ANCHOR.has(t.text) || VIEW_ANCHOR.has(t.text)) return true;
    diag?.emit("compact", "token.dropped", [t], "A dictionary DELETE rule removed this non-structural token before pattern matching.", { claim: t.claimedBy });
    return false;
  });
}

function pass2Bedroom(tokens) {
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length === 2) {
      const [a, b] = window;
      const num = parseNumber(a.text);
      if (num !== null && BEDROOM_ANCHOR.has(b.text)) {
        claim(tokens, start, end, "R_BDR");
        return `${num} Bedroom`;
      }
    }
  }
  for (const { start, end, window } of patternWindows(tokens, 1)) {
    if (BEDROOM_ANCHOR.has(window[0].text)) { claim(tokens, start, end, "R_BDR_DROP"); return null; }
  }
  return null;
}

function pass2OccupancyPattern(tokens) {
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length === 2) {
      const num = parseNumber(window[0].text);
      if (num !== null && OCCUPANCY_ANCHORS.has(window[1].text)) {
        claim(tokens, start, end, "R_OCCUPANCY");
        return `${num} Pax`;
      }
    }
  }
  return null;
}

function isBedTypeToken(t, dict) {
  if (t.resolved && t.resolved.category !== "BEDDING_TYPE") return false;
  const canon = (t.resolved?.canonical || t.text).toLowerCase();
  return ["double", "single", "twin", "king", "queen", "full"].includes(canon) ||
         dict.DYNAMIC_BED_TYPES.has(t.text) ||
         t.resolved?.category === "BEDDING_TYPE";
}

function pass2BeddingSingle(tokens, dict) {
  const n = tokens.length;
  for (let i = 0; i < n; i++) {
    const t = tokens[i];
    if (!tokenAvailable(t) || !isBedTypeToken(t, dict)) continue;

    const prev = i > 0 ? tokens[i - 1] : null;
    const next = i < n - 1 ? tokens[i + 1] : null;
    const prevNum = prev && tokenAvailable(prev) ? parseNumber(prev.text) : null;
    const nextIsAnchor = !!(next && tokenAvailable(next) && BED_ANCHOR.has(next.text));

    let start, end, count, hasNum = false, hasAnchor = false;
    if (prevNum !== null && nextIsAnchor) {
      start = i - 1; end = i + 2; count = prevNum; hasNum = true; hasAnchor = true;
    } else if (prevNum !== null) {
      start = i - 1; end = i + 1; count = prevNum; hasNum = true;
    } else if (nextIsAnchor) {
      start = i; end = i + 2; count = 1; hasAnchor = true;
    } else {
      start = i; end = i + 1; count = 1;
    }

    const canonType = (t.resolved?.canonical || t.text).toLowerCase();
    const isAmbiguous = ["double", "single", "twin"].includes(canonType);
    if (isAmbiguous && !hasNum && !hasAnchor) continue;

    claim(tokens, start, end, "R_BED");
    const bedTypeName = t.resolved?.canonical || cap(t.text);
    const bedLabel = count > 1 ? "Beds" : "Bed";
    return `${count} ${bedTypeName} ${bedLabel}`;
  }
  return null;
}

function pass2BeddingAll(tokens, dict) {
  const results = [];
  let match;
  while ((match = pass2BeddingSingle(tokens, dict)) !== null) results.push(match);
  return results;
}

function isViewCore(t, dict) { return dict.DYNAMIC_VIEW_CORE.has(t.text) || t.resolved?.category === "VIEW_CORE"; }
function isViewMod(t, dict) { return dict.DYNAMIC_VIEW_MOD.has(t.text) || t.resolved?.category === "VIEW_MODIFIER"; }
function isViewModPositional(t, dict) { return dict.DYNAMIC_VIEW_MOD_POSITIONAL.has(t.text) || t.resolved?.category === "VIEW_MODIFIER_POSITIONAL"; }
function isAnyMod(t, dict) { return isViewMod(t, dict) || isViewModPositional(t, dict); }

function fmtView(modifierToken, coreToken) {
  const coreVal = coreToken.resolved?.canonical || cap(coreToken.text);
  const modVal = modifierToken ? (modifierToken.resolved?.canonical || cap(modifierToken.text)) : "";
  return `${modVal ? modVal + " " : ""}${coreVal} View`;
}
function fmtLiteralNoView(coreToken, modifierToken) {
  const coreVal = coreToken.resolved?.canonical || cap(coreToken.text);
  const modVal = modifierToken.resolved?.canonical || cap(modifierToken.text);
  return `${coreVal} ${modVal}`;
}

function pass2ViewSingle(tokens, dict) {
  for (const { start, end, window } of patternWindows(tokens, 3)) {
    if (window.length !== 3) continue;
    const [a, b, c] = window;
    if (!VIEW_ANCHOR.has(c.text)) continue;
    if (isAnyMod(a, dict) && isViewCore(b, dict)) { claim(tokens, start, end, "R_VIEW"); return fmtView(a, b); }
    if (isViewCore(a, dict) && isAnyMod(b, dict)) { claim(tokens, start, end, "R_VIEW"); return fmtView(b, a); }
  }
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length !== 2) continue;
    const [a, b] = window;
    if (VIEW_ANCHOR.has(b.text) && isViewCore(a, dict)) { claim(tokens, start, end, "R_VIEW"); return fmtView(null, a); }
    if (VIEW_ANCHOR.has(a.text) && isViewCore(b, dict)) { claim(tokens, start, end, "R_VIEW"); return fmtView(null, b); }
  }
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length !== 2) continue;
    const [a, b] = window;
    if (isViewCore(a, dict) && isViewMod(b, dict)) { claim(tokens, start, end, "R_VIEW"); return fmtView(b, a); }
    if (isViewMod(a, dict) && isViewCore(b, dict)) { claim(tokens, start, end, "R_VIEW"); return fmtView(a, b); }
  }
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length !== 2) continue;
    const [a, b] = window;
    if (isViewCore(a, dict) && isViewModPositional(b, dict)) { claim(tokens, start, end, "R_VIEW"); return fmtLiteralNoView(a, b); }
    if (isViewModPositional(a, dict) && isViewCore(b, dict)) { claim(tokens, start, end, "R_VIEW"); return fmtView(a, b); }
  }
  return null;
}

function pass2ViewAll(tokens, dict) {
  const results = [];
  let match;
  while ((match = pass2ViewSingle(tokens, dict)) !== null) results.push(match);
  return results;
}

function pass2TwinSpecial(tokens) {
  for (const length of [3, 2]) {
    for (const { start, end, window } of patternWindows(tokens, length)) {
      if (window.length !== length) continue;
      const texts = window.map((t) => t.text);
      let count = null, twinIdx;
      if (length === 3) {
        const n = parseNumber(texts[0]);
        if (n === null || texts[1] !== "twin") continue;
        count = n; twinIdx = 1;
      } else {
        if (texts[0] !== "twin") continue;
        twinIdx = 0;
      }
      const second = texts[twinIdx + 1];
      if (BED_ANCHOR.has(second)) {
        claim(tokens, start, end, "TWIN_BED");
        const isPluralAnchor = second === "beds" || second === "bds";
        const n = count || (isPluralAnchor ? 2 : 1);
        return { bedding: `${n} Single ${n === 1 ? "Bed" : "Beds"}`, extraType: null };
      }
      if (second === "room" || second === "rm") {
        claim(tokens, start, end, "TWIN_ROOM");
        return { bedding: "2 Single Beds", extraType: "Room" };
      }
    }
  }
  return { bedding: null, extraType: null };
}

function pass2DropAmbiguous(tokens, diag, telemetry) {
  for (const t of tokens) {
    if (t.claimedBy === null || t.claimedBy.startsWith("dict:")) {
      const canonMatch = (t.resolved?.canonical || t.text).toLowerCase();
      if (canonMatch === "double") {
        t.claimedBy = "R_DROP_DOUBLE";
        telemetry?.ruleHit("ENGINE:R_DROP_DOUBLE");
        telemetry?.review({
          kind: "AMBIGUOUS_DROP",
          code: "R_DROP_DOUBLE",
          token: t.text,
          phase: "pass2",
          explanation: "The token matched \u2018Double\u2019 but had no adjacent number or bed anchor, so the engine dropped it as ambiguous.",
        });
        diag?.emit("pass2DropAmbiguous", "token.dropped", [t], "An unconsumed \u2018Double\u2019 token was dropped because it lacked explicit bedding context.", { rule: "R_DROP_DOUBLE", canonical: canonMatch });
      } else if (canonMatch === "single") {
        t.resolved = { termId: t.resolved?.termId || null, canonical: "Single", category: "OCCUPANCY", action: "REPLACE" };
        telemetry?.ruleHit("ENGINE:R_RECLASSIFY_SINGLE");
        diag?.emit("pass2DropAmbiguous", "token.reclassified", [t], "An unconsumed \u2018Single\u2019 token was reclassified as occupancy because it lacked explicit bedding context.", { rule: "R_RECLASSIFY_SINGLE", canonical: "Single", category: "OCCUPANCY" });
      }
    }
  }
}

function pass3(tokens, auditSink, rawName, diag, telemetry) {
  const buckets = { class: [], occupancy: [], type: [], building: [], amenity: [], custom: [] };
  for (const t of tokens) {
    if (t.claimedBy !== null && !t.claimedBy.startsWith("dict:")) continue;
    if (t.claimedBy !== null && t.claimedBy.endsWith(":DELETE")) continue;
    if (t.resolved) {
      const { canonical, category } = t.resolved;
      if (category === "CLASS") buckets.class.push(canonical);
      else if (category === "OCCUPANCY") buckets.occupancy.push(canonical);
      else if (category === "TYPE") buckets.type.push(canonical);
      else if (category === "BUILDING") buckets.building.push(canonical);
      else if (category === "AMENITY" || category === "PRIVILEGE") buckets.amenity.push(canonical);
      else if (category === "VIEW_CORE" || category === "VIEW_MODIFIER" || category === "VIEW_MODIFIER_POSITIONAL") {
        if (canonical) {
          buckets.custom.push(canonical);
          telemetry?.review({
            kind: "UNPAIRED_SEMANTIC",
            code: "UNPAIRED_VIEW",
            token: t.text,
            phase: "pass3",
            explanation: `The dictionary recognized \u2018${canonical}\u2019 as a view term, but no valid view pattern consumed it.`,
          });
        }
      } else if (category === "BEDDING_TYPE") {
        if (canonical) {
          buckets.custom.push(canonical);
          telemetry?.review({
            kind: "UNPAIRED_SEMANTIC",
            code: "UNPAIRED_BEDDING",
            token: t.text,
            phase: "pass3",
            explanation: `The dictionary recognized \u2018${canonical}\u2019 as a bedding term, but no valid bedding pattern consumed it.`,
          });
        }
      }
      continue;
    }
    buckets.custom.push(cap(t.text));
    if (auditSink) auditSink(t.text, rawName);
    telemetry?.review({
      kind: "UNRESOLVED",
      code: "NO_DICTIONARY_MATCH",
      token: t.text,
      phase: "pass3",
      explanation: "No dictionary entry or structural rule recognized this token.",
    });
    diag?.emit("pass3", "token.unresolved", [t], "No dictionary or structural rule resolved this token, so it was emitted as custom output.", { bucket: "custom" });
  }
  return { buckets };
}

function dedup(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) if (x && !seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function assemble(buckets, bedroom, beddingList, viewList) {
  let classList = dedup(buckets.class);
  if (classList.length === 0) classList = ["Standard"];

  const occupancyList = dedup(buckets.occupancy);

  let typeList = dedup(buckets.type);
  if (typeList.length === 0) typeList = ["Room"];

  const buildingList = dedup(buckets.building);
  const amenityList = dedup(buckets.amenity);
  const customList = dedup(buckets.custom);

  const beddingClean = dedup(beddingList || []);
  const viewClean = dedup(viewList || []);
  const beddingLine = beddingClean.length ? beddingClean.join(", ") : null;
  const viewLine = viewClean.length ? viewClean.join(", ") : null;

  const parts = [...classList];
  if (occupancyList.length) parts.push(...occupancyList);
  parts.push(...typeList);
  if (bedroom) parts.push(bedroom);
  if (beddingLine) parts.push(beddingLine);
  if (viewLine) parts.push(viewLine);
  parts.push(...buildingList, ...amenityList, ...customList);

  const canonical_string = parts.join(" ");
  const canonical_hash = await sha256(canonical_string);
  return {
    canonical_string, canonical_hash,
    parsed_components: {
      class: classList,
      occupancy: occupancyList.length ? occupancyList.join(", ") : null,
      type: typeList,
      bedroom: bedroom || null,
      bedding: beddingLine,
      view: viewLine,
      building: buildingList.length ? buildingList : null,
      amenity: amenityList.length ? amenityList : null,
      custom: customList,
    },
  };
}

// ------------------------------------------------------------
// ENTRY POINT
// ------------------------------------------------------------
// dict: the object returned by buildLookup(rows) — caller fetches
//       and caches `rows` however makes sense for that host.
// options.trace: enable full stage trace (review-queue telemetry)
// options.auditSink(token, rawName): called for every unresolved
//       token, same contract as the original engine.
export async function normalize(rawName, dict, options = {}) {
  const diag = new DiagnosticCollector();
  const telemetry = createDiagnostics(rawName, options.trace === true);

  const { tokens: initialTokens, sanitized, expanded } = tokenize(rawName, dict, diag);
  let tokens = initialTokens;
  telemetry.stage("tokenize", tokens, { sanitized, expanded });

  pass1(tokens, dict, diag, telemetry);
  diag.snapshot("pass1_dictionary", tokens);
  telemetry.stage("pass1_dictionary", tokens);

  tokens = compact(tokens, diag);
  diag.snapshot("compact", tokens);
  telemetry.stage("compact", tokens);

  const bedroom = pass2Bedroom(tokens);
  diag.emit("pass2Bedroom", "stage.completed", tokens, "Bedroom pattern pass completed.", { output: bedroom });
  if (tokens.some((t) => t.claimedBy === "R_BDR")) telemetry.ruleHit("ENGINE:R_BDR");
  if (tokens.some((t) => t.claimedBy === "R_BDR_DROP")) telemetry.ruleHit("ENGINE:R_BDR_DROP");

  const twin = pass2TwinSpecial(tokens);
  diag.emit("pass2TwinSpecial", "stage.completed", tokens, "Twin-specific pattern pass completed.", { bedding: twin.bedding, extraType: twin.extraType });
  if (twin.bedding || twin.extraType) telemetry.ruleHit(`ENGINE:${twin.extraType ? "TWIN_ROOM" : "TWIN_BED"}`);

  const beddingList = [
    ...(twin.bedding ? [twin.bedding] : []),
    ...pass2BeddingAll(tokens, dict),
  ];
  diag.emit("pass2BeddingAll", "stage.completed", tokens, "Bedding pattern pass completed.", { output: beddingList });
  for (let i = 0; i < beddingList.length - (twin.bedding ? 1 : 0); i++) telemetry.ruleHit("ENGINE:R_BED");

  const viewList = pass2ViewAll(tokens, dict);
  diag.emit("pass2ViewAll", "stage.completed", tokens, "View pattern pass completed.", { output: viewList });
  for (let i = 0; i < viewList.length; i++) telemetry.ruleHit("ENGINE:R_VIEW");

  const ruleOccupancy = pass2OccupancyPattern(tokens);
  diag.emit("pass2OccupancyPattern", "stage.completed", tokens, "Occupancy pattern pass completed.", { output: ruleOccupancy });
  if (ruleOccupancy) telemetry.ruleHit("ENGINE:R_OCCUPANCY");

  diag.snapshot("pass2_structural", tokens);
  telemetry.stage("pass2_structural", tokens, { bedroom, twin, bedding: beddingList, views: viewList, occupancy: ruleOccupancy });

  pass2DropAmbiguous(tokens, diag, telemetry);
  diag.snapshot("pass2DropAmbiguous", tokens);
  telemetry.stage("pass2_ambiguity", tokens);

  const { buckets } = pass3(tokens, options.auditSink, rawName, diag, telemetry);
  telemetry.stage("pass3_buckets", tokens, { buckets });
  if (ruleOccupancy) buckets.occupancy.push(ruleOccupancy);
  if (twin.extraType) buckets.type.push(twin.extraType);
  diag.snapshot("pass3", tokens);

  const result = await assemble(buckets, bedroom, beddingList, viewList);
  result.raw_name = rawName;

  Object.assign(result, telemetry.result());
  result.diagnosticsReport = diag.report();

  return result;
}
