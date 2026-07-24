// Failsafe: a snapshot of everything is written to disk every day, and emailed to you
// once a week so you always hold an off-site copy.
const fs = require("fs");
const path = require("path");
const D = require("./db");
const db = D.db;

let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch (e) { nodemailer = null; }

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP_DAYS = Number(process.env.BACKUP_KEEP || 30);

function dump() {
  const out = {};
  ["companies", "coordinators", "buyers", "vendors", "pis", "skus", "sku_vendors"].forEach((t) => {
    try { out[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch (e) { out[t] = []; }
  });
  out._meta = {
    app: "pi-production-tracker", version: 1, taken_at: new Date().toISOString(),
    counts: Object.fromEntries(Object.keys(out).filter((k) => k !== "_meta").map((k) => [k, out[k].length])),
  };
  return out;
}

function writeSnapshot() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `backup-${D.todayISO()}.json`;
  const file = path.join(BACKUP_DIR, name);
  const data = dump();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  prune();
  return { file, name, counts: data._meta.counts };
}

function prune() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > KEEP_DAYS) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) {}
    }
  } catch (e) {}
}

function listSnapshots() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^backup-.*\.json$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, taken: st.mtime.toISOString().slice(0, 10) };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch (e) { return []; }
}

function snapshotPath(name) {
  if (!/^backup-[\w.-]+\.json$/.test(name)) return null;   // no path traversal
  const p = path.join(BACKUP_DIR, name);
  return fs.existsSync(p) ? p : null;
}

function mailerReady() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ALERT_TO);
}

async function emailBackup(reason) {
  const snap = writeSnapshot();
  if (!mailerReady()) return { sent: false, reason: "email not configured", snapshot: snap.name };
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE || "") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const c = snap.counts || {};
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.BACKUP_TO || process.env.ALERT_TO,
    subject: `PI Tracker backup · ${D.todayISO()}`,
    html: `<div style="font-family:Arial,sans-serif;color:#252B21">
      <h2 style="font-family:Georgia,serif;color:#1F4D36;margin:0 0 6px">Weekly data backup</h2>
      <p style="color:#7C7565;font-size:13px;margin:0 0 14px">${reason || "Scheduled backup"} · ${D.todayISO()}</p>
      <p style="font-size:13px">Attached is a complete copy of your tracker data:</p>
      <ul style="font-size:13px;color:#3A342A">
        <li>${c.pis || 0} orders and ${c.skus || 0} SKUs</li>
        <li>${c.sku_vendors || 0} vendor assignments (with received and return figures)</li>
        <li>${c.buyers || 0} buyers, ${c.vendors || 0} vendors, ${c.coordinators || 0} coordinators</li>
      </ul>
      <p style="font-size:12px;color:#7C7565">Save this file somewhere safe. To restore it, open the app → Settings → Restore from backup.</p>
    </div>`,
    attachments: [{ filename: snap.name, path: snap.file }],
  });
  return { sent: true, snapshot: snap.name, counts: c };
}

// Daily snapshot; weekly email (default Sunday).
let lastSnapDay = null;
let lastMailWeek = null;
function startBackupScheduler() {
  const tick = async () => {
    try {
      const today = D.todayISO();
      if (lastSnapDay !== today) {
        lastSnapDay = today;
        const snap = writeSnapshot();
        console.log("Daily snapshot written:", snap.name);
      }
      const day = new Date().getDay();                       // 0 = Sunday
      const wantDay = Number(process.env.BACKUP_EMAIL_DAY ?? 0);
      const weekKey = today.slice(0, 4) + "-w" + Math.floor(new Date(today).getTime() / (7 * 864e5));
      if (day === wantDay && lastMailWeek !== weekKey && mailerReady()) {
        lastMailWeek = weekKey;
        await emailBackup("Weekly backup");
        console.log("Weekly backup emailed");
      }
    } catch (e) { console.error("backup scheduler:", e.message); }
  };
  setInterval(tick, 60 * 60 * 1000);   // hourly check
  setTimeout(tick, 90 * 1000);         // and shortly after boot
}

module.exports = { dump, writeSnapshot, listSnapshots, snapshotPath, emailBackup, startBackupScheduler, BACKUP_DIR };
