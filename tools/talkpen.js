#!/usr/bin/env node
/*
 * talkpen.js — Firestore helper for the English tutor session. No dependencies.
 *
 *   node tools/talkpen.js pending          unanswered learner turns + recent context (JSON)
 *   node tools/talkpen.js add '<json>'     write one AI reply and mark the learner turn answered
 *   node tools/talkpen.js watch [seconds]  poll; print "CALL english <n> <ids>" when new turns wait
 *
 * Auth: a Firebase service-account JSON key. Path from env TALKPEN_SA (or BOARD_SA).
 * Never put the key in this repository.
 */
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");

const PROJECT = "dabin-board";
const COL = "english_turns";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function keyPath() {
  const p = process.env.TALKPEN_SA || process.env.BOARD_SA;
  if (!p || !fs.existsSync(p)) {
    console.error("service account key not found. set TALKPEN_SA=<path to .json>");
    process.exit(2);
  }
  return p;
}

function request(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const u = new URL(url);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { "Content-Type": headers["Content-Type"] || "application/json", ...headers,
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        let j; try { j = JSON.parse(out); } catch { j = out; }
        if (res.statusCode >= 300) return reject(new Error(`${res.statusCode} ${method} ${u.pathname}: ${typeof j === "string" ? j : JSON.stringify(j).slice(0, 400)}`));
        resolve(j);
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

let tokenCache = null;
async function token() {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.t;
  const sa = JSON.parse(fs.readFileSync(keyPath(), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url");
  const r = await request("POST", sa.token_uri || "https://oauth2.googleapis.com/token",
    "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + unsigned + "." + sig,
    { "Content-Type": "application/x-www-form-urlencoded" });
  tokenCache = { t: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
  return tokenCache.t;
}
async function api(method, path, body) {
  return request(method, BASE + path, body, { Authorization: "Bearer " + (await token()) });
}

/* ---- Firestore value encoding ---- */
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
function dec(v) {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  return null;
}
const docToObj = (d) => ({ id: d.name.split("/").pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, dec(x)])) });

async function runQuery(sq) {
  const rows = await api("POST", ":runQuery", { structuredQuery: sq });
  return rows.filter((r) => r.document).map((r) => docToObj(r.document));
}

/* ---- commands ---- */
async function pendingTurns() {
  return runQuery({
    from: [{ collectionId: COL }],
    where: { compositeFilter: { op: "AND", filters: [
      { fieldFilter: { field: { fieldPath: "role" }, op: "EQUAL", value: enc("user") } },
      { fieldFilter: { field: { fieldPath: "answered" }, op: "EQUAL", value: enc(false) } },
    ] } },
    limit: 20,
  });
}
async function recent(n = 16) {
  const rows = await runQuery({ from: [{ collectionId: COL }], orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }], limit: n });
  return rows.reverse();
}

async function cmdPending() {
  const pend = await pendingTurns();
  pend.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const ctx = pend.length ? await recent(16) : [];
  const byId = Object.fromEntries(ctx.map((t) => [t.id, t]));
  const context = ctx.map((t) => t.role === "user"
    ? { id: t.id, who: "learner", text: t.text, scenario: t.scenario, answered: t.answered }
    : { who: "ai", re: t.re, text: t.text, natural: t.natural, scenario: t.scenario, learner_said: (byId[t.re] || {}).text });
  console.log(JSON.stringify({ pending: pend, context }, null, 2));
}

async function cmdAdd(json) {
  const r = JSON.parse(json);
  if (!r.re) throw new Error('"re" (learner turn id) is required');
  if (typeof r.text !== "string" || !r.text.trim()) throw new Error('"text" (reply) is required');
  const learner = docToObj(await api("GET", `/${COL}/${r.re}`));
  const doc = {
    role: "ai", re: r.re, ts: r.ts || Date.now(), scenario: learner.scenario || "", level: learner.level || "",
    understood: ["yes", "partly", "no"].includes(r.understood) ? r.understood : "yes",
    meaning_ko: typeof r.meaning_ko === "string" ? r.meaning_ko : "",
    natural: typeof r.natural === "string" ? r.natural : "",
    corrections: Array.isArray(r.corrections) ? r.corrections.filter((c) => c && typeof c.right === "string")
      .map((c) => ({ wrong: String(c.wrong || ""), right: c.right, why: String(c.why || "") })) : [],
    text: r.text, ko: typeof r.ko === "string" ? r.ko : "",
  };
  const created = await api("POST", `/${COL}`, { fields: enc(doc).mapValue.fields });
  await api("PATCH", `/${COL}/${r.re}?updateMask.fieldPaths=answered&updateMask.fieldPaths=answered_at`,
    { fields: { answered: enc(true), answered_at: enc(Date.now()) } });
  console.log("ok " + created.name.split("/").pop());
}

async function cmdWatch(sec) {
  const every = Math.max(5, Number(sec) || 15) * 1000;
  let last = "";
  console.log(`watching ${COL} every ${every / 1000}s`);
  for (;;) {
    try {
      const pend = await pendingTurns();
      const key = pend.map((p) => p.id).sort().join(",");
      if (pend.length && key !== last) { console.log(`CALL english ${pend.length} ${key} ${new Date().toISOString()}`); last = key; }
      if (!pend.length) last = "";
    } catch (e) { console.error("watch error: " + e.message); }
    await new Promise((r) => setTimeout(r, every));
  }
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "pending") await cmdPending();
    else if (cmd === "add") await cmdAdd(arg);
    else if (cmd === "watch") await cmdWatch(arg);
    else { console.log("usage: talkpen.js pending | add '<json>' | watch [seconds]"); process.exit(1); }
  } catch (e) { console.error("error: " + e.message); process.exit(1); }
})();
