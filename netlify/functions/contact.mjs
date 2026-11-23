// Contact form handler for pkpmholdings.com.
// Receives the homepage contact form and emails it to the PKPM team via Resend.
//
// Netlify environment variables:
//   RESEND_API_KEY      (required) Resend API key.
//   RESEND_FROM_EMAIL   (required) Sender on a domain verified in Resend,
//                       e.g. "PKPM Holdings Website <website@pkpmholdings.com>".
//   CONTACT_TO_EMAILS   (optional) Comma-separated recipients. Defaults below.
//   CONTACT_AUTORESPONSE (optional) "false" turns off the thank-you email to the sender.

import { promises as dns } from "node:dns";

const DEFAULT_RECIPIENTS = [
  "patrick.kiss@pkpmholdings.com",
  "peter.mccann@pkpmholdings.com",
  "calvin.adam@pkpmholdings.com",
];

const LIMITS = { first_name: 100, last_name: 100, email: 200, organization: 200, area_of_interest: 100, message: 5000 };
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
// The page stamps the form with its load time; bots that post straight to the endpoint have no stamp,
// and scripts that fill the form in under a few seconds are not people.
const MIN_FILL_MS = 3000;
const MAX_FILL_MS = 24 * 60 * 60 * 1000;
const MAX_LINKS = 2;
// A spam bot signs its names with a run of capitals glued to the end, e.g. "JuanEvageGM".
const BOT_NAME_RE = /[a-z][A-Z]{2,}$/;

export const config = { path: "/api/contact" };

export default async (req) => {
  const wantsJson = (req.headers.get("accept") || "").includes("application/json");
  const reply = (status, body) =>
    wantsJson
      ? Response.json(body, { status })
      : new Response(null, { status: 303, headers: { location: `/?contact=${body.ok ? "sent" : "error"}#contact` } });

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });

  let fields;
  try {
    fields = await readFields(req);
  } catch {
    return reply(400, { ok: false, error: "Could not read the form." });
  }

  // Honeypots: real visitors never see these fields. Pretend success to bots.
  if (fields.botcheck || fields.website) return reply(200, { ok: true });

  const started = Number(fields.form_started);
  if (!started) return reply(400, { ok: false, error: "Please enable JavaScript to send the form, or email us directly." });
  const elapsed = Date.now() - started;
  if (elapsed < MIN_FILL_MS || elapsed > MAX_FILL_MS) return reply(200, { ok: true });

  const data = {};
  for (const [key, max] of Object.entries(LIMITS)) data[key] = String(fields[key] ?? "").trim().slice(0, max);

  if (!data.first_name || !data.last_name || !data.message || !EMAIL_RE.test(data.email)) {
    return reply(400, { ok: false, error: "Please fill in your name, a valid email and a message." });
  }

  // Link-stuffed messages and URLs in name fields are spam.
  const links = (data.message.match(/https?:\/\/|www\./gi) || []).length;
  if (links > MAX_LINKS || /https?:|www\./i.test(data.first_name + data.last_name + data.organization)) {
    return reply(200, { ok: true });
  }
  if (BOT_NAME_RE.test(data.first_name) || BOT_NAME_RE.test(data.last_name)) return reply(200, { ok: true });

  if (!(await emailDomainAcceptsMail(data.email))) {
    return reply(400, { ok: false, error: "That email address doesn't look valid. Please check it and try again." });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    console.error("contact: RESEND_API_KEY or RESEND_FROM_EMAIL is not set");
    return reply(500, { ok: false, error: "The form is not configured yet. Please email us directly." });
  }

  const to = (process.env.CONTACT_TO_EMAILS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const recipients = to.length ? to : DEFAULT_RECIPIENTS;
  const name = `${data.first_name} ${data.last_name}`;

  const notify = await sendEmail(apiKey, {
    from,
    to: recipients,
    reply_to: data.email,
    subject: `New Contact Form Submission – ${name}${data.organization ? ` (${data.organization})` : ""}`,
    text: notificationText(data),
    html: notificationHtml(data),
  });
  if (!notify.ok) {
    console.error("contact: Resend rejected notification", notify.status, notify.error);
    return reply(502, { ok: false, error: "We couldn't send your message. Please email us directly." });
  }

  if (process.env.CONTACT_AUTORESPONSE !== "false") {
    const ack = await sendEmail(apiKey, {
      from,
      to: [data.email],
      reply_to: recipients[0],
      subject: "Thank you for contacting PKPM Holdings",
      text: `Hi ${data.first_name},\n\nThank you for your interest in PKPM Holdings. We've received your message and will be in touch within 24–48 hours.\n\nPKPM Holdings\nhttps://pkpmholdings.com`,
    });
    // The team already has the message, so a failed thank-you is only logged.
    if (!ack.ok) console.error("contact: autoresponse failed", ack.status, ack.error);
  }

  return reply(200, { ok: true });
};

async function readFields(req) {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) return await req.json();
  const form = await req.formData();
  return Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
}

// A made-up address usually sits on a domain with no mail server. Only a definite "no such domain"
// or "no records" answer rejects; lookup timeouts and other DNS failures let the message through.
async function emailDomainAcceptsMail(email) {
  const domain = email.split("@").pop().toLowerCase();
  const missing = (err) => ["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(err?.code);
  try {
    const mx = await dns.resolveMx(domain);
    return mx.some((r) => r.exchange && r.exchange !== ".");
  } catch (err) {
    if (!missing(err)) return true;
  }
  // No MX record: mail falls back to the domain's own address.
  try {
    return (await dns.resolve4(domain)).length > 0;
  } catch (err) {
    return !missing(err);
  }
}

async function sendEmail(apiKey, payload) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, error: body.message || body.error, id: body.id };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

function rows(data) {
  return [
    ["Name", `${data.first_name} ${data.last_name}`],
    ["Email", data.email],
    ["Organization", data.organization || "—"],
    ["Area of interest", data.area_of_interest || "—"],
  ];
}

function notificationText(data) {
  return `${rows(data).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nMessage:\n${data.message}\n\n— Sent from the pkpmholdings.com contact form. Reply to this email to respond.`;
}

function notificationHtml(data) {
  const cells = rows(data)
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#5b6b7f;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0">${k === "Email" ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v)}</td></tr>`)
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0e2240;max-width:640px">
<h2 style="font-size:18px;margin:0 0 16px">New contact form submission</h2>
<table style="border-collapse:collapse;margin-bottom:16px">${cells}</table>
<div style="color:#5b6b7f;margin-bottom:6px">Message</div>
<div style="white-space:pre-wrap;border-left:3px solid #2080d8;padding:8px 12px;background:#f4f8fc">${esc(data.message)}</div>
<p style="color:#8a97a8;font-size:12px;margin-top:24px">Sent from the pkpmholdings.com contact form. Reply to this email to respond to ${esc(data.first_name)}.</p>
</div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
