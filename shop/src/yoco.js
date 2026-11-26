// Yoco Checkout API client, plus a mock used when no secret key is configured.
// Docs: https://developer.yoco.com/guides/online-payments

const API = "https://payments.yoco.com/api";
export const MOCK_WEBHOOK_SECRET = "whsec_" + btoa("ndimatech-shop-local-mock-secret!");

// The real site. Test payments are never allowed here, whatever the settings say.
export const PRODUCTION_HOSTS = ["shop.ndimatech.co.za"]; // plus the live workers.dev host, see worker.js
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

// Which payment mode a request runs in:
//   "live" - a Yoco key is configured (Yoco's own test keys count: Yoco decides test vs live).
//   "mock" - the built-in test checkout. Only on your own computer, or where ALLOW_MOCK_PAYMENTS = "1"
//            (branch previews), and never on the real domain.
//   "off"  - neither. Checkouts fail safely with "payment_unavailable" instead of taking free bookings.
// The worker sets env.REQUEST_HOST for every request; without it the host is unknown and mock is refused.
export function paymentMode(env) {
  if (env.YOCO_SECRET_KEY) {
    // A Yoco test key would let anyone "pay" with a test card and get the product free. Refuse it unless
    // explicitly allowed for a test run (plain variable ALLOW_TEST_KEY = "1", removed afterwards).
    if (env.YOCO_SECRET_KEY.startsWith("sk_test_") && env.ALLOW_TEST_KEY !== "1") return "off";
    return "live";
  }
  const host = env.REQUEST_HOST || "";
  if (!host || PRODUCTION_HOSTS.includes(host)) return "off";
  if (LOCAL_HOSTS.includes(host) || env.ALLOW_MOCK_PAYMENTS === "1") return "mock";
  return "off";
}

export function isMock(env) {
  return paymentMode(env) === "mock";
}

function requireLive(env) {
  if (paymentMode(env) !== "live") throw new Error("Payments are not configured (no YOCO_SECRET_KEY)");
}

export function webhookSecret(env) {
  const mode = paymentMode(env);
  if (mode === "live") return env.YOCO_WEBHOOK_SECRET || null;
  return mode === "mock" ? MOCK_WEBHOOK_SECRET : null;
}

export async function createCheckout(env, { amountCents, bookingId, metadata, successUrl, cancelUrl, failureUrl, lineItems }) {
  if (!isMock(env)) requireLive(env);
  if (isMock(env)) {
    const id = "ch_mock_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    return { id, redirectUrl: `/mock-yoco/${id}` };
  }
  const res = await fetch(`${API}/checkouts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.YOCO_SECRET_KEY}`,
      "Idempotency-Key": bookingId, // one checkout per order, safe to retry
    },
    body: JSON.stringify({
      amount: amountCents,
      currency: "ZAR",
      successUrl, cancelUrl, failureUrl,
      metadata: metadata || { bookingId },
      lineItems,
    }),
  });
  if (!res.ok) throw new Error(`Yoco checkout failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, redirectUrl: data.redirectUrl };
}

// Full refund of a checkout (Yoco's Checkout API does not support partial refunds).
export async function refundCheckout(env, checkoutId, idempotencyKey) {
  if (isMock(env)) return { status: "succeeded", mock: true };
  requireLive(env);
  const res = await fetch(`${API}/checkouts/${checkoutId}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.YOCO_SECRET_KEY}`, "Idempotency-Key": idempotencyKey },
  });
  if (!res.ok) throw new Error(`Yoco refund failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---- Webhook signatures (Standard Webhooks, as Yoco documents) ----

function b64ToBytes(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function hmac(secret, content) {
  const key = await crypto.subtle.importKey(
    "raw", b64ToBytes(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return bytesToB64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signWebhook(secret, id, timestamp, rawBody) {
  return "v1," + (await hmac(secret, `${id}.${timestamp}.${rawBody}`));
}

// Returns true only if the signature matches and the timestamp is within 3 minutes.
export async function verifyWebhook(secret, headers, rawBody, nowMs = Date.now()) {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!secret || !id || !ts || !sigHeader) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > 180) return false;
  const expected = await hmac(secret, `${id}.${ts}.${rawBody}`);
  return sigHeader.split(" ").some((part) => {
    const sig = part.includes(",") ? part.split(",")[1] : part;
    return safeEqual(sig, expected);
  });
}
