// Cloudflare Pages Function: POST /api/contact
// Sends contact form submissions through Resend.
//
// Environment variables (Cloudflare Pages > Settings > Variables and Secrets):
//   RESEND_API_KEY       (secret, required)  Resend API key
//   CONTACT_FROM_EMAIL   (required)          e.g. "PKPM Holdings <website@pkpmholdings.com>"
//                                            Domain must be verified in Resend.
//   CONTACT_TO_EMAILS    (optional)          Comma-separated recipients; defaults below.
//   CONTACT_AUTORESPONSE (optional)          "false" disables the confirmation email to the sender.

const DEFAULT_TO_EMAILS = [
  "patrick.kiss@pkpmholdings.com",
  "calvin.adam@pkpmholdings.com",
  "peter.mccann@pkpmholdings.com"
];

const AUTORESPONSE_TEXT =
  "Thank you for your interest in PKPM Holdings. We've received your message and will be in touch within 24–48 hours.";

const LIMITS = { first_name: 100, last_name: 100, email: 254, organization: 200, area_of_interest: 100, message: 5000 };

export async function onRequestPost(context) {
  const wantsJson = (context.request.headers.get("accept") || "").includes("application/json");
  const respond = (status, body) =>
    wantsJson
      ? json(status, body)
      : Response.redirect(new URL(`/?contact=${body.ok ? "sent" : "error"}#contact`, context.request.url).toString(), 303);

  let fields;
  try {
    fields = await readFields(context.request);
  } catch {
    return respond(400, { ok: false, error: "Could not read the form submission." });
  }

  // Honeypot: bots fill hidden fields. Pretend success so they don't retry.
  if (fields.botcheck) return respond(200, { ok: true });

  const data = {};
  for (const [key, max] of Object.entries(LIMITS)) data[key] = clean(fields[key]).slice(0, max);

  if (!data.first_name || !data.last_name || !data.message) {
    return respond(400, { ok: false, error: "Please fill in your name and message." });
  }
  if (!isEmail(data.email)) {
    return respond(400, { ok: false, error: "Please enter a valid email address." });
  }

  const env = context.env || {};
  const apiKey = clean(env.RESEND_API_KEY);
  const from = clean(env.CONTACT_FROM_EMAIL);
  if (!apiKey || !from) {
    console.error("Contact form misconfigured: RESEND_API_KEY and CONTACT_FROM_EMAIL are required.");
    return respond(500, { ok: false, error: "Email is not configured. Please email us directly." });
  }
  const to = clean(env.CONTACT_TO_EMAILS)
    ? clean(env.CONTACT_TO_EMAILS).split(",").map(clean).filter(isEmail)
    : DEFAULT_TO_EMAILS;

  const name = `${data.first_name} ${data.last_name}`;
  const notification = await sendEmail(apiKey, {
    from,
    to,
    reply_to: [data.email],
    subject: `New Contact Form Submission – ${name}`,
    text: notificationText(data),
    html: notificationHtml(data)
  });
  if (!notification.ok) {
    console.error("Resend notification failed:", notification.error);
    return respond(502, { ok: false, error: "We couldn't send your message. Please email us directly." });
  }

  if (clean(env.CONTACT_AUTORESPONSE).toLowerCase() !== "false") {
    const confirmation = await sendEmail(apiKey, {
      from,
      to: [data.email],
      reply_to: to,
      subject: "Thanks for contacting PKPM Holdings",
      text: `Hi ${data.first_name},\n\n${AUTORESPONSE_TEXT}\n\n— PKPM Holdings`,
      html: `<p>Hi ${escapeHtml(data.first_name)},</p><p>${escapeHtml(AUTORESPONSE_TEXT)}</p><p>— PKPM Holdings</p>`
    });
    // The team already has the message, so a failed confirmation isn't a user-facing error.
    if (!confirmation.ok) console.error("Resend autoresponse failed:", confirmation.error);
  }

  return respond(200, { ok: true });
}

export function onRequest() {
  return json(405, { ok: false, error: "Method not allowed." }, { allow: "POST" });
}

async function sendEmail(apiKey, payload) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.message || body.error || `Resend returned ${res.status}` };
    return { ok: true, id: body.id || "" };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function readFields(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return (await request.json()) || {};
  return Object.fromEntries(await request.formData());
}

function notificationText(d) {
  return [
    `Name: ${d.first_name} ${d.last_name}`,
    `Email: ${d.email}`,
    `Organization: ${d.organization || "—"}`,
    `Area of Interest: ${d.area_of_interest || "—"}`,
    "",
    d.message
  ].join("\n");
}

function notificationHtml(d) {
  const row = (label, value) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top">${label}</td><td style="padding:4px 0">${value}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
  <h2 style="font-size:18px;margin:0 0 12px">New contact form submission</h2>
  <table style="border-collapse:collapse">
    ${row("Name", escapeHtml(`${d.first_name} ${d.last_name}`))}
    ${row("Email", `<a href="mailto:${escapeHtml(d.email)}">${escapeHtml(d.email)}</a>`)}
    ${row("Organization", escapeHtml(d.organization || "—"))}
    ${row("Area of Interest", escapeHtml(d.area_of_interest || "—"))}
  </table>
  <p style="white-space:pre-wrap;margin-top:16px">${escapeHtml(d.message)}</p>
</div>`;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isEmail(value) {
  return /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
