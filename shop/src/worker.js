// NdimaTech shop: sells digital products (the POPIA IT Toolkit) with Yoco and delivers them by
// an expiring download link, emailed through Brevo. The product page lives on ndimatech.co.za
// (GitHub Pages); this Worker only does checkout, the Yoco webhook and downloads.
//
// Rules:
//  - Never trust Yoco's successUrl. Only a verified payment.succeeded webhook with the right amount
//    marks an order paid.
//  - Download tokens are random and only their SHA-256 is stored.
//  - Mock payments (no YOCO_SECRET_KEY) work only on localhost or where ALLOW_MOCK_PAYMENTS = "1".

import { paymentMode, isMock, webhookSecret, createCheckout, verifyWebhook, signWebhook } from "./yoco.js";
import { PRODUCTS, DOWNLOAD_DAYS, MAX_DOWNLOADS, MAX_RESENDS } from "./products.js";
import { sendEmail, downloadEmail, saleAlert, problemAlert } from "./email.js";

const DAY = 86400000;
const STALE_CLAIM_MS = 5 * 60000;
const RETENTION = { pendingDays: 14, eventDays: 120, emailLogDays: 365 }; // paid orders: 5 years (tax records)
const PAID_YEARS = 5;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    env = { ...env, REQUEST_HOST: url.hostname };
    let res;
    try {
      res = await route(request, env, url, ctx);
    } catch (err) {
      console.error("unhandled", err);
      res = json({ error: "server_error" }, 500);
    }
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/yoco/webhook") {
      const origin = request.headers.get("Origin");
      if (origin && allowedOrigins(env).includes(origin)) {
        res.headers.set("Access-Control-Allow-Origin", origin);
        res.headers.set("Vary", "Origin");
      }
    }
    return res;
  },

  async scheduled(event, env) {
    await cleanUp(env, Date.now());
  },
};

function allowedOrigins(env) {
  const list = [env.SITE_ORIGIN || "https://ndimatech.co.za", "https://www.ndimatech.co.za"];
  if (isLocal(env)) list.push("http://localhost:8000", "http://127.0.0.1:8000", "http://localhost:8787");
  return list;
}

const isLocal = (env) => ["localhost", "127.0.0.1"].includes(env.REQUEST_HOST);

async function route(request, env, url, ctx) {
  const p = url.pathname, m = request.method;
  if (m === "OPTIONS" && p.startsWith("/api/")) {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    } });
  }
  if (p === "/api/checkout" && m === "POST") return startCheckout(request, env, url);
  if (p === "/api/yoco/webhook" && m === "POST") return handleWebhook(request, env, url);
  let mm;
  if ((mm = p.match(/^\/api\/order\/([0-9a-f-]{36})$/)) && m === "GET") return orderStatus(env, mm[1]);
  if ((mm = p.match(/^\/api\/order\/([0-9a-f-]{36})\/resend$/)) && m === "POST") return resend(request, env, url, mm[1]);
  if ((mm = p.match(/^\/d\/([A-Za-z0-9_-]{43})$/)) && m === "GET") return download(env, mm[1]);
  if (p.startsWith("/mock-yoco/")) return mockYoco(request, env, url);
  if (p === "/") return Response.redirect((env.SITE_ORIGIN || "https://ndimatech.co.za") + "/popia-toolkit.html", 302);
  return json({ error: "not_found" }, 404);
}

// ---------- helpers ----------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export function emailOk(e) {
  return typeof e === "string" && e.length <= 254 && /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/.test(e);
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function publicOrigin(env, url) {
  return env.PUBLIC_ORIGIN || url.origin;
}

async function limited(env, key) {
  if (!env.CHECKOUT_LIMITER) return false;
  const { success } = await env.CHECKOUT_LIMITER.limit({ key });
  return !success;
}

// ---------- checkout ----------

async function startCheckout(request, env, url) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await limited(env, ip)) return json({ error: "too_many_requests" }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }

  const product = PRODUCTS[body.product];
  if (!product) return json({ error: "unknown_product" }, 400);
  const email = String(body.email || "").trim().toLowerCase();
  if (!emailOk(email)) return json({ error: "bad_email" }, 400);
  const name = String(body.name || "").trim().slice(0, 120) || null;
  if (body.agree !== true) return json({ error: "terms_not_accepted" }, 400);
  if (paymentMode(env) === "off") return json({ error: "payment_unavailable" }, 503);

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO orders (id, product, email, name, amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
  ).bind(id, body.product, email, name, product.amountCents, now).run();

  const site = env.SITE_ORIGIN || "https://ndimatech.co.za";
  let checkout;
  try {
    checkout = await createCheckout(env, {
      amountCents: product.amountCents,
      bookingId: id,
      metadata: { orderId: id, product: body.product },
      successUrl: `${site}/popia-toolkit-thanks.html?order=${id}`,
      cancelUrl: `${site}${product.page}?cancelled=1`,
      failureUrl: `${site}${product.page}?failed=1`,
      lineItems: [{ displayName: product.name, quantity: 1, pricingDetails: { price: product.amountCents } }],
    });
  } catch (err) {
    console.error("checkout failed", err);
    return json({ error: "payment_unavailable" }, 502);
  }
  await env.DB.prepare("UPDATE orders SET checkout_id = ? WHERE id = ?").bind(checkout.id, id).run();
  const redirectUrl = checkout.redirectUrl.startsWith("/") ? publicOrigin(env, url) + checkout.redirectUrl : checkout.redirectUrl;
  return json({ orderId: id, redirectUrl });
}

// ---------- webhook ----------

async function handleWebhook(request, env, url) {
  const raw = await request.text();
  if (!(await verifyWebhook(webhookSecret(env), request.headers, raw))) return json({ error: "bad_signature" }, 401);
  const eventId = request.headers.get("webhook-id");
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "bad_request" }, 400); }

  const now = Date.now();
  // Claim the event before acting on it, so two copies arriving together can't both be processed.
  const claim = await env.DB.prepare(
    `INSERT INTO processed_events (id, received_at, status) VALUES (?, ?, 'processing')
     ON CONFLICT(id) DO UPDATE SET received_at = excluded.received_at
     WHERE processed_events.status = 'processing' AND processed_events.received_at < ?`,
  ).bind(eventId, now, now - STALE_CLAIM_MS).run();
  if (claim.meta.changes !== 1) {
    const row = await env.DB.prepare("SELECT status FROM processed_events WHERE id = ?").bind(eventId).first();
    if (row?.status === "done") return json({ ok: true, duplicate: true });
    return json({ error: "in_progress" }, 409); // Yoco retries later
  }
  let result;
  try {
    result = await processEvent(env, event, url);
  } catch (err) {
    console.error("webhook processing failed", err);
    await env.DB.prepare("DELETE FROM processed_events WHERE id = ? AND status = 'processing'").bind(eventId).run();
    return json({ error: "processing_failed" }, 500);
  }
  await env.DB.prepare("UPDATE processed_events SET status = 'done' WHERE id = ?").bind(eventId).run();
  return json({ ok: true, result });
}

async function processEvent(env, event, url) {
  if (event.type !== "payment.succeeded") return "ignored";
  const meta = event.payload?.metadata || {};
  const o = await env.DB.prepare("SELECT * FROM orders WHERE checkout_id = ? OR id = ?")
    .bind(meta.checkoutId || "", meta.orderId || "").first();
  if (!o) return "unknown_checkout";
  if (o.status === "paid") return "already_paid";

  const now = Date.now();
  const amountOk = event.payload?.amount === o.amount_cents && (event.payload?.currency || "ZAR") === "ZAR";
  if (!amountOk) {
    await env.DB.prepare("UPDATE orders SET status = 'amount_mismatch', payment_id = ? WHERE id = ?")
      .bind(event.payload?.id || null, o.id).run();
    const a = problemAlert({ orderId: o.id, detail: `Paid amount ${event.payload?.amount} does not match the price ${o.amount_cents}. No download was sent.` });
    await sendEmail(env, { to: env.NOTIFY_EMAIL || env.SENDER_EMAIL, ...a, orderId: o.id, kind: "problem_alert" });
    return "amount_mismatch";
  }

  // Mark paid only once, even if two different events race.
  const upd = await env.DB.prepare(
    "UPDATE orders SET status = 'paid', paid_at = ?, payment_id = ? WHERE id = ? AND status = 'pending'",
  ).bind(now, event.payload?.id || null, o.id).run();
  if (upd.meta.changes !== 1) return "already_paid";

  const emailed = await issueAndSend(env, url, { ...o, status: "paid", paid_at: now }, "download");
  const product = PRODUCTS[o.product];
  const alert = saleAlert({ productName: product?.name || o.product, email: o.email, name: o.name, orderId: o.id, amountCents: o.amount_cents, paidAt: now, emailed });
  await sendEmail(env, { to: env.NOTIFY_EMAIL || env.SENDER_EMAIL, ...alert, orderId: o.id, kind: "sale_alert" });
  return emailed ? "paid_emailed" : "paid_email_failed";
}

// Creates a fresh download token (replacing any earlier one) and emails the link.
async function issueAndSend(env, url, o, kind) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare("UPDATE orders SET token_hash = ?, token_expires_at = ?, downloads = 0 WHERE id = ?")
    .bind(await sha256(token), now + DOWNLOAD_DAYS * DAY, o.id).run();
  const product = PRODUCTS[o.product];
  const msg = downloadEmail({
    productName: product?.name || o.product, link: `${publicOrigin(env, url)}/d/${token}`, orderId: o.id,
    amountCents: o.amount_cents, paidAt: o.paid_at, buyerName: o.name, buyerEmail: o.email,
    days: DOWNLOAD_DAYS, maxDownloads: MAX_DOWNLOADS,
  });
  const ok = await sendEmail(env, { to: o.email, toName: o.name, ...msg, orderId: o.id, kind });
  if (ok) await env.DB.prepare("UPDATE orders SET emailed_at = ? WHERE id = ?").bind(now, o.id).run();
  return ok;
}

// ---------- order status and resend (for the thank-you page) ----------

function maskEmail(e) {
  const [u, d] = e.split("@");
  return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.min(6, u.length - 2))) + "@" + d;
}

async function orderStatus(env, id) {
  const o = await env.DB.prepare("SELECT status, email, emailed_at, resends FROM orders WHERE id = ?").bind(id).first();
  if (!o) return json({ error: "not_found" }, 404);
  return json({
    status: o.status === "paid" ? "paid" : o.status === "pending" ? "pending" : "problem",
    emailed: !!o.emailed_at,
    email: maskEmail(o.email),
    canResend: o.status === "paid" && o.resends < MAX_RESENDS,
  });
}

async function resend(request, env, url, id) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await limited(env, "resend:" + ip)) return json({ error: "too_many_requests" }, 429);
  const o = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!o || o.status !== "paid") return json({ error: "not_found" }, 404);
  const upd = await env.DB.prepare("UPDATE orders SET resends = resends + 1 WHERE id = ? AND resends < ?")
    .bind(id, MAX_RESENDS).run();
  if (upd.meta.changes !== 1) return json({ error: "resend_limit" }, 429);
  const ok = await issueAndSend(env, url, o, "resend");
  return json({ ok, email: maskEmail(o.email) }, ok ? 200 : 502);
}

// ---------- download ----------

function page(title, body, status = 200) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} | NdimaTech</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f5ef;color:#1e2733}main{max-width:520px;margin:12vh auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(10,22,40,.08)}h1{font-family:Georgia,serif;color:#0a1628;font-size:1.5rem;margin:0 0 .8rem}a{color:#00876e}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

async function download(env, token) {
  const o = await env.DB.prepare("SELECT * FROM orders WHERE token_hash = ?").bind(await sha256(token)).first();
  const help = `<p>Email <a href="mailto:setup@ndimatech.co.za">setup@ndimatech.co.za</a> with your order number and we'll send you a fresh link.</p>`;
  if (!o || o.status !== "paid") return page("Link not found", `<p>This download link isn't valid. It may have been replaced by a newer one.</p>${help}`, 404);
  if (Date.now() > o.token_expires_at) return page("Link expired", `<p>This download link has expired.</p>${help}`, 410);
  // Count the download atomically so the limit can't be raced.
  const upd = await env.DB.prepare("UPDATE orders SET downloads = downloads + 1 WHERE id = ? AND downloads < ?")
    .bind(o.id, MAX_DOWNLOADS).run();
  if (upd.meta.changes !== 1) return page("Download limit reached", `<p>This link has been used ${MAX_DOWNLOADS} times.</p>${help}`, 410);
  const product = PRODUCTS[o.product];
  const obj = await env.FILES.get(product.file);
  if (!obj) {
    await env.DB.prepare("UPDATE orders SET downloads = downloads - 1 WHERE id = ?").bind(o.id).run();
    return page("Download unavailable", `<p>Sorry, the file isn't available right now. We've been told, but you can also email us.</p>${help}`, 503);
  }
  return new Response(obj.body, { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${product.downloadName}"`,
    "Cache-Control": "private, no-store",
  } });
}

// ---------- clean-up (daily cron) ----------

export async function cleanUp(env, now) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM orders WHERE status = 'pending' AND created_at < ?").bind(now - RETENTION.pendingDays * DAY),
    env.DB.prepare("DELETE FROM orders WHERE status <> 'pending' AND created_at < ?").bind(now - PAID_YEARS * 365 * DAY),
    env.DB.prepare("DELETE FROM processed_events WHERE received_at < ?").bind(now - RETENTION.eventDays * DAY),
    env.DB.prepare("DELETE FROM email_log WHERE created_at < ?").bind(now - RETENTION.emailLogDays * DAY),
  ]);
}

// ---------- mock Yoco (local tests only) ----------

async function mockYoco(request, env, url) {
  if (!isMock(env)) return json({ error: "not_found" }, 404);
  const mm = url.pathname.match(/^\/mock-yoco\/(ch_mock_\w+)(\/pay|\/cancel)?$/);
  if (!mm) return json({ error: "not_found" }, 404);
  const o = await env.DB.prepare("SELECT * FROM orders WHERE checkout_id = ?").bind(mm[1]).first();
  if (!o) return json({ error: "not_found" }, 404);
  const site = env.SITE_ORIGIN || "https://ndimatech.co.za";
  if (request.method === "GET" && !mm[2]) {
    return page("Test checkout", `<p><strong>Test payment only.</strong> No money moves.</p><p>R${(o.amount_cents / 100).toFixed(2)} for ${PRODUCTS[o.product].name}</p>
<form method="post" action="/mock-yoco/${mm[1]}/pay"><button>Pay (test)</button></form><form method="post" action="/mock-yoco/${mm[1]}/cancel"><button>Cancel</button></form>`);
  }
  if (request.method === "POST" && mm[2] === "/cancel") return Response.redirect(`${site}${PRODUCTS[o.product].page}?cancelled=1`, 303);
  if (request.method === "POST" && mm[2] === "/pay") {
    const amount = Number(url.searchParams.get("amount") || o.amount_cents); // ?amount= lets tests try a wrong amount
    const raw = JSON.stringify({ id: "evt_" + crypto.randomUUID(), type: "payment.succeeded",
      payload: { id: "p_mock_" + crypto.randomUUID().slice(0, 8), amount, currency: "ZAR", status: "succeeded", mode: "test", metadata: { checkoutId: mm[1], orderId: o.id } } });
    const msgId = "msg_" + crypto.randomUUID();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signWebhook(webhookSecret(env), msgId, ts, raw);
    await handleWebhook(new Request(`${url.origin}/api/yoco/webhook`, { method: "POST", body: raw,
      headers: { "webhook-id": msgId, "webhook-timestamp": ts, "webhook-signature": sig } }), env, url);
    return Response.redirect(`${site}/popia-toolkit-thanks.html?order=${o.id}`, 303);
  }
  return json({ error: "not_found" }, 404);
}
