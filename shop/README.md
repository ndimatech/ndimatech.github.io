# NdimaTech shop (Cloudflare Worker)

Sells the POPIA IT Toolkit (R995, no VAT) and delivers it automatically.

1. The product page `popia-toolkit.html` (GitHub Pages) posts the buyer's email to `POST /api/checkout`.
2. The Worker saves a pending order in D1 and creates a Yoco checkout. The buyer pays on Yoco's page.
3. Yoco calls `POST /api/yoco/webhook`. Only a correctly signed `payment.succeeded` for the right amount
   marks the order paid. The success redirect is never trusted.
4. The Worker emails a download link through Brevo (works 30 days, 10 downloads) and alerts NdimaTech.
5. `GET /d/<token>` streams the zip from the private R2 bucket. `popia-toolkit-thanks.html` shows the
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
- Never put secrets in `wrangler.toml`. Never set `ALLOW_MOCK_PAYMENTS` or `EMAIL_MOCK` in deployed config.
- The Yoco webhook signature code follows Yoco's docs (Standard Webhooks) and passes local tests, but has
  not yet been checked against a real Yoco event: step 6 is that check.
