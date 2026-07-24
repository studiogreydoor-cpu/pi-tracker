// PI Production Tracker - standalone server
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const XLSX = require("xlsx");
const { parseInvoiceXlsx } = require("./invoiceParser");
const { parseInvoicePdf } = require("./pdfParser");
const alerts = require("./alerts");
const D = require("./db");
const db = D.db;

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || "changeme";
const SECRET = process.env.APP_SECRET || "pi-tracker-secret";
const token = () => crypto.createHmac("sha256", SECRET).update(PASSWORD).digest("hex");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---------- auth ----------
app.post("/api/login", (req, res) => {
  if ((req.body.password || "") !== PASSWORD) return res.status(401).json({ error: "Wrong password" });
  res.cookie("auth", token(), { httpOnly: true, sameSite: "lax", maxAge: 30 * 864e5 });
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => { res.clearCookie("auth"); res.json({ ok: true }); });

function requireAuth(req, res, next) {
  if (req.cookies.auth === token()) return next();
  res.status(401).json({ error: "Not logged in" });
}
const api = express.Router();
api.use(requireAuth);

// Active company: from the `company` cookie, falling back to the first one.
api.use((req, res, next) => {
  const list = db.prepare("SELECT * FROM companies WHERE archived = 0 ORDER BY id").all();
  const wanted = Number(req.cookies.company);
  req.company = list.find((c) => c.id === wanted) || list[0] || null;
  req.companyId = req.company ? req.company.id : null;
  next();
});
app.use("/api", api);

// ---------- companies (profiles) ----------
api.get("/companies", (req, res) => {
  res.json({ companies: db.prepare("SELECT * FROM companies WHERE archived = 0 ORDER BY id").all(), active: req.companyId });
});
api.post("/companies", (req, res) => {
  const { name, short_name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Company name required" });
  try {
    const r = db.prepare("INSERT INTO companies (name, short_name) VALUES (?,?)").run(name.trim(), (short_name || name.trim().slice(0, 2)).toUpperCase());
    res.json(db.prepare("SELECT * FROM companies WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) { res.status(400).json({ error: "A company with that name already exists" }); }
});
api.patch("/companies/:id", (req, res) => {
  const sets = [], vals = [];
  ["name", "short_name", "archived", "alert_emails"].forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  res.json({ ok: true });
});
api.post("/companies/:id/activate", (req, res) => {
  const c = db.prepare("SELECT * FROM companies WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Company not found" });
  res.cookie("company", String(c.id), { httpOnly: true, sameSite: "lax", maxAge: 365 * 864e5 });
  res.json({ ok: true, active: c.id });
});

// ---------- masters ----------
api.get("/vendors", (req, res) => res.json(db.prepare("SELECT * FROM vendors WHERE company_id IS ? ORDER BY name").all(req.companyId)));
api.post("/vendors", (req, res) => {
  const { name, lead_time_days, phone, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });
  try {
    const r = db.prepare("INSERT INTO vendors (name, lead_time_days, phone, notes, company_id) VALUES (?,?,?,?,?)")
      .run(name.trim(), Number(lead_time_days) || 0, phone || "", notes || "", req.companyId);
    res.json(db.prepare("SELECT * FROM vendors WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) { res.status(400).json({ error: "A vendor with that name already exists" }); }
});
api.patch("/vendors/:id", (req, res) => {
  const allowed = ["name", "lead_time_days", "phone", "notes"];
  const sets = [], vals = [];
  allowed.forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k]); } });
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE vendors SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  res.json(db.prepare("SELECT * FROM vendors WHERE id = ?").get(req.params.id));
});
api.delete("/vendors/:id", (req, res) => {
  db.prepare("DELETE FROM vendors WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

api.get("/buyers", (req, res) => res.json(db.prepare(`SELECT b.*, c.name AS coordinator_name, c.email AS coordinator_email
  FROM buyers b LEFT JOIN coordinators c ON c.id = b.coordinator_id
  WHERE b.company_id IS ? ORDER BY b.name`).all(req.companyId)));
api.post("/buyers", (req, res) => {
  const { name, address, contact, email, phone, notes, coordinator_name, coordinator_email, coordinator_phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });
  try {
    const r = db.prepare(`INSERT INTO buyers (name,address,contact,email,phone,notes,company_id,
      coordinator_name,coordinator_email,coordinator_phone) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(name.trim(), address || "", contact || "", email || "", phone || "", notes || "", req.companyId,
        coordinator_name || "", coordinator_email || "", coordinator_phone || "");
    res.json(db.prepare("SELECT * FROM buyers WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) { res.status(400).json({ error: "A buyer with that name already exists" }); }
});
api.patch("/buyers/:id", (req, res) => {
  const allowed = ["name", "address", "contact", "email", "phone", "notes", "coordinator_id"];
  const sets = [], vals = [];
  allowed.forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k]); } });
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE buyers SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  res.json(db.prepare("SELECT * FROM buyers WHERE id = ?").get(req.params.id));
});

// ---------- PIs & SKUs ----------
api.get("/pis", (req, res) => {
  const scope = req.query.scope || "open";   // open | closed | all
  const rows = D.getPIs({ includeShipped: true, companyId: req.companyId });
  if (scope === "all") return res.json(rows);
  if (scope === "closed") return res.json(rows.filter((p) => p.shipped));
  return res.json(rows.filter((p) => !p.shipped));
});
api.post("/pis/:id/close", (req, res) => {
  db.prepare("UPDATE pis SET shipped = 1 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
api.post("/pis/:id/reopen", (req, res) => {
  db.prepare("UPDATE pis SET shipped = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
api.get("/pis/:id/skus", (req, res) => res.json(D.getSkusForPI(req.params.id)));
api.patch("/pis/:id", (req, res) => {
  const allowed = ["pi_no", "po_no", "buyer_id", "pi_date", "ex_factory_date", "ship_date", "packed", "shipped", "notes", "company_id"];
  const sets = [], vals = [];
  allowed.forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE pis SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  // Ticking the PI cascades to its SKUs, so whole-order actions are one click.
  if (req.body.shipped === 1) db.prepare("UPDATE skus SET shipped = 1, packed = 1 WHERE pi_id = ?").run(req.params.id);
  if (req.body.packed === 1) db.prepare("UPDATE skus SET packed = 1 WHERE pi_id = ?").run(req.params.id);
  res.json({ ok: true });
});
api.post("/pis/:id/complete-all", (req, res) => {
  const ids = db.prepare("SELECT id FROM skus WHERE pi_id = ?").all(req.params.id).map((r) => r.id);
  db.prepare("UPDATE skus SET complete = 1 WHERE pi_id = ?").run(req.params.id);
  ids.forEach(fillReceived);
  res.json({ ok: true, count: ids.length });
});
api.post("/pis/:id/uncomplete-all", (req, res) => {
  db.prepare("UPDATE skus SET complete = 0 WHERE pi_id = ?").run(req.params.id);
  res.json({ ok: true });
});

api.delete("/pis/:id", (req, res) => {
  db.prepare("DELETE FROM skus WHERE pi_id = ?").run(req.params.id);
  db.prepare("DELETE FROM pis WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

const SKU_FIELDS = ["item_no","buyer_no","description","qty","gift_box","gift_box_vendor_id","labels_needed","labels_ordered",
  "v1_id","v2_id","v3_id","v4_id","received_qty","received_date",
  "r1_qty","r1_date","r1_back_qty","r1_back_date","r2_qty","r2_date","r2_back_qty","r2_back_date",
  "r3_qty","r3_date","r3_back_qty","r3_back_date","complete","packed","shipped","notes"];

// Fill a SKU's receipts so that its in-hand equals the ordered quantity.
function fillReceived(skuId) {
  const sku = db.prepare("SELECT * FROM skus WHERE id = ?").get(skuId);
  if (!sku) return;
  const qty = sku.qty || 0;
  const assigns = db.prepare("SELECT * FROM sku_vendors WHERE sku_id = ? AND role = 'part'").all(skuId);
  if (assigns.length) {
    const upd = db.prepare("UPDATE sku_vendors SET received_qty = ?, received_date = COALESCE(received_date, ?) WHERE id = ?");
    assigns.forEach((a) => {
      const out = (a.r1_qty || 0) + (a.r2_qty || 0) + (a.r3_qty || 0);
      const back = (a.r1_back_qty || 0) + (a.r2_back_qty || 0) + (a.r3_back_qty || 0);
      upd.run(Math.max(0, qty - back + out), D.todayISO(), a.id);
    });
  } else {
    const out = (sku.r1_qty || 0) + (sku.r2_qty || 0) + (sku.r3_qty || 0);
    const back = (sku.r1_back_qty || 0) + (sku.r2_back_qty || 0) + (sku.r3_back_qty || 0);
    db.prepare("UPDATE skus SET received_qty = ?, received_date = COALESCE(received_date, ?) WHERE id = ?")
      .run(Math.max(0, qty - back + out), D.todayISO(), skuId);
  }
}

api.patch("/skus/:id", (req, res) => {
  const sets = [], vals = [];
  SKU_FIELDS.forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k] === "" ? null : req.body[k]); } });
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE skus SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  if (Number(req.body.complete) === 1) fillReceived(req.params.id);
  const sku = db.prepare("SELECT * FROM skus WHERE id = ?").get(req.params.id);
  const pi = db.prepare("SELECT * FROM pis WHERE id = ?").get(sku.pi_id);
  res.json(D.decorateSku(sku, D.vendorsById(), pi));
});

// ---------- per-SKU vendor assignments ----------
api.post("/skus/:id/vendors", (req, res) => {
  const { vendor_id, role } = req.body;
  const r = db.prepare("INSERT INTO sku_vendors (sku_id, vendor_id, role) VALUES (?,?,?)")
    .run(req.params.id, vendor_id || null, role || "part");
  res.json({ id: r.lastInsertRowid });
});
const ASSIGN_FIELDS = ["vendor_id","role","received_qty","received_date",
  "r1_qty","r1_date","r1_back_qty","r1_back_date","r2_qty","r2_date","r2_back_qty","r2_back_date",
  "r3_qty","r3_date","r3_back_qty","r3_back_date","notes"];
api.patch("/assignments/:id", (req, res) => {
  const sets = [], vals = [];
  ASSIGN_FIELDS.forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k] === "" ? null : req.body[k]); } });
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE sku_vendors SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  res.json({ ok: true });
});
api.delete("/assignments/:id", (req, res) => {
  db.prepare("DELETE FROM sku_vendors WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

api.delete("/skus/:id", (req, res) => {
  db.prepare("DELETE FROM sku_vendors WHERE sku_id = ?").run(req.params.id);
  db.prepare("DELETE FROM skus WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
api.post("/pis/:id/skus", (req, res) => {
  const { item_no, buyer_no, description, qty } = req.body;
  if (!item_no || !String(item_no).trim()) return res.status(400).json({ error: "Item number required" });
  const r = db.prepare("INSERT INTO skus (pi_id,item_no,buyer_no,description,qty) VALUES (?,?,?,?,?)")
    .run(req.params.id, String(item_no).trim(), buyer_no || "", description || "", parseInt(qty, 10) || 0);
  res.json({ id: r.lastInsertRowid });
});

// ---------- backup ----------
api.get("/export/backup.json", (req, res) => {
  const dump = {};
  ["companies","buyers","vendors","pis","skus","sku_vendors"].forEach((t) => {
    dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  });
  dump._meta = { app: "pi-production-tracker", version: 1, taken_at: new Date().toISOString() };
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="pi-tracker-backup-${D.todayISO()}.json"`);
  res.send(JSON.stringify(dump, null, 2));
});

api.post("/import/backup", (req, res) => {
  const dump = req.body && req.body.dump;
  if (!dump || !dump._meta || dump._meta.app !== "pi-production-tracker") {
    return res.status(400).json({ error: "That doesn't look like a PI Tracker backup file" });
  }
  const tables = ["sku_vendors","skus","pis","vendors","buyers","companies"];
  try {
    db.transaction(() => {
      tables.forEach((t) => db.prepare(`DELETE FROM ${t}`).run());
      ["companies","buyers","vendors","pis","skus","sku_vendors"].forEach((t) => {
        (dump[t] || []).forEach((row) => {
          const cols = Object.keys(row);
          const ph = cols.map(() => "?").join(",");
          db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${ph})`).run(...cols.map((c) => row[c]));
        });
      });
    })();
    res.json({ ok: true, restored: Object.fromEntries(["companies","buyers","vendors","pis","skus","sku_vendors"].map((t) => [t, (dump[t] || []).length])) });
  } catch (e) { res.status(500).json({ error: "Restore failed: " + e.message }); }
});

// ---------- coordinators ----------
api.get("/coordinators", (req, res) =>
  res.json(db.prepare("SELECT * FROM coordinators WHERE company_id IS ? AND archived = 0 ORDER BY name").all(req.companyId)));
api.post("/coordinators", (req, res) => {
  const { name, email, phone, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });
  const r = db.prepare("INSERT INTO coordinators (company_id,name,email,phone,notes) VALUES (?,?,?,?,?)")
    .run(req.companyId, name.trim(), email || "", phone || "", notes || "");
  res.json(db.prepare("SELECT * FROM coordinators WHERE id = ?").get(r.lastInsertRowid));
});
api.patch("/coordinators/:id", (req, res) => {
  const sets = [], vals = [];
  ["name","email","phone","notes","archived"].forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE coordinators SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  res.json({ ok: true });
});
api.delete("/coordinators/:id", (req, res) => {
  db.prepare("UPDATE buyers SET coordinator_id = NULL WHERE coordinator_id = ?").run(req.params.id);
  db.prepare("DELETE FROM coordinators WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// extra people who receive the daily digest
api.get("/alert-recipients", (req, res) => {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("alert_recipients_" + req.companyId);
  res.json({ recipients: row && row.value ? JSON.parse(row.value) : [] });
});
api.post("/alert-recipients", (req, res) => {
  const list = Array.isArray(req.body.recipients) ? req.body.recipients.filter((e) => /\S+@\S+\.\S+/.test(e)) : [];
  db.prepare("INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("alert_recipients_" + req.companyId, JSON.stringify(list));
  res.json({ ok: true, recipients: list });
});

// ---------- coordinators (office owners for each buyer) ----------
api.get("/coordinators", (req, res) =>
  res.json(db.prepare("SELECT * FROM coordinators WHERE company_id IS ? ORDER BY name").all(req.companyId)));
api.post("/coordinators", (req, res) => {
  const { name, email, phone, always_notify } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });
  const r = db.prepare("INSERT INTO coordinators (name,email,phone,always_notify,company_id) VALUES (?,?,?,?,?)")
    .run(name.trim(), email || "", phone || "", always_notify ? 1 : 0, req.companyId);
  res.json(db.prepare("SELECT * FROM coordinators WHERE id = ?").get(r.lastInsertRowid));
});
api.patch("/coordinators/:id", (req, res) => {
  const sets = [], vals = [];
  ["name","email","phone","always_notify","notes"].forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE coordinators SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  res.json({ ok: true });
});
api.delete("/coordinators/:id", (req, res) => {
  db.prepare("UPDATE buyers SET coordinator_id = NULL WHERE coordinator_id = ?").run(req.params.id);
  db.prepare("DELETE FROM coordinators WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- daily digest ----------
api.get("/digest", (req, res) => {
  const c = db.prepare("SELECT * FROM companies WHERE id = ?").get(req.companyId) || {};
  const r = alerts.recipientsFor(req.companyId);
  res.json({ ...alerts.buildDigest(req.companyId), company: c.name || "",
    alert_emails: c.alert_emails || "", email_configured: alerts.mailerReady(),
    recipients: { full: r.full, coordinators: r.coordinators.map((x) => ({ name: x.name, email: x.email, buyers: x.buyerIds.length })) } });
});
api.post("/digest/send", async (req, res) => {
  const c = db.prepare("SELECT name FROM companies WHERE id = ?").get(req.companyId) || {};
  try { res.json(await alerts.sendDigest(req.companyId, c.name)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- search ----------
api.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ pis: [], skus: [], buyers: [], vendors: [] });
  const like = "%" + q.toLowerCase() + "%";
  const cid = req.companyId;
  const pis = db.prepare(`SELECT p.id, p.pi_no, p.po_no, p.pi_date, b.name AS buyer_name
    FROM pis p LEFT JOIN buyers b ON b.id = p.buyer_id
    WHERE p.company_id IS ? AND (lower(p.pi_no) LIKE ? OR lower(p.po_no) LIKE ? OR lower(COALESCE(b.name,'')) LIKE ?)
    ORDER BY p.id DESC LIMIT 25`).all(cid, like, like, like);
  const skus = db.prepare(`SELECT s.id, s.item_no, s.buyer_no, s.description, s.qty, s.pi_id, p.pi_no
    FROM skus s JOIN pis p ON p.id = s.pi_id
    WHERE p.company_id IS ? AND (lower(s.item_no) LIKE ? OR lower(COALESCE(s.buyer_no,'')) LIKE ? OR lower(COALESCE(s.description,'')) LIKE ?)
    ORDER BY s.item_no LIMIT 40`).all(cid, like, like, like);
  const buyers = db.prepare(`SELECT id, name, contact, email FROM buyers WHERE company_id IS ? AND lower(name) LIKE ? LIMIT 15`).all(cid, like);
  const vendors = db.prepare(`SELECT id, name, lead_time_days FROM vendors WHERE company_id IS ? AND lower(name) LIKE ? LIMIT 15`).all(cid, like);
  res.json({ pis, skus, buyers, vendors });
});

api.get("/late", (req, res) => {
  const rows = D.getAllSkusDecorated(req.companyId).filter((s) => s.late && !s.shipped);
  const pis = {};
  db.prepare("SELECT p.*, b.name AS buyer_name FROM pis p LEFT JOIN buyers b ON b.id=p.buyer_id").all()
    .forEach((p) => (pis[p.id] = p));
  rows.sort((a, b) => (a.overall_due || "").localeCompare(b.overall_due || ""));
  res.json(rows.map((s) => ({ ...s, pi: pis[s.pi_id] || null })));
});

// Every SKU with PI number, buyer name, and resolved vendor tags — for the Items page.
api.get("/items", (req, res) => {
  const vmap = D.vendorsById(req.companyId);
  const pis = {};
  db.prepare("SELECT p.id, p.pi_no, b.name AS buyer_name FROM pis p LEFT JOIN buyers b ON b.id=p.buyer_id").all()
    .forEach((p) => (pis[p.id] = p));
  const rows = D.getAllSkusDecorated(req.companyId).filter((s) => !s.shipped).map((s) => {
    const vendors = (s.vendors || []).filter((v) => v.vendor_id)
      .map((v) => ({ id: v.vendor_id, name: v.vendor, late: v.late, role: v.role }));
    const p = pis[s.pi_id] || {};
    return { ...s, pi_no: p.pi_no || "", buyer_name: p.buyer_name || "", vendors };
  });
  // sort: overdue first, then by due date
  const rank = { overdue: 0, red: 1, amber: 2, green: 3, done: 4, null: 5 };
  rows.sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || (a.overall_due || "9999").localeCompare(b.overall_due || "9999"));
  res.json(rows);
});

api.get("/dashboard", (req, res) => {
  const pis = D.getPIs({ companyId: req.companyId });
  const all = D.getAllSkusDecorated(req.companyId).filter((s) => !s.shipped);
  res.json({
    active_orders: pis.length,
    open_skus: all.filter((s) => !s.complete).length,
    late_skus: all.filter((s) => s.late).length,
    pieces_due: all.reduce((t, s) => t + Math.max(0, s.still_due), 0),
  });
});

// Rich summary for the charts on the dashboard.
api.get("/summary", (req, res) => {
  const all = D.getAllSkusDecorated(req.companyId).filter((s) => !s.shipped);
  const vmap2 = D.vendorsById(req.companyId);
  const bucket = { green: 0, amber: 0, red: 0, overdue: 0, done: 0, none: 0 };
  all.forEach((s) => { bucket[s.status || "none"] = (bucket[s.status || "none"] || 0) + 1; });
  const giftBox = { yes: all.filter((s) => s.gift_box).length, no: all.filter((s) => !s.gift_box).length };
  const labels = { needed: all.filter((s) => s.labels_needed).length, ordered: all.filter((s) => s.labels_needed && s.labels_ordered).length };

  // vendor workload: count of SKUs each vendor appears on (any slot), with pieces
  const vmap = D.vendorsById();
  const vload = {};
  all.forEach((s) => {
    (s.vendors || []).forEach((v) => {
      if (!v.vendor) return;
      vload[v.vendor] = vload[v.vendor] || { skus: 0, pieces: 0 };
      vload[v.vendor].skus++; vload[v.vendor].pieces += s.qty || 0;
    });
  });

  // per-PI progress, with SKU breakdown and the vendors involved
  const piRows = D.getPIs({ companyId: req.companyId });
  const pis = piRows.map((p) => {
    const mine = all.filter((s) => s.pi_id === p.id);
    const vendorHealth = {};
    mine.forEach((s) => {
      (s.vendors || []).forEach((v) => {
        if (!v.vendor) return;
        if (!vendorHealth[v.vendor]) vendorHealth[v.vendor] = { name: v.vendor, late: 0, total: 0 };
        vendorHealth[v.vendor].total++;
        if (v.late) vendorHealth[v.vendor].late++;
      });
    });
    return {
      id: p.id, pi_no: p.pi_no, buyer: p.buyer_name,
      ordered: p.ordered_qty, in_hand: p.in_hand_qty, pct: p.progress_pct,
      late: p.late_count, sku_count: p.sku_count,
      ready: mine.filter((s) => s.complete).length,
      pending: mine.filter((s) => !s.complete).length,
      first_due: p.first_due,
      vendors: Object.values(vendorHealth).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  // due soon (next 21 days) grouped by week
  const today = D.todayISO();
  const piNoById = {};
  db.prepare("SELECT id, pi_no FROM pis").all().forEach((p) => (piNoById[p.id] = p.pi_no));
  const soon = all.filter((s) => s.overall_due && !s.complete)
    .map((s) => ({ item: s.item_no, due: s.overall_due, days: D.daysBetween(today, s.overall_due),
      pi_id: s.pi_id, pi_no: piNoById[s.pi_id] || "", vendors: s.late_vendors || [] }))
    .sort((a, b) => a.due.localeCompare(b.due));

  // overdue counted by SKU and by vendor
  const overdueSkus = all.filter((s) => s.late && !s.complete);
  const vendorOverdue = {};
  overdueSkus.forEach((s) => (s.late_vendors || []).forEach((n) => { vendorOverdue[n] = (vendorOverdue[n] || 0) + 1; }));
  const overdue_counts = {
    skus: overdueSkus.length,
    vendors: Object.keys(vendorOverdue).length,
    by_vendor: Object.entries(vendorOverdue).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  };

  res.json({ status: bucket, giftBox, labels, vload, pis, overdue_counts, soon: soon.slice(0, 40),
    totals: { skus: all.length, pieces: all.reduce((t, s) => t + (s.qty || 0), 0),
      in_hand: all.reduce((t, s) => t + s.in_hand, 0), due: all.reduce((t, s) => t + Math.max(0, s.still_due), 0) } });
});

// Vendor timelines: each vendor with their assigned SKUs and due dates.
api.get("/vendor-timelines", (req, res) => {
  const all = D.getAllSkusDecorated(req.companyId).filter((s) => !s.shipped);
  const vmap = D.vendorsById(req.companyId);
  const pis = {};
  db.prepare("SELECT id, pi_no FROM pis").all().forEach((p) => (pis[p.id] = p.pi_no));
  const out = {};
  Object.values(vmap).forEach((v) => (out[v.id] = { id: v.id, name: v.name, lead_time: v.lead_time_days, items: [] }));
  all.forEach((s) => {
    (s.vendors || []).forEach((v) => {
      if (!v.vendor_id) return;
      if (!out[v.vendor_id]) out[v.vendor_id] = { id: v.vendor_id, name: v.vendor, items: [] };
      out[v.vendor_id].items.push({ item: s.item_no, desc: s.description, pi: pis[s.pi_id], qty: s.qty,
        due: v.due, status: v.status, complete: s.complete, role: v.role });
    });
  });
  Object.values(out).forEach((v) => v.items.sort((a, b) => (a.due || "").localeCompare(b.due || "")));
  res.json(Object.values(out).filter((v) => v.items.length).sort((a, b) => a.name.localeCompare(b.name)));
});

// Deliveries over time: count of items due per week (past 4 to next 8 weeks).
api.get("/deliveries", (req, res) => {
  const all = D.getAllSkusDecorated(req.companyId).filter((s) => !s.shipped && s.overall_due);
  const weekKey = (iso) => {
    const d = new Date(iso + "T00:00:00");
    const day = (d.getDay() + 6) % 7; // Monday=0
    d.setDate(d.getDate() - day);
    return d.toISOString().slice(0, 10);
  };
  const buckets = {};
  all.forEach((s) => { const k = weekKey(s.overall_due); buckets[k] = (buckets[k] || 0) + 1; });
  const rows = Object.keys(buckets).sort().map((k) => ({ week: k, count: buckets[k] }));
  res.json(rows);
});

// CSV: late list (shareable).
api.get("/export/late.csv", (req, res) => {
  const rows = D.getAllSkusDecorated(req.companyId).filter((s) => s.late && !s.shipped);
  const pis = {};
  db.prepare("SELECT p.id, p.pi_no, b.name AS buyer_name FROM pis p LEFT JOIN buyers b ON b.id=p.buyer_id").all().forEach((p) => (pis[p.id] = p));
  const vmap = D.vendorsById();
  rows.sort((a, b) => (a.overall_due || "").localeCompare(b.overall_due || ""));
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const head = ["Item", "Buyer No", "Description", "PI", "Buyer", "Qty", "Still Due", "Due Date", "Days Late", "Vendors"];
  const lines = [head.map(esc).join(",")];
  rows.forEach((s) => {
    const p = pis[s.pi_id] || {};
    const vendors = (s.vendors || []).map((v) => v.vendor).filter(Boolean).join("; ");
    lines.push([s.item_no, s.buyer_no, s.description, p.pi_no, p.buyer_name, s.qty, s.still_due, s.overall_due, s.days_left != null ? -s.days_left : "", vendors].map(esc).join(","));
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="late-items.csv"');
  res.send(lines.join("\n"));
});

// CSV: one vendor's work order.
api.get("/export/vendor/:id.csv", (req, res) => {
  const v = db.prepare("SELECT * FROM vendors WHERE id = ?").get(req.params.id);
  if (!v) return res.status(404).send("Vendor not found");
  const all = D.getAllSkusDecorated(req.companyId).filter((s) => !s.shipped);
  const pis = {};
  db.prepare("SELECT id, pi_no FROM pis").all().forEach((p) => (pis[p.id] = p.pi_no));
  const esc = (val) => `"${String(val == null ? "" : val).replace(/"/g, '""')}"`;
  const lines = [["Item", "Buyer No", "Description", "PI", "Qty", "Due Date", "Status"].map(esc).join(",")];
  all.forEach((s) => {
    (s.vendors || []).forEach((v) => {
      if (v.vendor_id == req.params.id) {
        lines.push([s.item_no, s.buyer_no, s.description, pis[s.pi_id], s.qty, v.due, s.complete ? "Complete" : (v.status || "")].map(esc).join(","));
      }
    });
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="workorder-${v.name.replace(/[^a-z0-9]/gi, "_")}.csv"`);
  res.send(lines.join("\n"));
});

// JSON for a printable vendor work order page.
api.get("/vendor/:id/workorder", (req, res) => {
  const v = db.prepare("SELECT * FROM vendors WHERE id = ?").get(req.params.id);
  if (!v) return res.status(404).json({ error: "Vendor not found" });
  const all = D.getAllSkusDecorated(req.companyId).filter((s) => !s.shipped);
  const pis = {};
  db.prepare("SELECT id, pi_no FROM pis").all().forEach((p) => (pis[p.id] = p.pi_no));
  const items = [];
  all.forEach((s) => (s.vendors || []).forEach((v) => {
    if (v.vendor_id == req.params.id) items.push({ item: s.item_no, buyer_no: s.buyer_no, desc: s.description,
      pi: pis[s.pi_id], qty: s.qty, due: v.due, status: s.complete ? "Complete" : v.status });
  }));
  items.sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  res.json({ vendor: v.name, lead_time: v.lead_time_days, phone: v.phone, items, generated: D.todayISO() });
});

// ---------- ERP import ----------
const pending = new Map(); // importId -> parsed rows

function guess(headers, candidates) {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const c of candidates) {
    const hit = headers.find((h) => norm(h) === norm(c));
    if (hit) return hit;
  }
  for (const c of candidates) {
    const hit = headers.find((h) => norm(h).includes(norm(c)));
    if (hit) return hit;
  }
  return "";
}

// Which of your companies does this document belong to? Match company names against the text.
function detectCompany(text) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const hay = norm(text);
  if (!hay) return null;
  const list = db.prepare("SELECT * FROM companies WHERE archived = 0").all();
  let best = null;
  list.forEach((c) => {
    const n = norm(c.name);
    if (n.length >= 4 && hay.includes(n)) {
      if (!best || n.length > norm(best.name).length) best = c;   // prefer the longest match
    }
  });
  return best;
}

api.post("/import/preview", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  const isPdf = /\.pdf$/i.test(req.file.originalname || "") || req.file.mimetype === "application/pdf";

  // 0) PDF proforma invoice
  if (isPdf) {
    try {
      const p = await parseInvoicePdf(req.file.buffer);
      if (!p.skus || !p.skus.length) {
        // Show what the extractor actually produced, so the layout can be diagnosed.
        // Most diagnostic value first: method, then the rows that look like line items.
        const allLines = String(p._text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const itemish = allLines.filter((l) => /\d{3,}/.test(l) && /[A-Za-z]/.test(l) && !/^(proforma|buyer|payment|delivery|port|our banker|forwarder|manufacturer|ship date|ex-factory|account|swift|ifsc|item no|us \$)/i.test(l));
        const sample = [
          "BUILD CHECK: v3-positional",
          "EXTRACTION METHOD: " + (p._method || "unknown"),
          "TOTAL LINES: " + allLines.length,
          "",
          "----- rows that look like line items (" + itemish.length + ") -----",
          ...(itemish.length ? itemish.slice(0, 30) : ["(none found)"]),
          "",
          "----- first 25 lines -----",
          ...allLines.slice(0, 25),
        ].join("\n");
        return res.status(400).json({
          error: sample
            ? "Couldn't find line items in this PDF's layout. The text it contains is shown below — send it to me and I'll add support for this format."
            : "This PDF has no readable text — it looks like a scan. Please use the Excel export instead.",
          sample,
        });
      }
      const importId = crypto.randomUUID();
      pending.set(importId, { mode: "invoice", skus: p.skus });
      setTimeout(() => pending.delete(importId), 30 * 60 * 1000);
      const hit = detectCompany(p._text);
      return res.json({
        importId, mode: "invoice", source: "pdf", rowCount: p.skus.length, skus: p.skus,
        companies: db.prepare("SELECT id, name FROM companies WHERE archived = 0 ORDER BY id").all(),
        detected_company_id: hit ? hit.id : req.companyId,
        detected_company_name: hit ? hit.name : null,
        detected: { pi_no: p.pi || "", po_no: p.po || "", buyer: p.buyer || "", buyer_address: p.buyer_address || "",
          pi_date: p.pi_date || null, ex_factory_date: p.ex_factory_date || null, ship_date: p.ship_date || null },
      });
    } catch (e) { return res.status(400).json({ error: e.message || "Could not read that PDF" }); }
  }

  // 1) Try the invoice-layout reader (handles the ERP's printed-invoice export).
  let inv = null;
  try { inv = parseInvoiceXlsx(req.file.buffer); } catch (e) { inv = null; }

  if (inv && inv.skus && inv.skus.length) {
    const importId = crypto.randomUUID();
    pending.set(importId, { mode: "invoice", skus: inv.skus });
    setTimeout(() => pending.delete(importId), 30 * 60 * 1000);
    const hitX = detectCompany(JSON.stringify(inv));
    return res.json({
      importId, mode: "invoice", rowCount: inv.skus.length,
      skus: inv.skus,
      companies: db.prepare("SELECT id, name FROM companies WHERE archived = 0 ORDER BY id").all(),
      detected_company_id: hitX ? hitX.id : req.companyId,
      detected_company_name: hitX ? hitX.name : null,
      detected: {
        pi_no: inv.pi || "", po_no: inv.po || "", buyer: inv.buyer || "", buyer_address: inv.buyer_address || "",
        pi_date: inv.pi_date || null, ex_factory_date: inv.ex_factory_date || null, ship_date: inv.ship_date || null,
      },
    });
  }

  // 2) Fall back to a plain table (clean grid with header row).
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  } catch (e) { return res.status(400).json({ error: "Could not read that file: " + e.message }); }
  if (!rows.length) return res.status(400).json({ error: "Couldn't find any line items in this file. If it's an unusual layout, send me a sample." });

  const headers = Object.keys(rows[0]);
  const mapping = {
    item_no: guess(headers, ["item no", "itemno", "item", "sku", "style", "article"]),
    buyer_no: guess(headers, ["buyer no", "buyerno", "buyer code", "buyer ref", "customer ref"]),
    description: guess(headers, ["description", "desc", "particulars", "product"]),
    qty: guess(headers, ["order qty", "qty", "quantity", "pcs", "pieces"]),
  };
  const header = {
    pi_no: guess(headers, ["proforma", "pi no", "pino", "pi number", "invoice no"]),
    po_no: guess(headers, ["buyer order", "po no", "pono", "po number", "order no"]),
    buyer: guess(headers, ["buyer", "customer", "party", "consignee"]),
    pi_date: guess(headers, ["pi date", "date", "invoice date", "proforma date"]),
    ex_factory_date: guess(headers, ["ex factory", "exfactory", "ex-factory"]),
    ship_date: guess(headers, ["ship date", "shipdate", "shipment date", "delivery date"]),
  };
  const first = rows[0];
  const importId = crypto.randomUUID();
  pending.set(importId, { mode: "table", rows });
  setTimeout(() => pending.delete(importId), 30 * 60 * 1000);

  res.json({
    importId, mode: "table", headers, mapping, rowCount: rows.length, sample: rows.slice(0, 8),
    detected: {
      pi_no: header.pi_no ? String(first[header.pi_no] || "") : "",
      po_no: header.po_no ? String(first[header.po_no] || "") : "",
      buyer: header.buyer ? String(first[header.buyer] || "") : "",
      pi_date: header.pi_date ? D.parseDate(first[header.pi_date]) : null,
      ex_factory_date: header.ex_factory_date ? D.parseDate(first[header.ex_factory_date]) : null,
      ship_date: header.ship_date ? D.parseDate(first[header.ship_date]) : null,
    },
  });
});

api.post("/import/commit", (req, res) => {
  const { importId, mapping, pi } = req.body;
  const stash = pending.get(importId);
  if (!stash) return res.status(400).json({ error: "This import expired — please upload the file again" });
  if (!pi || !pi.pi_no) return res.status(400).json({ error: "PI number is required" });

  // Build a uniform list of line items regardless of source format.
  let items = [];
  if (stash.mode === "invoice") {
    items = stash.skus.map((s) => ({ item_no: String(s.item_no || "").trim(), buyer_no: s.buyer_no || "", description: s.description || "", qty: Number(s.qty) || 0 }));
  } else {
    if (!mapping || !mapping.item_no || !mapping.qty) return res.status(400).json({ error: "Map at least Item No and Quantity" });
    items = (stash.rows || []).map((row) => ({
      item_no: String(row[mapping.item_no] ?? "").trim(),
      buyer_no: mapping.buyer_no ? String(row[mapping.buyer_no] ?? "").trim() : "",
      description: mapping.description ? String(row[mapping.description] ?? "").trim() : "",
      qty: parseInt(String(row[mapping.qty] ?? "").replace(/[^0-9.-]/g, ""), 10),
    }));
  }
  items = items.filter((s) => s.item_no && s.qty > 0);
  if (!items.length) return res.status(400).json({ error: "No valid line items found in this file" });

  const dupe = db.prepare("SELECT id FROM pis WHERE pi_no = ? AND company_id IS ?").get(String(pi.pi_no).trim(), pi.company_id ? Number(pi.company_id) : req.companyId);

  // Re-uploading an existing PI: work out exactly what changed, and let the user confirm.
  if (dupe && !req.body.allowDuplicate && !req.body.updateExisting) {
    const current = db.prepare("SELECT * FROM skus WHERE pi_id = ?").all(dupe.id);
    const byItem = {};
    current.forEach((c) => (byItem[String(c.item_no).trim().toLowerCase()] = c));
    const incoming = {};
    items.forEach((i) => (incoming[String(i.item_no).trim().toLowerCase()] = i));

    const added = items.filter((i) => !byItem[String(i.item_no).trim().toLowerCase()])
      .map((i) => ({ item_no: i.item_no, qty: i.qty }));
    const changed = [];
    const unchanged = [];
    items.forEach((i) => {
      const c = byItem[String(i.item_no).trim().toLowerCase()];
      if (!c) return;
      if ((c.qty || 0) !== i.qty) changed.push({ item_no: i.item_no, from: c.qty || 0, to: i.qty });
      else unchanged.push(i.item_no);
    });
    const removed = current.filter((c) => !incoming[String(c.item_no).trim().toLowerCase()])
      .map((c) => ({ item_no: c.item_no, qty: c.qty, received: c.received_qty || 0 }));

    return res.status(409).json({
      error: "PI " + pi.pi_no + " already exists",
      existingId: dupe.id,
      diff: { added, changed, removed, unchanged: unchanged.length },
    });
  }

  // Apply the update in place, keeping vendors and received figures for SKUs that stay.
  if (dupe && req.body.updateExisting) {
    const current = db.prepare("SELECT * FROM skus WHERE pi_id = ?").all(dupe.id);
    const byItem = {};
    current.forEach((c) => (byItem[String(c.item_no).trim().toLowerCase()] = c));
    const incomingKeys = new Set(items.map((i) => String(i.item_no).trim().toLowerCase()));

    const run = db.transaction(() => {
      // header details refresh
      const sets = { po_no: pi.po_no || "", pi_date: D.parseDate(pi.pi_date),
        ex_factory_date: D.parseDate(pi.ex_factory_date), ship_date: D.parseDate(pi.ship_date) };
      db.prepare("UPDATE pis SET po_no=?, pi_date=?, ex_factory_date=?, ship_date=? WHERE id=?")
        .run(sets.po_no, sets.pi_date, sets.ex_factory_date, sets.ship_date, dupe.id);

      let updated = 0, inserted = 0, deleted = 0;
      items.forEach((i) => {
        const c = byItem[String(i.item_no).trim().toLowerCase()];
        if (c) {
          if ((c.qty || 0) !== i.qty) {
            db.prepare("UPDATE skus SET qty = ?, description = COALESCE(NULLIF(?,''), description), buyer_no = COALESCE(NULLIF(?,''), buyer_no) WHERE id = ?")
              .run(i.qty, i.description || "", i.buyer_no || "", c.id);
            updated++;
          }
        } else {
          db.prepare("INSERT INTO skus (pi_id,item_no,buyer_no,description,qty) VALUES (?,?,?,?,?)")
            .run(dupe.id, i.item_no, i.buyer_no || "", i.description || "", i.qty);
          inserted++;
        }
      });
      if (req.body.removeMissing !== false) {
        current.forEach((c) => {
          if (!incomingKeys.has(String(c.item_no).trim().toLowerCase())) {
            db.prepare("DELETE FROM sku_vendors WHERE sku_id = ?").run(c.id);
            db.prepare("DELETE FROM skus WHERE id = ?").run(c.id);
            deleted++;
          }
        });
      }
      return { updated, inserted, deleted };
    });
    try {
      const out = run();
      pending.delete(importId);
      return res.json({ ok: true, mode: "updated", piId: dupe.id, ...out });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const targetCompany = pi.company_id ? Number(pi.company_id) : req.companyId;
  const buyerId = D.findOrCreateBuyer(pi.buyer, pi.buyer_address, targetCompany);
  const insertPI = db.prepare(`INSERT INTO pis (pi_no,po_no,buyer_id,pi_date,ex_factory_date,ship_date,notes,company_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insertSKU = db.prepare(`INSERT INTO skus
    (pi_id,item_no,buyer_no,description,qty,gift_box,gift_box_vendor_id,labels_needed,v1_id,v2_id,v3_id,v4_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  const run = db.transaction(() => {
    const piId = insertPI.run(String(pi.pi_no).trim(), pi.po_no || "", buyerId,
      D.parseDate(pi.pi_date), D.parseDate(pi.ex_factory_date), D.parseDate(pi.ship_date), pi.notes || "", targetCompany).lastInsertRowid;
    let count = 0, carried = 0;
    for (const s of items) {
      const prior = D.priorSettings(s.item_no, req.companyId);
      if (prior) carried++;
      const info = insertSKU.run(piId, s.item_no, s.buyer_no, s.description, s.qty,
        prior ? prior.gift_box : (pi.gift_box_all ? 1 : 0),
        prior ? prior.gift_box_vendor_id : null,
        prior ? prior.labels_needed : 0, null, null, null, null);
      // reuse the vendor line-up from the last time this item was ordered
      if (prior && prior.prev_sku_id) {
        db.prepare(`INSERT INTO sku_vendors (sku_id, vendor_id, role)
          SELECT ?, vendor_id, role FROM sku_vendors WHERE sku_id = ?`).run(info.lastInsertRowid, prior.prev_sku_id);
      }
      count++;
    }
    return { piId, count, carried };
  });

  try {
    const out = run();
    pending.delete(importId);
    if (!out.count) return res.status(400).json({ error: "No valid line items found — check the Item No and Quantity mapping" });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- static ----------
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

alerts.startScheduler();

app.listen(PORT, "0.0.0.0", () => {
  console.log("\n  PI Production Tracker running");
  console.log("  Local:   http://localhost:" + PORT);
  console.log("  Network: http://<this-pc-ip>:" + PORT);
  console.log("  Password: " + (process.env.APP_PASSWORD ? "(from APP_PASSWORD)" : "changeme  <-- set APP_PASSWORD!") + "\n");
});
