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

import { paymentMode } from "../src/yoco.js";
test("a Yoco test key is refused unless ALLOW_TEST_KEY is set", () => {
  assert.equal(paymentMode({ YOCO_SECRET_KEY: "sk_test_abc", REQUEST_HOST: "ndimatech-shop.setup-af5.workers.dev" }), "off");
  assert.equal(paymentMode({ YOCO_SECRET_KEY: "sk_test_abc", ALLOW_TEST_KEY: "1" }), "live");
  assert.equal(paymentMode({ YOCO_SECRET_KEY: "sk_live_abc" }), "live");
});

test("the R10 test product is only sold to NdimaTech's own address", () => {
  assert.equal(PRODUCTS["test-r10"].amountCents, 1000);
  assert.equal(PRODUCTS["test-r10"].onlyEmail, "setup@ndimatech.co.za");
});

import { downloadEmail, saleAlert, problemAlert, orderRef } from "../src/email.js";
test("emails show the short order number, never the full database id", () => {
  const id = "d599b7c9-54be-43c8-b585-4a455d754ea0";
  const emails = [
    downloadEmail({ productName: "P", link: "https://ndimatech.co.za/download.html#x", orderId: id, amountCents: 99500, paidAt: 0, buyerName: "A B", buyerEmail: "a@b.co", days: 30, maxDownloads: 10 }),
    saleAlert({ productName: "P", email: "a@b.co", name: "A B", orderId: id, amountCents: 99500, paidAt: 0, emailed: true }),
    saleAlert({ productName: "P", email: "a@b.co", name: "A B", orderId: id, amountCents: 99500, paidAt: 0, emailed: false }),
    problemAlert({ orderId: id, detail: "x" }),
  ];
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const e of emails) {
    for (const part of [e.subject, e.html, e.text]) assert.ok(!uuid.test(part), "full id found in: " + e.subject);
    assert.ok((e.html + e.text).includes(orderRef(id)), "short order number missing in: " + e.subject);
  }
});
