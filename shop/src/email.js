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

function frame(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;"><table width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f6f8"><tr><td align="center" style="padding:24px 12px;">
<table width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:10px;">
<tr><td style="background:#0a1628;border-radius:10px 10px 0 0;padding:18px 28px;font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:#ffffff;">Ndima<span style="color:#00b890;">Tech</span></td></tr>
${bodyHtml}
</table></td></tr></table></body></html>`;
}

const P = (html) => `<tr><td style="padding:8px 28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#333f4d;line-height:24px;">${html}</td></tr>`;

export function downloadEmail({ productName, link, orderId, amountCents, days, maxDownloads }) {
  const rand = (amountCents / 100).toFixed(2);
  const subject = "Your POPIA IT Toolkit download";
  const html = frame(subject,
    `<tr><td style="padding:28px 28px 8px;font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;color:#0a1628;line-height:30px;">Thank you for your purchase</td></tr>` +
    P(`Your payment for the <strong>${esc(productName)}</strong> went through. Download your templates here:`) +
    `<tr><td style="padding:18px 28px;"><a href="${esc(link)}" style="display:inline-block;background:#00b890;color:#0a1628;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:13px 24px;border-radius:8px;">Download the toolkit (zip)</a></td></tr>` +
    P(`The link works for ${days} days and up to ${maxDownloads} downloads, so save the files somewhere safe. Open <em>0 Start here</em> first.`) +
    P(`<strong>Order:</strong> ${esc(orderId)}<br><strong>Paid:</strong> R${rand}`) +
    P(`Questions, or trouble downloading? Just reply to this email.<br><br>MJ<br>NdimaTech &middot; <a href="https://ndimatech.co.za" style="color:#008f70;">ndimatech.co.za</a>`) +
    `<tr><td style="padding:4px 28px 24px;"></td></tr>`);
  const text = `Thank you for your purchase.

Your payment for the ${productName} went through. Download your templates here:
${link}

The link works for ${days} days and up to ${maxDownloads} downloads, so save the files somewhere safe. Open "0 Start here" first.

Order: ${orderId}
Paid: R${rand}

Questions, or trouble downloading? Just reply to this email.

MJ
NdimaTech · ndimatech.co.za`;
  return { subject, html, text };
}

export function saleAlert({ productName, email, name, orderId, amountCents, emailed }) {
  const text = `New sale: ${productName}
Buyer: ${name || "(no name)"} <${email}>
Amount: R${(amountCents / 100).toFixed(2)}
Order: ${orderId}
Download email sent: ${emailed ? "yes" : "NO - send the files by hand or ask the buyer to use 'resend' on the thank-you page"}`;
  return { subject: `Sale: ${productName} (R${(amountCents / 100).toFixed(0)})`, text, html: `<pre style="font-family:Menlo,monospace;font-size:13px;">${esc(text)}</pre>` };
}

export function problemAlert({ orderId, detail }) {
  const text = `Shop problem on order ${orderId}:\n${detail}\n\nCheck the Yoco portal and the order in D1 (orders table).`;
  return { subject: `Shop problem: order ${orderId}`, text, html: `<pre style="font-family:Menlo,monospace;font-size:13px;">${esc(text)}</pre>` };
}
