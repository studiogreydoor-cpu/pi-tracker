// Database layer: schema, helpers, and all computed production figures.
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "tracker.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  address TEXT DEFAULT '',
  contact TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  lead_time_days INTEGER DEFAULT 0,
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pi_no TEXT NOT NULL,
  po_no TEXT DEFAULT '',
  buyer_id INTEGER REFERENCES buyers(id),
  pi_date TEXT,            -- stored ISO yyyy-mm-dd
  ex_factory_date TEXT,
  ship_date TEXT,
  packed INTEGER DEFAULT 0,
  shipped INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pi_id INTEGER NOT NULL REFERENCES pis(id) ON DELETE CASCADE,
  item_no TEXT NOT NULL,
  buyer_no TEXT DEFAULT '',
  description TEXT DEFAULT '',
  qty INTEGER DEFAULT 0,
  gift_box INTEGER DEFAULT 0,
  gift_box_vendor_id INTEGER REFERENCES vendors(id),
  labels_needed INTEGER DEFAULT 0,
  labels_ordered INTEGER DEFAULT 0,
  v1_id INTEGER REFERENCES vendors(id),
  v2_id INTEGER REFERENCES vendors(id),
  v3_id INTEGER REFERENCES vendors(id),
  v4_id INTEGER REFERENCES vendors(id),
  received_qty INTEGER DEFAULT 0,
  received_date TEXT,
  r1_qty INTEGER DEFAULT 0, r1_date TEXT, r1_back_qty INTEGER DEFAULT 0, r1_back_date TEXT,
  r2_qty INTEGER DEFAULT 0, r2_date TEXT, r2_back_qty INTEGER DEFAULT 0, r2_back_date TEXT,
  r3_qty INTEGER DEFAULT 0, r3_date TEXT, r3_back_qty INTEGER DEFAULT 0, r3_back_date TEXT,
  complete INTEGER DEFAULT 0,
  packed INTEGER DEFAULT 0,
  shipped INTEGER DEFAULT 0,
  notes TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_skus_pi ON skus(pi_id);
CREATE INDEX IF NOT EXISTS idx_skus_item ON skus(item_no);
`);

// ---------- date helpers (stored ISO, displayed DD/MM/YY) ----------
function addDays(iso, days) {
  if (!iso || !days) return null;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function daysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  return Math.round((new Date(toISO + "T00:00:00") - new Date(fromISO + "T00:00:00")) / 86400000);
}

// Parses anything the ERP might emit into ISO. Day-first by default.
function parseDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const parsed = new Date(s);
  return isNaN(parsed) ? null : parsed.toISOString().slice(0, 10);
}

// ---------- computed production figures ----------
function decorateSku(sku, vendorsById, pi) {
  const inHand =
    (sku.received_qty || 0) + (sku.r1_back_qty || 0) + (sku.r2_back_qty || 0) + (sku.r3_back_qty || 0) -
    ((sku.r1_qty || 0) + (sku.r2_qty || 0) + (sku.r3_qty || 0));
  const stillDue = (sku.qty || 0) - inHand;
  const outForRepair = (sku.r1_qty || 0) + (sku.r2_qty || 0) + (sku.r3_qty || 0) -
    ((sku.r1_back_qty || 0) + (sku.r2_back_qty || 0) + (sku.r3_back_qty || 0));

  const piDate = pi ? pi.pi_date : null;
  const vendorDue = [];
  [sku.v1_id, sku.v2_id, sku.v3_id, sku.v4_id].forEach((vid, i) => {
    const v = vid ? vendorsById[vid] : null;
    vendorDue.push(v && v.lead_time_days ? { slot: i + 1, vendorId: vid, vendor: v.name, due: addDays(piDate, v.lead_time_days) } : null);
  });
  const dues = vendorDue.filter(Boolean).map((x) => x.due).filter(Boolean).sort();
  const overallDue = dues.length ? dues[dues.length - 1] : null;
  const nextDue = dues.length ? dues[0] : null;

  let status = null, daysLeft = null;
  if (overallDue && !sku.complete) {
    daysLeft = daysBetween(todayISO(), overallDue);
    status = daysLeft < 0 ? "overdue" : daysLeft <= 5 ? "red" : daysLeft <= 15 ? "amber" : "green";
  } else if (sku.complete) {
    status = "done";
  }
  const pct = sku.qty > 0 ? Math.max(0, Math.min(100, Math.round((inHand / sku.qty) * 100))) : 0;

  return { ...sku, in_hand: inHand, still_due: stillDue, out_for_repair: outForRepair,
    vendor_due: vendorDue, overall_due: overallDue, next_due: nextDue,
    status, days_left: daysLeft, progress_pct: pct,
    late: status === "overdue" ? 1 : 0 };
}

function vendorsById() {
  const map = {};
  db.prepare("SELECT * FROM vendors").all().forEach((v) => (map[v.id] = v));
  return map;
}

function getSkusForPI(piId) {
  const pi = db.prepare("SELECT * FROM pis WHERE id = ?").get(piId);
  const vmap = vendorsById();
  return db.prepare("SELECT * FROM skus WHERE pi_id = ? ORDER BY item_no").all(piId)
    .map((s) => decorateSku(s, vmap, pi));
}

function getAllSkusDecorated() {
  const vmap = vendorsById();
  const pis = {};
  db.prepare("SELECT * FROM pis").all().forEach((p) => (pis[p.id] = p));
  return db.prepare("SELECT * FROM skus").all().map((s) => decorateSku(s, vmap, pis[s.pi_id]));
}

function getPIs({ includeShipped = false } = {}) {
  const rows = db.prepare(`
    SELECT p.*, b.name AS buyer_name
    FROM pis p LEFT JOIN buyers b ON b.id = p.buyer_id
    ${includeShipped ? "" : "WHERE p.shipped = 0"}
    ORDER BY COALESCE(p.pi_date, p.created_at) DESC, p.id DESC
  `).all();
  const all = getAllSkusDecorated();
  return rows.map((p) => {
    const mine = all.filter((s) => s.pi_id === p.id);
    const ordered = mine.reduce((t, s) => t + (s.qty || 0), 0);
    const inHand = mine.reduce((t, s) => t + s.in_hand, 0);
    const lateCount = mine.filter((s) => s.late).length;
    const dues = mine.map((s) => s.overall_due).filter(Boolean).sort();
    return { ...p, sku_count: mine.length, ordered_qty: ordered, in_hand_qty: inHand,
      still_due_qty: Math.max(0, ordered - inHand),
      progress_pct: ordered > 0 ? Math.max(0, Math.min(100, Math.round((inHand / ordered) * 100))) : 0,
      late_count: lateCount, first_due: dues[0] || null,
      complete_count: mine.filter((s) => s.complete).length };
  });
}

// Carry-over: reuse the previous setup for a repeat item number.
function priorSettings(itemNo) {
  return db.prepare(`
    SELECT gift_box, gift_box_vendor_id, labels_needed, v1_id, v2_id, v3_id, v4_id
    FROM skus WHERE item_no = ? ORDER BY id DESC LIMIT 1
  `).get(itemNo);
}

function findOrCreateBuyer(name, address) {
  if (!name || !name.trim()) return null;
  const clean = name.trim();
  const found = db.prepare("SELECT * FROM buyers WHERE lower(name) = lower(?)").get(clean);
  if (found) return found.id;
  return db.prepare("INSERT INTO buyers (name, address) VALUES (?, ?)").run(clean, address || "").lastInsertRowid;
}

function findOrCreateVendor(name) {
  if (!name || !String(name).trim()) return null;
  const clean = String(name).trim();
  const found = db.prepare("SELECT * FROM vendors WHERE lower(name) = lower(?)").get(clean);
  if (found) return found.id;
  return db.prepare("INSERT INTO vendors (name) VALUES (?)").run(clean).lastInsertRowid;
}

module.exports = { db, addDays, todayISO, daysBetween, parseDate, decorateSku, vendorsById,
  getSkusForPI, getAllSkusDecorated, getPIs, priorSettings, findOrCreateBuyer, findOrCreateVendor };
