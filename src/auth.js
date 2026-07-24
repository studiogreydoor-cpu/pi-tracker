// Password handling. The password lives in the database (hashed), so it can be changed
// from inside the app. On a fresh install it falls back to the APP_PASSWORD environment
// variable until you set one.
const crypto = require("crypto");
const D = require("./db");
const db = D.db;

let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch (e) { nodemailer = null; }

db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
)`);

const get = (k) => { const r = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(k); return r ? r.value : null; };
const set = (k, v) => db.prepare("INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

function hash(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(password), s, 64).toString("hex");
  return { salt: s, hash: h };
}

function setPassword(password) {
  const { salt, hash: h } = hash(password);
  set("pw_salt", salt);
  set("pw_hash", h);
  set("pw_changed_at", new Date().toISOString());
  return true;
}

function hasStoredPassword() { return !!(get("pw_hash") && get("pw_salt")); }

function verifyPassword(password) {
  if (hasStoredPassword()) {
    const { hash: h } = hash(password, get("pw_salt"));
    const a = Buffer.from(h, "hex");
    const b = Buffer.from(get("pw_hash"), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  // fall back to the environment variable until a password is set in the app
  const envPw = process.env.APP_PASSWORD || "changeme";
  return String(password) === envPw;
}

// Session cookie value: changes whenever the password changes, so old sessions drop out.
function sessionToken() {
  const secret = process.env.APP_SECRET || "pi-tracker-secret";
  const basis = hasStoredPassword() ? get("pw_hash") : (process.env.APP_PASSWORD || "changeme");
  return crypto.createHmac("sha256", secret).update(basis).digest("hex");
}

// ---- recovery email ----
function recoveryEmail() { return get("recovery_email") || process.env.RECOVERY_EMAIL || "bharat@greydoor.in"; }
function setRecoveryEmail(email) { set("recovery_email", String(email || "").trim()); }

function mailerReady() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// ---- reset tokens ----
function createResetToken() {
  const token = crypto.randomBytes(24).toString("hex");
  set("reset_hash", crypto.createHash("sha256").update(token).digest("hex"));
  set("reset_expires", String(Date.now() + 30 * 60 * 1000));   // 30 minutes
  return token;
}

function consumeResetToken(token) {
  const stored = get("reset_hash");
  const exp = Number(get("reset_expires") || 0);
  if (!stored || !exp || Date.now() > exp) return false;
  const given = crypto.createHash("sha256").update(String(token || "")).digest("hex");
  const a = Buffer.from(given, "hex"), b = Buffer.from(stored, "hex");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (ok) { set("reset_hash", ""); set("reset_expires", "0"); }
  return ok;
}

async function sendResetEmail(baseUrl) {
  const to = recoveryEmail();
  if (!mailerReady()) return { sent: false, reason: "email not configured on the server" };
  const token = createResetToken();
  const link = `${baseUrl.replace(/\/$/, "")}/?reset=${token}`;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE || "") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "Reset your PI Tracker password",
    html: `<div style="font-family:Arial,sans-serif;color:#252B21">
      <h2 style="font-family:Georgia,serif;color:#1F4D36;margin:0 0 8px">Password reset</h2>
      <p style="font-size:14px">Someone asked to reset the password for your PI Production Tracker.</p>
      <p style="margin:20px 0"><a href="${link}"
         style="background:#1F4D36;color:#F5F1E8;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:600">Choose a new password</a></p>
      <p style="font-size:12.5px;color:#7C7565">This link works once and expires in 30 minutes.<br>
      If you didn't request it, ignore this email — your password stays as it is.</p>
      <p style="font-size:11.5px;color:#9C9683;word-break:break-all">${link}</p>
    </div>`,
  });
  return { sent: true, to: to.replace(/^(.).*(@.*)$/, "$1•••$2") };   // don't echo the full address
}

module.exports = { setPassword, verifyPassword, hasStoredPassword, sessionToken,
  recoveryEmail, setRecoveryEmail, createResetToken, consumeResetToken, sendResetEmail, mailerReady };
