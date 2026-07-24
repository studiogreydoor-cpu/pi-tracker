// Daily digest of what's overdue and due soon.
// Email is optional: set SMTP_HOST, SMTP_USER, SMTP_PASS and ALERT_TO to switch it on.
// Without those the digest is still available in the app.
const D = require("./db");
const db = D.db;

let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch (e) { nodemailer = null; }

function buildDigest(companyId, opts) {
  const filterBuyerIds = opts && opts.buyerIds ? new Set(opts.buyerIds) : null;
  const all = D.getAllSkusDecorated(companyId).filter((s) => !s.shipped && !s.complete);
  const piNo = {}, piBuyer = {};
  db.prepare(`SELECT p.id, p.pi_no, p.buyer_id, b.name AS buyer_name, b.coordinator_name, b.coordinator_email
    FROM pis p LEFT JOIN buyers b ON b.id = p.buyer_id`).all().forEach((p) => {
    piNo[p.id] = p.pi_no;
    piBuyer[p.id] = p;
  });
  const today = D.todayISO();

  const rows = all
    .filter((s) => s.overall_due)
    .filter((s) => !filterBuyerIds || filterBuyerIds.has((piBuyer[s.pi_id] || {}).buyer_id))
    .map((s) => ({
      item: s.item_no, desc: s.description || "", pi: piNo[s.pi_id] || "",
      buyer: (piBuyer[s.pi_id] || {}).buyer || "", coordinator: (piBuyer[s.pi_id] || {}).coordinator || "",
      buyer: (piBuyer[s.pi_id] || {}).buyer_name || "",
      coordinator: (piBuyer[s.pi_id] || {}).coordinator_name || "",
      qty: s.qty, still_due: s.still_due, due: s.overall_due,
      days: D.daysBetween(today, s.overall_due),
      vendors: (s.vendors || []).map((v) => v.vendor).filter(Boolean),
      late_vendors: s.late_vendors || [],
    }))
    .sort((a, b) => a.days - b.days);

  return {
    date: today,
    overdue: rows.filter((r) => r.days < 0),
    dueSoon: rows.filter((r) => r.days >= 0 && r.days <= 7),
    totals: {
      open_skus: all.length,
      pieces_due: all.reduce((t, s) => t + Math.max(0, s.still_due), 0),
    },
  };
}

function digestHtml(dg, companyName) {
  const row = (r, late) => `
    <tr>
      <td style="padding:7px 10px;border-bottom:1px solid #E2DACA;font-weight:600">${r.item}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #E2DACA;color:#7C7565">${r.desc}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #E2DACA">PI ${r.pi}<div style="color:#7C7565;font-size:11px">${r.buyer || ""}${r.coordinator ? " · " + r.coordinator : ""}</div></td>
      <td style="padding:7px 10px;border-bottom:1px solid #E2DACA">${r.still_due}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #E2DACA;color:${late ? "#D7362A" : "#E89611"};font-weight:600">
        ${late ? Math.abs(r.days) + " days late" : r.days === 0 ? "today" : "in " + r.days + " days"}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #E2DACA;color:#7C7565">${(late ? r.late_vendors : r.vendors).join(", ")}</td>
    </tr>`;
  const table = (title, list, late) => list.length ? `
    <h3 style="font-family:Georgia,serif;color:${late ? "#D7362A" : "#252B21"};margin:22px 0 8px">${title} (${list.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;font-family:Arial,sans-serif">
      <tr style="background:#EBE5D8;color:#7C7565;font-size:11px;text-transform:uppercase">
        <th align="left" style="padding:8px 10px">Item</th><th align="left" style="padding:8px 10px">Description</th>
        <th align="left" style="padding:8px 10px">PI</th><th align="left" style="padding:8px 10px">Still due</th>
        <th align="left" style="padding:8px 10px">When</th><th align="left" style="padding:8px 10px">Vendor</th>
      </tr>
      ${list.map((r) => row(r, late)).join("")}
    </table>` : "";

  return `<div style="background:#F5F1E8;padding:24px;font-family:Arial,sans-serif;color:#252B21">
    <div style="max-width:760px;margin:auto;background:#FFFDF8;border:1px solid #E2DACA;border-radius:14px;padding:24px">
      <h2 style="font-family:Georgia,serif;margin:0 0 4px;color:#1F4D36">Production digest${companyName ? " · " + companyName : ""}</h2>
      <p style="color:#7C7565;margin:0 0 6px;font-size:13px">${dg.date} · ${dg.totals.open_skus} open SKUs · ${dg.totals.pieces_due.toLocaleString("en-IN")} pieces still due</p>
      ${dg.overdue.length ? "" : `<p style="color:#1E8E4E;font-weight:600;margin-top:16px">Nothing is overdue today.</p>`}
      ${table("Overdue", dg.overdue, true)}
      ${table("Due in the next 7 days", dg.dueSoon, false)}
      <p style="color:#7C7565;font-size:12px;margin-top:22px">Sent automatically by your PI Production Tracker.</p>
    </div>
  </div>`;
}

function mailerReady() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function splitEmails(v) {
  return String(v || "").split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /@/.test(x));
}

// Who should hear about this company's overdue work?
//  - the company's own alert list (and ALERT_TO if set) get the full digest
//  - each coordinator gets a digest limited to the buyers they look after
function recipientsFor(companyId) {
  const company = db.prepare("SELECT * FROM companies WHERE id = ?").get(companyId) || {};
  const full = [...splitEmails(company.alert_emails), ...splitEmails(process.env.ALERT_TO)];
  const coordinators = {};
  db.prepare("SELECT id, name, coordinator_name, coordinator_email FROM buyers WHERE company_id IS ?")
    .all(companyId).forEach((b) => {
      splitEmails(b.coordinator_email).forEach((em) => {
        const key = em.toLowerCase();
        if (!coordinators[key]) coordinators[key] = { email: em, name: b.coordinator_name || "", buyerIds: [] };
        coordinators[key].buyerIds.push(b.id);
      });
    });
  return { company, full: [...new Set(full.map((e) => e.toLowerCase()))], coordinators: Object.values(coordinators) };
}

async function sendDigest(companyId, companyName) {
  const dg = buildDigest(companyId);
  const { full, coordinators } = recipientsFor(companyId);
  if (!mailerReady()) return { sent: false, reason: "email not configured on the server", digest: dg };
  if (!full.length && !coordinators.length) {
    return { sent: false, reason: "no recipients — add email addresses for this company in Settings", digest: dg };
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE || "") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const subj = (n, who) => (n ? `${n} overdue` : "Nothing overdue") +
    ` · ${companyName || "Production"}${who ? " · " + who : ""}`;

  const sentTo = [];
  if (full.length) {
    await transport.sendMail({ from, to: full.join(","), subject: subj(dg.overdue.length),
      html: digestHtml(dg, companyName) });
    sentTo.push(...full);
  }
  for (const c of coordinators) {
    const cdg = buildDigest(companyId, { buyerIds: c.buyerIds });
    if (!cdg.overdue.length && !cdg.dueSoon.length) continue;   // don't email people with nothing to chase
    await transport.sendMail({ from, to: c.email,
      subject: subj(cdg.overdue.length, c.name || "your buyers"),
      html: digestHtml(cdg, companyName + (c.name ? " · " + c.name : "")) });
    sentTo.push(c.email);
  }
  return { sent: sentTo.length > 0, recipients: sentTo, overdue: dg.overdue.length, dueSoon: dg.dueSoon.length };
}

// Scheduler: check every 15 minutes, send once per day at ALERT_HOUR (default 08:00 server time).
let lastSentDay = null;
function startScheduler() {
  const tick = async () => {
    try {
      if (!mailerReady()) return;
      const hour = Number(process.env.ALERT_HOUR || 8);
      const now = new Date();
      const today = D.todayISO();
      if (now.getHours() >= hour && lastSentDay !== today) {
        lastSentDay = today;
        const companies = db.prepare("SELECT * FROM companies WHERE archived = 0").all();
        for (const c of companies) {
          try { await sendDigest(c.id, c.name); } catch (e) { console.error("digest failed for", c.name, e.message); }
        }
        console.log("Daily digest sent for", companies.length, "company/companies");
      }
    } catch (e) { console.error("scheduler error", e.message); }
  };
  setInterval(tick, 15 * 60 * 1000);
  setTimeout(tick, 60 * 1000);
}

module.exports = { buildDigest, digestHtml, sendDigest, mailerReady, startScheduler, recipientsFor, splitEmails };
