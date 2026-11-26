// Sends email through Brevo's transactional API. Without BREVO_API_KEY (local tests only) emails are
// logged instead of sent, so the purchase flow can be tested end to end.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function sendEmail(env, { to, toName, subject, html, text, orderId, kind }) {
  const now = Date.now();
  let ok = false, detail = "";
  try {
    if (!env.BREVO_API_KEY) {
      if (env.EMAIL_MOCK !== "1") throw new Error("Email not configured (no BREVO_API_KEY)");
      console.log(`[mock email] to=${to} subject=${subject}\n${text}`);
      ok = true; detail = "mock";
    } else {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          sender: { name: "NdimaTech", email: env.SENDER_EMAIL },
          replyTo: { email: env.REPLY_TO || env.SENDER_EMAIL },
          to: [{ email: to, ...(toName ? { name: toName } : {}) }],
          subject, htmlContent: html, textContent: text,
        }),
      });
      detail = (await res.text()).slice(0, 300);
      ok = res.ok;
    }
  } catch (err) {
    detail = String(err.message || err).slice(0, 300);
  }
  await env.DB.prepare("INSERT INTO email_log (order_id, kind, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(orderId || null, kind, ok ? 1 : 0, detail, now).run();
  return ok;
}

// Seller details shown on every receipt (no VAT line: NdimaTech is not VAT registered).
const SELLER = {
  name: "NdimaTech (Pty) Ltd",
  reg: "2024/335961/07",
  email: "setup@ndimatech.co.za",
  site: "ndimatech.co.za",
};

const FONT = "font-family:Helvetica,Arial,sans-serif;";
const NAVY = "#0a1628", GREEN = "#00b890", INK = "#333f4d", MUTED = "#6b7785", LINE = "#e3e8ee";

// R995.00, R1 250.00 (dot decimals, as on the website and Yoco's page).
export const rands = (cents) => "R" + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

export function saDate(ms, withTime = false) {
  const d = new Date(ms || Date.now());
  const opts = { timeZone: "Africa/Johannesburg", day: "numeric", month: "long", year: "numeric" };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleString("en-ZA", opts).replace(",", "");
}

function frame(title, preheader, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f6f8"><tr><td align="center" style="padding:24px 12px;">
<table width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:10px;border:1px solid ${LINE};">
<tr><td bgcolor="${NAVY}" style="background:${NAVY};border-radius:10px 10px 0 0;padding:18px 28px;${FONT}font-size:20px;font-weight:700;color:#ffffff;">Ndima<span style="color:${GREEN};">Tech</span></td></tr>
${bodyHtml}
</table>
<table width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;"><tr><td style="padding:16px 28px;${FONT}font-size:12px;line-height:18px;color:${MUTED};text-align:center;">
${SELLER.name} &middot; Reg. ${SELLER.reg}<br><a href="mailto:${SELLER.email}" style="color:${MUTED};">${SELLER.email}</a> &middot; <a href="https://${SELLER.site}" style="color:${MUTED};">${SELLER.site}</a>
</td></tr></table>
</td></tr></table></body></html>`;
}

const P = (html, pad = "8px 28px") => `<tr><td style="padding:${pad};${FONT}font-size:15px;color:${INK};line-height:24px;">${html}</td></tr>`;
const H = (text) => `<tr><td style="padding:28px 28px 6px;${FONT}font-size:22px;font-weight:700;color:${NAVY};line-height:30px;">${esc(text)}</td></tr>`;
const button = (href, label) => `<tr><td align="center" style="padding:16px 28px 20px;text-align:center;"><a href="${esc(href)}" style="display:inline-block;background:${GREEN};color:${NAVY};${FONT}font-size:15px;font-weight:700;text-decoration:none;padding:13px 24px;border-radius:8px;">${esc(label)}</a></td></tr>`;

// The order number people see: NT- plus the first 8 characters of the database id (NT-D599B7C9).
// Emails and pages must never show the full database id; test/shop.test.js checks every email.
// Look an order up by it: SELECT * FROM orders WHERE id LIKE 'd599b7c9%';
export const orderRef = (id) => "NT-" + String(id).slice(0, 8).toUpperCase();

// Receipt-style list: label left, value right, thin rules between rows, bold total. No outer box,
// so it sits evenly in every mail app at any width.
function box(title, rows, total) {
  const cell = `${FONT}font-size:14px;line-height:20px;padding:10px 0;border-top:1px solid ${LINE};`;
  const body = rows.map(([k, v]) =>
    `<tr><td style="${cell}color:${MUTED};padding-right:16px;white-space:nowrap;" valign="top">${esc(k)}</td><td style="${cell}color:${INK};text-align:right;" valign="top">${v}</td></tr>`).join("");
  const tcell = `${FONT}font-size:16px;line-height:22px;padding:12px 0 4px;border-top:2px solid ${NAVY};color:${NAVY};font-weight:700;`;
  const tot = total ? `<tr><td style="${tcell}">${esc(total[0])}</td><td style="${tcell}text-align:right;">${total[1]}</td></tr>` : "";
  return `<tr><td style="padding:12px 28px 16px;">
<div style="${FONT}font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${MUTED};padding-bottom:8px;">${esc(title)}</div>
<table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">${body}${tot}</table></td></tr>`;
}

export function downloadEmail({ productName, link, orderId, amountCents, paidAt, buyerName, buyerEmail, days, maxDownloads }) {
  const amount = rands(amountCents);
  const date = saDate(paidAt);
  const subject = "Your POPIA IT Toolkit: download link and receipt";
  const greet = buyerName ? `Hi ${esc(buyerName.split(" ")[0])},` : "Hi,";
  const html = frame(subject, `Payment received: ${amount}. Your download link is inside.`,
    H("Thank you for your purchase") +
    P(`${greet}<br>Your payment went through. Your toolkit is ready to download:`) +
    button(link, "Download the toolkit (zip)") +
    P(`The link works for ${days} days and up to ${maxDownloads} downloads, so save the files somewhere safe. Open <em>0 Start here</em> first.`, "0 28px 16px") +
    box("Receipt", [
      ["Date paid", esc(date)],
      ["Order number", esc(orderRef(orderId))],
      ["Billed to", esc(buyerName ? `${buyerName}, ${buyerEmail}` : buyerEmail)],
      ["Item", `${esc(productName)} (digital download) &times; 1`],
      ["Paid with", "Online payment via Yoco"],
    ], ["Total paid", amount]) +
    P(`Keep this email as your receipt. Questions, or trouble downloading? Just reply and we'll help.`) +
    P(`MJ<br>NdimaTech`, "8px 28px 28px"));
  const text = `Thank you for your purchase

${buyerName ? `Hi ${buyerName.split(" ")[0]},` : "Hi,"}
Your payment went through. Download your toolkit here:
${link}

The link works for ${days} days and up to ${maxDownloads} downloads, so save the files somewhere safe. Open "0 Start here" first.

RECEIPT
Date paid:    ${date}
Order number: ${orderRef(orderId)}
Billed to:    ${buyerName ? `${buyerName}, ${buyerEmail}` : buyerEmail}
Item:         ${productName} (digital download) x 1
Paid with:    Online payment via Yoco
Total paid:   ${amount}

Keep this email as your receipt. Questions, or trouble downloading? Just reply and we'll help.

MJ
NdimaTech

${SELLER.name} · Reg. ${SELLER.reg}
${SELLER.email} · ${SELLER.site}`;
  return { subject, html, text };
}

export function saleAlert({ productName, email, name, orderId, amountCents, paidAt, emailed }) {
  const amount = rands(amountCents);
  const sent = emailed
    ? `<span style="color:#0a7a5c;font-weight:700;">Yes</span>`
    : `<span style="color:#b42318;font-weight:700;">NO</span><br>Send the files by hand, or ask the buyer to use "resend" on the thank-you page`;
  const subject = `Sale: ${productName} (${amount.replace(/\.00$/, "")})`;
  const html = frame(subject, `${name || email} paid ${amount}.`,
    H(`New sale: ${amount}`) +
    P(`Someone just bought the <strong>${esc(productName)}</strong>.`) +
    box("Sale details", [
      ["Buyer", esc(name || "(no name given)")],
      ["Email", `<a href="mailto:${esc(email)}" style="color:#008f70;">${esc(email)}</a>`],
      ["Paid", esc(saDate(paidAt, true))],
      ["Order number", esc(orderRef(orderId))],
      ["Download email sent", sent],
    ], ["Amount", amount]) +
    P(`The payment also shows in your Yoco portal.`, "0 28px 28px"));
  const text = `New sale: ${productName}
Buyer: ${name || "(no name given)"} <${email}>
Amount: ${amount}
Paid: ${saDate(paidAt, true)}
Order: ${orderRef(orderId)}
Download email sent: ${emailed ? "yes" : "NO - send the files by hand or ask the buyer to use 'resend' on the thank-you page"}`;
  return { subject, text, html };
}

export function problemAlert({ orderId, detail }) {
  const subject = `Shop problem: order ${orderRef(orderId)}`;
  const text = `Shop problem on order ${orderRef(orderId)}:\n${detail}\n\nCheck the Yoco portal and the order in D1 (orders table).`;
  const html = frame(subject, "A shop order needs your attention.",
    H("A shop order needs your attention") +
    box("Problem", [["Order number", esc(orderRef(orderId))], ["What happened", esc(detail)]]) +
    P(`Check the payment in your Yoco portal and the order in the shop's database (orders table).`, "0 28px 28px"));
  return { subject, text, html };
}
