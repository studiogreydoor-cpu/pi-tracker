// Database layer: schema, helpers, and all computed production figures.
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "tracker.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  alert_emails TEXT DEFAULT '',
  short_name TEXT DEFAULT '',
  accent TEXT DEFAULT '',
  archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS coordinators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS coordinators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  always_notify INTEGER DEFAULT 0,
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  coordinator_id INTEGER,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  contact TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  name TEXT NOT NULL,
  lead_time_days INTEGER DEFAULT 0,
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
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

CREATE TABLE IF NOT EXISTS sku_vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id INTEGER NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  vendor_id INTEGER REFERENCES vendors(id),
  role TEXT DEFAULT 'part',            -- part | giftbox | labels
  received_qty INTEGER DEFAULT 0,
  received_date TEXT,
  r1_qty INTEGER DEFAULT 0, r1_date TEXT, r1_back_qty INTEGER DEFAULT 0, r1_back_date TEXT,
  r2_qty INTEGER DEFAULT 0, r2_date TEXT, r2_back_qty INTEGER DEFAULT 0, r2_back_date TEXT,
  r3_qty INTEGER DEFAULT 0, r3_date TEXT, r3_back_qty INTEGER DEFAULT 0, r3_back_date TEXT,
  notes TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sv_sku ON sku_vendors(sku_id);
CREATE INDEX IF NOT EXISTS idx_skus_pi ON skus(pi_id);
CREATE INDEX IF NOT EXISTS idx_skus_item ON skus(item_no);
`);

// --- migrations for databases created before multi-company support ---
function hasCol(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
if (!hasCol("buyers", "coordinator_id")) {
  try { db.exec("ALTER TABLE buyers ADD COLUMN coordinator_id INTEGER"); } catch (e) {}
}
[["buyers","coordinator_name"],["buyers","coordinator_email"],["buyers","coordinator_phone"],
 ["companies","alert_emails"]].forEach(([t, c]) => {
  if (!hasCol(t, c)) { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT DEFAULT ''`); } catch (e) {} }
});
if (!hasCol("buyers", "coordinator_id")) {
  try { db.exec("ALTER TABLE buyers ADD COLUMN coordinator_id INTEGER"); } catch (e) {}
}
["pis", "vendors", "buyers", "coordinators"].forEach((t) => {
  if (!hasCol(t, "company_id")) {
    try { db.exec(`ALTER TABLE ${t} ADD COLUMN company_id INTEGER`); } catch (e) {}
  }
});
// Ensure at least one company exists, and attach any orphan rows to it.
let firstCompany = db.prepare("SELECT * FROM companies ORDER BY id LIMIT 1").get();
if (!firstCompany) {
  const id = db.prepare("INSERT INTO companies (name, short_name) VALUES (?,?)").run("My Company", "MC").lastInsertRowid;
  firstCompany = db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
}
["pis", "vendors", "buyers", "coordinators"].forEach((t) => {
  db.prepare(`UPDATE ${t} SET company_id = ? WHERE company_id IS NULL`).run(firstCompany.id);
});

// Move any legacy per-SKU vendor slots into sku_vendors, preserving received/return figures.
try {
  const legacy = db.prepare(`SELECT * FROM skus WHERE (v1_id IS NOT NULL OR v2_id IS NOT NULL OR v3_id IS NOT NULL OR v4_id IS NOT NULL)
    AND id NOT IN (SELECT DISTINCT sku_id FROM sku_vendors)`).all();
  const ins = db.prepare(`INSERT INTO sku_vendors (sku_id,vendor_id,role,received_qty,received_date,
    r1_qty,r1_date,r1_back_qty,r1_back_date,r2_qty,r2_date,r2_back_qty,r2_back_date,r3_qty,r3_date,r3_back_qty,r3_back_date)
    VALUES (?,?,'part',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  legacy.forEach((s) => {
    const slots = [s.v1_id, s.v2_id, s.v3_id, s.v4_id].filter(Boolean);
    slots.forEach((vid, i) => {
      // put the SKU-level receipts on the first vendor only, so totals stay correct
      const first = i === 0;
      ins.run(s.id, vid, first ? s.received_qty || 0 : 0, first ? s.received_date : null,
        first ? s.r1_qty || 0 : 0, first ? s.r1_date : null, first ? s.r1_back_qty || 0 : 0, first ? s.r1_back_date : null,
        first ? s.r2_qty || 0 : 0, first ? s.r2_date : null, first ? s.r2_back_qty || 0 : 0, first ? s.r2_back_date : null,
        first ? s.r3_qty || 0 : 0, first ? s.r3_date : null, first ? s.r3_back_qty || 0 : 0, first ? s.r3_back_date : null);
    });
  });
} catch (e) {}

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
function assignmentsFor(skuId) {
  return db.prepare("SELECT * FROM sku_vendors WHERE sku_id = ? ORDER BY id").all(skuId);
}

function decorateSku(sku, vendorsMap, pi, assigns) {
  const rows = assigns || assignmentsFor(sku.id);
  const piDate = pi ? pi.pi_date : null;

  const vendors = rows.map((a) => {
    const v = a.vendor_id ? vendorsMap[a.vendor_id] : null;
    const inHand =
      (a.received_qty || 0) + (a.r1_back_qty || 0) + (a.r2_back_qty || 0) + (a.r3_back_qty || 0) -
      ((a.r1_qty || 0) + (a.r2_qty || 0) + (a.r3_qty || 0));
    const due = v && v.lead_time_days ? addDays(piDate, v.lead_time_days) : null;
    let status = null, daysLeft = null;
    if (due && !sku.complete) {
      daysLeft = daysBetween(todayISO(), due);
      status = daysLeft < 0 ? "overdue" : daysLeft <= 5 ? "red" : daysLeft <= 15 ? "amber" : "green";
    } else if (sku.complete) status = "done";
    return {
      id: a.id, vendor_id: a.vendor_id, vendor: v ? v.name : "", role: a.role || "part",
      lead_time: v ? v.lead_time_days : null, due, status, days_left: daysLeft,
      received_qty: a.received_qty || 0, received_date: a.received_date,
      r1_qty: a.r1_qty || 0, r1_date: a.r1_date, r1_back_qty: a.r1_back_qty || 0, r1_back_date: a.r1_back_date,
      r2_qty: a.r2_qty || 0, r2_date: a.r2_date, r2_back_qty: a.r2_back_qty || 0, r2_back_date: a.r2_back_date,
      r3_qty: a.r3_qty || 0, r3_date: a.r3_date, r3_back_qty: a.r3_back_qty || 0, r3_back_date: a.r3_back_date,
      in_hand: inHand,
      returned: (a.r1_qty || 0) + (a.r2_qty || 0) + (a.r3_qty || 0),
      returned_back: (a.r1_back_qty || 0) + (a.r2_back_qty || 0) + (a.r3_back_qty || 0),
      late: due && !sku.complete && daysLeft < 0 ? 1 : 0,
    };
  });

  const parts = vendors.filter((v) => v.role === "part");
  // Received for the SKU = the largest single vendor's good stock (each vendor supplies the whole SKU's
  // component set). If there are no vendor rows, fall back to the SKU-level figures.
  const legacyInHand =
    (sku.received_qty || 0) + (sku.r1_back_qty || 0) + (sku.r2_back_qty || 0) + (sku.r3_back_qty || 0) -
    ((sku.r1_qty || 0) + (sku.r2_qty || 0) + (sku.r3_qty || 0));
  const inHand = parts.length ? Math.min(...parts.map((v) => v.in_hand)) : legacyInHand;
  const stillDue = (sku.qty || 0) - inHand;

  const dues = vendors.map((v) => v.due).filter(Boolean).sort();
  const overallDue = dues.length ? dues[dues.length - 1] : null;
  const nextDue = dues.length ? dues[0] : null;

  let status = null, daysLeft = null;
  if (sku.complete) status = "done";
  else if (overallDue) {
    daysLeft = daysBetween(todayISO(), overallDue);
    status = daysLeft < 0 ? "overdue" : daysLeft <= 5 ? "red" : daysLeft <= 15 ? "amber" : "green";
  }
  const pct = sku.qty > 0 ? Math.max(0, Math.min(100, Math.round((inHand / sku.qty) * 100))) : 0;

  return {
    ...sku, vendors,
    gift_box_vendor: (vendors.find((v) => v.role === "giftbox") || {}).vendor_id || null,
    in_hand: inHand, still_due: stillDue,
    total_received: parts.reduce((t, v) => t + v.received_qty, 0),
    total_returned: parts.reduce((t, v) => t + v.returned, 0),
    overall_due: overallDue, next_due: nextDue,
    status, days_left: daysLeft, progress_pct: pct,
    late: status === "overdue" ? 1 : 0,
    late_vendors: vendors.filter((v) => v.late).map((v) => v.vendor).filter(Boolean),
  };
}

function vendorsById(companyId) {
  const map = {};
  const rows = companyId
    ? db.prepare("SELECT * FROM vendors WHERE company_id = ?").all(companyId)
    : db.prepare("SELECT * FROM vendors").all();
  rows.forEach((v) => (map[v.id] = v));
  return map;
}

function getSkusForPI(piId) {
  const pi = db.prepare("SELECT * FROM pis WHERE id = ?").get(piId);
  const vmap = vendorsById();
  const amap = allAssignments();
  return db.prepare("SELECT * FROM skus WHERE pi_id = ? ORDER BY item_no").all(piId)
    .map((s) => decorateSku(s, vmap, pi, amap[s.id] || []));
}

function allAssignments() {
  const map = {};
  db.prepare("SELECT * FROM sku_vendors ORDER BY id").all().forEach((a) => {
    (map[a.sku_id] = map[a.sku_id] || []).push(a);
  });
  return map;
}

function getAllSkusDecorated(companyId) {
  const vmap = vendorsById();
  const amap = allAssignments();
  const pis = {};
  const piRows = companyId
    ? db.prepare("SELECT * FROM pis WHERE company_id = ?").all(companyId)
    : db.prepare("SELECT * FROM pis").all();
  piRows.forEach((p) => (pis[p.id] = p));
  const skus = companyId
    ? db.prepare("SELECT s.* FROM skus s JOIN pis p ON p.id = s.pi_id WHERE p.company_id = ?").all(companyId)
    : db.prepare("SELECT * FROM skus").all();
  return skus.map((s) => decorateSku(s, vmap, pis[s.pi_id], amap[s.id] || []));
}

function getPIs({ includeShipped = false, companyId = null } = {}) {
  const where = [];
  if (!includeShipped) where.push("p.shipped = 0");
  if (companyId) where.push("p.company_id = " + Number(companyId));
  const rows = db.prepare(`
    SELECT p.*, b.name AS buyer_name
    FROM pis p LEFT JOIN buyers b ON b.id = p.buyer_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(p.pi_date, p.created_at) DESC, p.id DESC
  `).all();
  const all = getAllSkusDecorated(companyId);
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
function priorSettings(itemNo, companyId) {
  if (companyId) {
    return db.prepare(`
      SELECT s.id AS prev_sku_id, s.gift_box, s.gift_box_vendor_id, s.labels_needed, s.v1_id, s.v2_id, s.v3_id, s.v4_id
      FROM skus s JOIN pis p ON p.id = s.pi_id
      WHERE s.item_no = ? AND p.company_id = ? ORDER BY s.id DESC LIMIT 1
    `).get(itemNo, companyId);
  }
  return db.prepare(`
    SELECT id AS prev_sku_id, gift_box, gift_box_vendor_id, labels_needed, v1_id, v2_id, v3_id, v4_id
    FROM skus WHERE item_no = ? ORDER BY id DESC LIMIT 1
  `).get(itemNo);
}

function findOrCreateBuyer(name, address, companyId) {
  if (!name || !name.trim()) return null;
  const clean = name.trim();
  const found = db.prepare("SELECT * FROM buyers WHERE lower(name) = lower(?) AND company_id IS ?").get(clean, companyId || null);
  if (found) return found.id;
  return db.prepare("INSERT INTO buyers (name, address, company_id) VALUES (?,?,?)").run(clean, address || "", companyId || null).lastInsertRowid;
}

function findOrCreateVendor(name, companyId) {
  if (!name || !String(name).trim()) return null;
  const clean = String(name).trim();
  const found = db.prepare("SELECT * FROM vendors WHERE lower(name) = lower(?) AND company_id IS ?").get(clean, companyId || null);
  if (found) return found.id;
  return db.prepare("INSERT INTO vendors (name, company_id) VALUES (?,?)").run(clean, companyId || null).lastInsertRowid;
}

module.exports = { db, addDays, assignmentsFor, allAssignments, todayISO, daysBetween, parseDate, decorateSku, vendorsById,
  getSkusForPI, getAllSkusDecorated, getPIs, priorSettings, findOrCreateBuyer, findOrCreateVendor };
