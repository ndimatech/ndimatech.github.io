import test from "node:test";
import assert from "node:assert/strict";
import { verifyWebhook, signWebhook, MOCK_WEBHOOK_SECRET } from "../src/yoco.js";
import { emailOk } from "../src/worker.js";
import { PRODUCTS } from "../src/products.js";

test("toolkit price is R995 in cents", () => assert.equal(PRODUCTS["popia-it-toolkit"].amountCents, 99500));

test("email check refuses lists and junk", () => {
  assert.ok(emailOk("dr.smith@practice.co.za"));
  for (const bad of ["a@b,c.com", "a@b;c.com", "no-at.co.za", "a b@c.com", "<a@b.com>", ""]) assert.equal(emailOk(bad), false, bad);
});

test("webhook signature: valid passes, tampered or stale fails", async () => {
  const body = '{"type":"payment.succeeded"}', ts = String(Math.floor(Date.now() / 1000));
  const sig = await signWebhook(MOCK_WEBHOOK_SECRET, "msg_1", ts, body);
  const h = (s, t = ts) => new Headers({ "webhook-id": "msg_1", "webhook-timestamp": t, "webhook-signature": s });
  assert.equal(await verifyWebhook(MOCK_WEBHOOK_SECRET, h(sig), body), true);
  assert.equal(await verifyWebhook(MOCK_WEBHOOK_SECRET, h(sig), body.replace("succeeded", "failed")), false);
  assert.equal(await verifyWebhook(MOCK_WEBHOOK_SECRET, h(sig, String(Number(ts) - 600)), body), false);
  assert.equal(await verifyWebhook(null, h(sig), body), false);
});
