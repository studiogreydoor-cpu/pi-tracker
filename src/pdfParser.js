// Reads a Proforma Invoice PDF by extracting its text and parsing the line items.
// No AI service required — the PDFs your ERP produces contain real text.
let pdfParse = null;
try { pdfParse = require("pdf-parse"); } catch (e) { pdfParse = null; }

function normDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/); // day-first
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${String(+mo).padStart(2, "0")}-${String(+d).padStart(2, "0")}`;
  }
  return "";
}

function labelValue(text, label) {
  // Finds "Label   value" allowing flexible spacing; stops before a following "Date" column.
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[:#]?\\s+([^\\n]*)", "i");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

function firstToken(v) { return String(v || "").trim().split(/\s{2,}|\s+/)[0] || ""; }

function parseInvoiceText(text) {
  const lines = text.split(/\r?\n/);

  // --- header fields ---
  let pi = "";
  const po = firstToken(labelValue(text, "Buyer Order"));
  // "Proforma #  217   Date  19/06/26" — grab the date that follows on the same line
  let piDate = "";
  const piLine = lines.find((l) => /proforma\s*#/i.test(l));
  if (piLine) {
    // "Proforma #   217   Date  19/06/26"  -> number after the #, date after "Date"
    const n = piLine.match(/proforma\s*#\s*[:]?\s*(\S+)/i);
    if (n) pi = n[1].trim();
    const d = piLine.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/);
    if (d) piDate = normDate(d[1]);
  }
  if (!pi) pi = firstToken(labelValue(text, "Invoice No"));
  const exf = normDate(firstToken(labelValue(text, "Ex-Factory Date")) || firstToken(labelValue(text, "Ex Factory Date")));
  const ship = normDate(firstToken(labelValue(text, "Ship Date")));

  // --- buyer block: the lines after a standalone "Buyer" heading ---
  let buyer = "", addr = [];
  const bIdx = lines.findIndex((l) => /^\s*buyer\s*$/i.test(l));
  if (bIdx >= 0) {
    for (let i = bIdx + 1; i < Math.min(bIdx + 8, lines.length); i++) {
      const t = lines[i].trim();
      if (!t) continue;
      if (/^(our bankers|buyer's bank)/i.test(t)) break;
      // right-hand column labels bleed into these lines — skip, don't stop
      if (/^(port of|delivery terms|payment terms|forwarder|partshipment|ship date|ex-factory)/i.test(t)) continue;
      const clean = t.split(/\s{3,}/)[0].trim();
      if (!clean) continue;
      if (!buyer) buyer = clean; else addr.push(clean);
    }
  }

  // --- line items ---
  // Typical: "18947   MCA-1   MEZUZAH   300 Pc   1.10   330.00"
  // Also tolerates a missing buyer code and a missing "Pc".
  const skus = [];
  const seen = new Set();
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ").trimEnd();
    if (!line.trim()) continue;
    if (/^(item no|total|amount in|continued|proforma invoice|page)/i.test(line.trim())) continue;

    // qty is a number optionally followed by Pc/Pcs, then price and amount
    let m = line.match(/^\s*(\S+)\s{2,}(\S+)\s{2,}(.+?)\s{2,}([\d,]+)\s*(?:pcs?|nos?)?\s{2,}[\d.,]+\s{2,}[\d.,]+\s*$/i);
    let itemNo, buyerNo, desc, qty;
    if (m) {
      [, itemNo, buyerNo, desc, qty] = m;
    } else {
      // single-space fallback (some extractors collapse whitespace)
      m = line.match(/^\s*(\d[\w\-/]*)\s+([A-Za-z0-9\-/]+)\s+(.+?)\s+([\d,]+)\s*(?:pcs?|nos?)\s+[\d.,]+\s+[\d.,]+\s*$/i);
      if (m) { [, itemNo, buyerNo, desc, qty] = m; }
    }
    if (!m) continue;

    const q = parseInt(String(qty).replace(/[^0-9]/g, ""), 10);
    if (!itemNo || !q) continue;
    const key = itemNo + "|" + q + "|" + desc.trim();
    if (seen.has(key)) continue; // repeated page headers/footers
    seen.add(key);
    skus.push({ item_no: itemNo.trim(), buyer_no: (buyerNo || "").trim(), description: desc.trim().replace(/\s{2,}/g, " "), qty: q });
  }

  return { pi, po, buyer, buyer_address: addr.join(", "), pi_date: piDate, ex_factory_date: exf, ship_date: ship, skus };
}

async function parseInvoicePdf(buffer) {
  if (!pdfParse) throw new Error("PDF support isn't available on this server");
  const data = await pdfParse(buffer);
  if (!data || !data.text || !data.text.trim()) {
    throw new Error("This PDF has no readable text — it may be a scan. Please use the Excel export instead.");
  }
  return parseInvoiceText(data.text);
}

module.exports = { parseInvoicePdf, parseInvoiceText };
