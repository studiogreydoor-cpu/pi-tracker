// PI Production Tracker - standalone server
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const XLSX = require("xlsx");
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
app.use("/api", api);

// ---------- masters ----------
api.get("/vendors", (req, res) => res.json(db.prepare("SELECT * FROM vendors ORDER BY name").all()));
api.post("/vendors", (req, res) => {
  const { name, lead_time_days, phone, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });
  try {
    const r = db.prepare("INSERT INTO vendors (name, lead_time_days, phone, notes) VALUES (?,?,?,?)")
      .run(name.trim(), Number(lead_time_days) || 0, phone || "", notes || "");
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

api.get("/buyers", (req, res) => res.json(db.prepare("SELECT * FROM buyers ORDER BY name").all()));
api.post("/buyers", (req, res) => {
  const { name, address, contact, email, phone, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });
  try {
    const r = db.prepare("INSERT INTO buyers (name,address,contact,email,phone,notes) VALUES (?,?,?,?,?,?)")
      .run(name.trim(), address || "", contact || "", email || "", phone || "", notes || "");
    res.json(db.prepare("SELECT * FROM buyers WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) { res.status(400).json({ error: "A buyer with that name already exists" }); }
});
api.patch("/buyers/:id", (req, res) => {
  const allowed = ["name", "address", "contact", "email", "phone", "notes"];
  const sets = [], vals = [];
  allowed.forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k]); } });
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE buyers SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  res.json(db.prepare("SELECT * FROM buyers WHERE id = ?").get(req.params.id));
});

// ---------- PIs & SKUs ----------
api.get("/pis", (req, res) => res.json(D.getPIs({ includeShipped: req.query.all === "1" })));
api.get("/pis/:id/skus", (req, res) => res.json(D.getSkusForPI(req.params.id)));
api.patch("/pis/:id", (req, res) => {
  const allowed = ["pi_no", "po_no", "buyer_id", "pi_date", "ex_factory_date", "ship_date", "packed", "shipped", "notes"];
  const sets = [], vals = [];
  allowed.forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k]); } });
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE pis SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  // Ticking the PI cascades to its SKUs, so whole-order actions are one click.
  if (req.body.shipped === 1) db.prepare("UPDATE skus SET shipped = 1, packed = 1 WHERE pi_id = ?").run(req.params.id);
  if (req.body.packed === 1) db.prepare("UPDATE skus SET packed = 1 WHERE pi_id = ?").run(req.params.id);
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

api.patch("/skus/:id", (req, res) => {
  const sets = [], vals = [];
  SKU_FIELDS.forEach((k) => { if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k] === "" ? null : req.body[k]); } });
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE skus SET ${sets.join(", ")} WHERE id = ?`).run(...vals); }
  const sku = db.prepare("SELECT * FROM skus WHERE id = ?").get(req.params.id);
  const pi = db.prepare("SELECT * FROM pis WHERE id = ?").get(sku.pi_id);
  res.json(D.decorateSku(sku, D.vendorsById(), pi));
});

api.get("/late", (req, res) => {
  const rows = D.getAllSkusDecorated().filter((s) => s.late && !s.shipped);
  const pis = {};
  db.prepare("SELECT p.*, b.name AS buyer_name FROM pis p LEFT JOIN buyers b ON b.id=p.buyer_id").all()
    .forEach((p) => (pis[p.id] = p));
  rows.sort((a, b) => (a.overall_due || "").localeCompare(b.overall_due || ""));
  res.json(rows.map((s) => ({ ...s, pi: pis[s.pi_id] || null })));
});

api.get("/dashboard", (req, res) => {
  const pis = D.getPIs();
  const all = D.getAllSkusDecorated().filter((s) => !s.shipped);
  res.json({
    active_orders: pis.length,
    open_skus: all.filter((s) => !s.complete).length,
    late_skus: all.filter((s) => s.late).length,
    pieces_due: all.reduce((t, s) => t + Math.max(0, s.still_due), 0),
  });
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

api.post("/import/preview", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  } catch (e) { return res.status(400).json({ error: "Could not read that file: " + e.message }); }
  if (!rows.length) return res.status(400).json({ error: "The file has no data rows" });

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
  pending.set(importId, rows);
  setTimeout(() => pending.delete(importId), 30 * 60 * 1000);

  res.json({
    importId, headers, mapping, rowCount: rows.length, sample: rows.slice(0, 8),
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
  const rows = pending.get(importId);
  if (!rows) return res.status(400).json({ error: "This import expired — please upload the file again" });
  if (!pi || !pi.pi_no) return res.status(400).json({ error: "PI number is required" });
  if (!mapping || !mapping.item_no || !mapping.qty) return res.status(400).json({ error: "Map at least Item No and Quantity" });

  const dupe = db.prepare("SELECT id FROM pis WHERE pi_no = ?").get(String(pi.pi_no).trim());
  if (dupe && !req.body.allowDuplicate) {
    return res.status(409).json({ error: "PI " + pi.pi_no + " already exists", existingId: dupe.id });
  }

  const buyerId = D.findOrCreateBuyer(pi.buyer, pi.buyer_address);
  const insertPI = db.prepare(`INSERT INTO pis (pi_no,po_no,buyer_id,pi_date,ex_factory_date,ship_date,notes)
    VALUES (?,?,?,?,?,?,?)`);
  const insertSKU = db.prepare(`INSERT INTO skus
    (pi_id,item_no,buyer_no,description,qty,gift_box,gift_box_vendor_id,labels_needed,v1_id,v2_id,v3_id,v4_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  const run = db.transaction(() => {
    const piId = insertPI.run(String(pi.pi_no).trim(), pi.po_no || "", buyerId,
      D.parseDate(pi.pi_date), D.parseDate(pi.ex_factory_date), D.parseDate(pi.ship_date), pi.notes || "").lastInsertRowid;
    let count = 0, carried = 0;
    for (const row of rows) {
      const itemNo = String(row[mapping.item_no] ?? "").trim();
      const qty = parseInt(String(row[mapping.qty] ?? "").replace(/[^0-9.-]/g, ""), 10);
      if (!itemNo || !qty || qty <= 0) continue; // skips totals/blank rows
      const prior = D.priorSettings(itemNo);
      if (prior) carried++;
      insertSKU.run(piId, itemNo,
        mapping.buyer_no ? String(row[mapping.buyer_no] ?? "").trim() : "",
        mapping.description ? String(row[mapping.description] ?? "").trim() : "",
        qty,
        prior ? prior.gift_box : (pi.gift_box_all ? 1 : 0),
        prior ? prior.gift_box_vendor_id : null,
        prior ? prior.labels_needed : 0,
        prior ? prior.v1_id : null, prior ? prior.v2_id : null,
        prior ? prior.v3_id : null, prior ? prior.v4_id : null);
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

app.listen(PORT, "0.0.0.0", () => {
  console.log("\n  PI Production Tracker running");
  console.log("  Local:   http://localhost:" + PORT);
  console.log("  Network: http://<this-pc-ip>:" + PORT);
  console.log("  Password: " + (process.env.APP_PASSWORD ? "(from APP_PASSWORD)" : "changeme  <-- set APP_PASSWORD!") + "\n");
});
