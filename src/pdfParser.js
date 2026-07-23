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
  // Two shapes occur depending on the extractor:
  //  (a) label and value on one line:  "Proforma #   217   Date  19/06/26"
  //  (b) a block of labels, then a block of values on their own lines.
  // We try (a) first, then fall back to (b) heuristics.
  const clean = lines.map((l) => l.trim());
  const isLabelish = (t) => /^(proforma|buyer order|payment terms|delivery terms|ship date|ex-factory|date|buyer no|buyer|forwarder|partshipment|our bankers|port of|manufacturer|item no|us \$|amount|price|order qty|description|page)/i.test(t);

  let pi = "", po = "", piDate = "", exf = "", ship = "";

  const piLine = clean.find((l) => /proforma\s*#/i.test(l));
  if (piLine) {
    const n = piLine.match(/proforma\s*#\s*[:]?\s*(\d[\w\-/]*)/i);
    if (n) pi = n[1];
    const d = piLine.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/);
    if (d) piDate = normDate(d[1]);
  }
  const poLine = clean.find((l) => /buyer\s*order\s*#/i.test(l));
  if (poLine) { const n = poLine.match(/buyer\s*order\s*#\s*[:]?\s*(\d[\w\-/]*)/i); if (n) po = n[1]; }
  const exfLine = clean.find((l) => /ex[- ]?factory/i.test(l));
  if (exfLine) { const d = exfLine.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/); if (d) exf = normDate(d[1]); }
  const shipLine = clean.find((l) => /ship\s*date/i.test(l) && /\d{1,2}[/\-.]\d{1,2}/.test(l));
  if (shipLine) { const d = shipLine.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/); if (d) ship = normDate(d[1]); }

  // Fallback (b): gather standalone values from the header region.
  const headerEnd = clean.findIndex((l) => /^\d[\w\-/]*\s+\S/.test(l) && /\d/.test(l) && /(pcs?\b|\d+\.\d{2})/i.test(l));
  const headRegion = clean.slice(0, headerEnd > 0 ? headerEnd : Math.min(45, clean.length));

  const standaloneDates = headRegion.filter((l) => /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(l)).map(normDate);
  const inlineDates = headRegion.map((l) => { const m = l.match(/(?:^|\s)(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\s*$/); return m ? normDate(m[1]) : null; }).filter(Boolean);
  const allDates = [...new Set([...inlineDates, ...standaloneDates])].filter(Boolean);

  if (!piDate) piDate = allDates[0] || "";
  if (!ship) ship = allDates.find((d) => d !== piDate && d !== exf) || "";

  if (!pi || !po) {
    const nums = headRegion.filter((l) => /^\d{1,8}$/.test(l));
    if (!pi) pi = nums[0] || "";
    if (!po) po = nums[1] || nums[0] || "";
  }

  // --- buyer block ---
  let buyer = "", addr = [];
  const stopBank = (t) => /(bank|swift|ifsc|account\s*no)/i.test(t);
  // shape (a): a standalone "Buyer" heading, buyer details follow in the left column
  let bIdx = clean.findIndex((l) => /^buyer\s*:?$/i.test(l));
  if (bIdx >= 0) {
    for (let i = bIdx + 1; i < Math.min(bIdx + 14, clean.length); i++) {
      const t = clean[i];
      if (!t) continue;
      if (stopBank(t)) break;
      if (isLabelish(t)) continue;                     // right-column labels bleed in
      if (/^company\s*#/i.test(t)) continue;
      const first = t.split(/\s{3,}/)[0].trim();
      if (!first) continue;
      if (!buyer) buyer = first; else addr.push(first);
      if (addr.length >= 5) break;
    }
  }
  // shape (b): nothing found — take the block after the last header label, before the bank details
  if (!buyer) {
    const lastLabel = Math.max(
      clean.findIndex((l) => /^port of discharge/i.test(l)),
      clean.findIndex((l) => /^forwarder/i.test(l)),
      clean.findIndex((l) => /^our bankers/i.test(l))
    );
    if (lastLabel >= 0) {
      for (let i = lastLabel + 1; i < Math.min(lastLabel + 12, clean.length); i++) {
        const t = clean[i];
        if (!t) continue;
        if (stopBank(t)) break;
        if (isLabelish(t)) continue;
        if (/^(fob|cif|exw|tt|lc)$/i.test(t)) continue;
        if (/^company\s*#/i.test(t)) continue;
        if (!buyer) buyer = t; else addr.push(t);
        if (addr.length >= 5) break;
      }
    }
  }

  // --- line items ---
  // PDF text extractors emit these in different column orders, e.g.
  //   "18947   MCA-1   MEZUZAH   300 Pc   1.10   330.00"      (layout-preserving)
  //   "18947 MEZUZAH MCA-1 300 1.10 330.00 Pc"                (reading order)
  // So instead of assuming an order: strip the unit, take the trailing numbers,
  // then split the remaining prefix into item code / buyer code / description.
  const skus = [];
  const seen = new Set();
  const looksLikeBuyerCode = (t) => /^[A-Za-z]{1,6}[-/]?\d{1,4}[A-Za-z]?$/.test(t) && /[A-Za-z]/.test(t);

  for (const raw of lines) {
    let line = raw.replace(/\t/g, " ").trim();
    if (!line) continue;
    if (/^(item no|total|amount in|continued|proforma|page|for grey|authorised|signature|please send|buyer order|ship date|ex-factory|payment terms|delivery terms|port of|our banker|forwarder|partshipment|manufacturer)/i.test(line)) continue;

    // must start with an item code (digits, optionally with a letter/suffix)
    if (!/^\d[\w\-/]*\s/.test(line)) continue;

    // remove a trailing unit word ("Pc", "Pcs", "Nos")
    line = line.replace(/\s+(pcs?|nos?)\.?\s*$/i, "");

    const tokens = line.split(/\s+/);
    if (tokens.length < 3) continue;

    // Collect trailing numeric tokens (amount, price, qty — possibly with a unit between)
    const nums = [];
    let i = tokens.length - 1;
    while (i > 0 && nums.length < 4) {
      const t = tokens[i];
      if (/^[\d,]+(\.\d+)?$/.test(t)) { nums.unshift({ v: t, idx: i }); i--; continue; }
      if (/^(pcs?|nos?)\.?$/i.test(t)) { i--; continue; }   // unit sitting mid-line
      break;
    }
    if (!nums.length) continue;

    // Quantity = the first of the trailing number run that is a whole number.
    // (amount and price carry decimals; qty does not)
    let qtyTok = nums.find((n) => !n.v.includes("."));
    if (!qtyTok) qtyTok = nums[0];
    const qty = parseInt(qtyTok.v.replace(/[^0-9]/g, ""), 10);
    if (!qty) continue;

    const itemNo = tokens[0];
    // everything between the item code and the numbers is description + buyer code
    const middle = tokens.slice(1, qtyTok.idx);
    let buyerNo = "";
    const bIdx = middle.findIndex(looksLikeBuyerCode);
    let descParts = middle;
    if (bIdx >= 0) {
      buyerNo = middle[bIdx];
      descParts = middle.filter((_, k) => k !== bIdx);
    }
    const description = descParts.join(" ").replace(/\s{2,}/g, " ").trim();
    if (!description && !buyerNo) continue;

    const key = itemNo + "|" + qty + "|" + description;
    if (seen.has(key)) continue;              // repeated page headers/footers
    seen.add(key);
    skus.push({ item_no: itemNo, buyer_no: buyerNo, description, qty });
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
