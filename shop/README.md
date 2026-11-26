# NdimaTech shop (Cloudflare Worker)

Sells the POPIA IT Toolkit (R995, no VAT) and delivers it automatically.

1. The product page `popia-toolkit.html` (GitHub Pages) posts the buyer's email to `POST /api/checkout`.
2. The Worker saves a pending order in D1 and creates a Yoco checkout. The buyer pays on Yoco's page.
3. Yoco calls `POST /api/yoco/webhook`. Only a correctly signed `payment.succeeded` for the right amount
   marks the order paid. The success redirect is never trusted.
4. The Worker emails a receipt with a download link through Brevo (works 30 days, 10 downloads) and alerts
   NdimaTech. The link opens `download.html` on ndimatech.co.za (token after `#`, never sent to a server),
   so buyers only see NdimaTech's own domain.
5. On a tap, `download.html` posts the token to `POST /api/download`, which streams the zip from the private R2
   bucket; the page saves it. The tap is required so email link scanners can't use up downloads.
   `GET /d/<token>` (direct link, used by local tests and the first test email) does the same checks. `popia-toolkit-thanks.html` shows the
   order status and lets the buyer ask for a fresh link (3 times).

Daily clean-up (01:00 UTC): unpaid orders after 14 days, webhook records after 120 days, email log after
a year, paid orders after 5 years (tax records). The privacy notice says the same.

## One-time setup (Mubarak, in NdimaTech's Cloudflare account)

1. **R2:** create a bucket `ndimatech-products` (keep it private) and upload
   `NdimaTech-POPIA-IT-Toolkit.zip` with exactly that name.
2. **D1:** create a database `ndimatech-shop` and put its ID in `wrangler.toml` (`database_id`).
3. **Worker:** Workers & Pages > Create > Import a repository > `ndimatech/ndimatech.github.io`.
   Root directory `shop`. Build command `npx wrangler d1 migrations apply ndimatech-shop --remote`.
   Deploy command `npx wrangler deploy`. Note the address it gets (`ndimatech-shop.<you>.workers.dev`)
   (expected: https://ndimatech-shop.setup-af5.workers.dev) and check it matches the `shop-api` meta tag of `popia-toolkit.html` and `popia-toolkit-thanks.html`.
4. **Secrets** (Worker > Settings > Variables and secrets, type Secret):
   - `BREVO_API_KEY`: Brevo > SMTP & API > API keys.
   - `YOCO_SECRET_KEY`: start with the **test** key (`sk_test_...`).
   - `YOCO_WEBHOOK_SECRET`: from step 5.
5. **Register the Yoco webhook** from your own Terminal (the key never leaves your computer):
   ```
   curl -s https://payments.yoco.com/api/webhooks \
     -H "Authorization: Bearer sk_test_YOUR_KEY" -H "Content-Type: application/json" \
     -d '{"name":"ndimatech-shop","url":"https://ndimatech-shop.YOU.workers.dev/api/yoco/webhook"}'
   ```
   Copy the `secret` (starts with `whsec_`) into `YOCO_WEBHOOK_SECRET`. Repeat with the live key
   when going live (live and test webhooks are separate).
6. **Test with Yoco's test card** on the real page, then check: download email arrives, zip opens,
   sale alert arrives, the order shows as paid. Only then swap in the live key and live webhook secret.

## Live R10 test

Product `test-r10` (R10, real payment, delivers the real zip) only accepts the buyer email
setup@ndimatech.co.za. Get a payment link from your own Terminal:
```
curl -s https://ndimatech-shop.setup-af5.workers.dev/api/checkout -H "Content-Type: application/json" \
  -d '{"product":"test-r10","email":"setup@ndimatech.co.za","name":"Live test","agree":true}'
```
Open the `redirectUrl`, pay R10, check the receipt, sale alert and download. Refund in the Yoco portal if wanted.

## Local testing

```
npm install
npx wrangler d1 migrations apply ndimatech-shop --local
npx wrangler r2 object put ndimatech-products/NdimaTech-POPIA-IT-Toolkit.zip --file <zip> --local
npx wrangler dev --var EMAIL_MOCK:1 --var SITE_ORIGIN:http://localhost:8000
npm test
```
Without `YOCO_SECRET_KEY`, localhost uses a mock checkout (`/mock-yoco/...`) that sends a correctly signed
webhook through the real verification path; `?amount=100` on the pay step tests a wrong amount.
Mock emails are printed to the console. Mock payments are refused on any other host.

## Rules
- Never trust Yoco's successUrl. Only the verified webhook, with the right amount, delivers the product.
- The product zip lives only in the private R2 bucket. Never commit it to this public repo.
- A Yoco test key (`sk_test_`) switches checkout off on the live shop, so a test card can't get the product
  free. To run a test purchase, add a plain variable `ALLOW_TEST_KEY` = `1`, then delete it afterwards.
- Never put secrets in `wrangler.toml`. Never set `ALLOW_MOCK_PAYMENTS` or `EMAIL_MOCK` in deployed config.
- Buyers and alerts only ever see the short order number (`orderRef`: `NT-` + first 8 characters of the
  id). Never put the full database id in an email or on a page; a test fails if an email contains it.
  To find an order: `SELECT * FROM orders WHERE id LIKE '<8 characters, lower case>%';`
- The Yoco webhook signature was checked against real Yoco events: a test-mode purchase (26 Nov 2026) and
  a live R10 purchase (26 Nov 2026) were both confirmed and delivered.
