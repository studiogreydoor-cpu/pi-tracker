// Reads a Proforma Invoice PDF by extracting its text and parsing the line items.
// No AI service required — the PDFs your ERP produces contain real text.
let pdfParse = null;
try { pdfParse = require("pdf-parse"); } catch (e) { pdfParse = null; }
let positional = null;
try { positional = require("./pdfPositional"); } catch (e) { positional = null; }

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

// pdf-parse concatenates adjacent table cells with no space ("18490Patio bowl mustard100Pc").
// Re-insert spaces at digit<->letter boundaries. Applied only to candidate item rows so that
// standalone codes like KKX0005 elsewhere are left untouched.
function unglue(line) {
  return line
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

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
  if (poLine) {
    const n = poLine.match(/buyer\s*order\s*#\s*[:]?\s*([A-Za-z0-9][\w\-/]*)/i);
    if (n && !/^date$/i.test(n[1])) po = n[1];
  }
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
    // PO numbers are often alphanumeric, e.g. "PO013581"
    const alnum = headRegion.filter((l) => /^[A-Z]{1,4}[-/]?\d{4,}$/i.test(l) && !/^\d+$/.test(l));
    if (!pi) pi = nums[0] || "";
    if (!po) po = alnum[0] || nums[1] || nums[0] || "";
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
  // Units seen on these invoices: Pc/Pcs, Set/Sets, No/Nos, Pair/Pairs.
  const UNIT = /^(pcs?|sets?|nos?|pairs?|ctns?)\.?$/i;
  const UNIT_TAIL = /\s*(pcs?|sets?|nos?|pairs?|ctns?)\.?\s*$/i;
  const skus = [];
  const seen = new Set();
  // Buyer codes look like MCA-1, KKX0005, TOV-C18863, TOV-T19124 — letters and digits, no spaces.
  const looksLikeBuyerCode = (t) =>
    /^[A-Za-z][A-Za-z0-9]*[-/]?[A-Za-z0-9]*\d[A-Za-z0-9]*$/.test(t) &&
    /[A-Za-z]/.test(t) && /\d/.test(t) && t.length >= 3 && t.length <= 20 && !/^\d+$/.test(t);
  const skipLine = (t) => /^(item no|total|amount in|continued|proforma|page|for grey|authorised|signature|please send|buyer order|ship date|ex-factory|payment terms|delivery terms|port of|our banker|forwarder|partshipment|manufacturer|picture|packing|cbm|buyer no|total volume|us[. ]|five only)/i.test(t);

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].replace(/\t/g, " ").trim();
    if (!line || skipLine(line)) continue;
    if (!/^\d{3,}/.test(line)) continue;                       // must start with an item code
    const hasUnit = /(pcs?|sets?|nos?|pairs?|ctns?)\b/i.test(line);
    if (!hasUnit && !/^\d[\w\-/]*\s/.test(line)) continue;
    line = unglue(line);

    let tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;

    // Item number may carry a short suffix letter: "18625 B"
    let itemNo = tokens[0];
    let consumed = 1;
    if (tokens[1] && /^[A-Za-z]{1,2}$/.test(tokens[1]) && !UNIT.test(tokens[1])) {
      itemNo += " " + tokens[1];
      consumed = 2;
    }

    // Quantity: the number immediately before a unit word is the most reliable signal.
    const isNum = (t) => /^[\d,]+(\.\d+)?$/.test(t);
    const isInt = (t) => /^[\d,]+$/.test(t);
    let qty = 0, qtyIdx = -1;
    for (let k = consumed; k < tokens.length; k++) {
      if (UNIT.test(tokens[k]) && k > 0 && isInt(tokens[k - 1])) {
        qty = parseInt(tokens[k - 1].replace(/,/g, ""), 10);
        qtyIdx = k - 1;
        break;
      }
    }
    if (!qty) {
      // No unit word: fall back to the first whole number after the item code.
      const stripped = line.replace(UNIT_TAIL, "").split(/\s+/);
      for (let k = consumed; k < stripped.length; k++) {
        if (isInt(stripped[k])) { qty = parseInt(stripped[k].replace(/,/g, ""), 10); qtyIdx = k; break; }
      }
      tokens = stripped;
    }
    if (!qty) continue;

    // Description = tokens between the item code and the quantity (prices come after).
    const middle = tokens.slice(consumed, qtyIdx).filter((t) => !UNIT.test(t) && !isNum(t));
    let buyerNo = "";
    const bIdx = middle.findIndex(looksLikeBuyerCode);
    let descParts = middle;
    if (bIdx >= 0) { buyerNo = middle[bIdx]; descParts = middle.filter((_, k) => k !== bIdx); }

    // Buyer code is often on a following line, after a "Buyer No" label.
    if (!buyerNo) {
      for (let k = li + 1; k < Math.min(li + 6, lines.length); k++) {
        const nxt = (lines[k] || "").trim();
        if (!nxt) continue;
        if (/^\d{3,}/.test(nxt) && /(pcs?|sets?|nos?)\b/i.test(nxt)) break;   // next item row
        if (/^buyer\s*no/i.test(nxt)) continue;
        if (/^(packing|cbm)/i.test(nxt)) continue;
        if (looksLikeBuyerCode(nxt)) { buyerNo = nxt; break; }
      }
    }

    const description = descParts.join(" ").replace(/\s{2,}/g, " ").replace(/[,\s]+$/, "").trim();
    const key = itemNo + "|" + qty;
    if (seen.has(key)) continue;
    seen.add(key);
    skus.push({ item_no: itemNo, buyer_no: buyerNo, description, qty });
  }

  // Fallback: some extractors return the page as one long run with few line breaks.
  // Scan the whole text for "<item code> <description> <qty>Pc" style matches.
  if (!skus.length) {
    const scanText = text.split(/\r?\n/).map((l) => (/(pcs?|nos?)\b/i.test(l) ? unglue(l) : l)).join("\n");
    const re = /(\b\d{4,7})\s+([A-Za-z][^\n]{1,70}?)\s+(\d{1,6})\s*(?:pcs?|nos?)\b/gi;
    let m;
    while ((m = re.exec(scanText)) !== null) {
      const itemNo = m[1];
      let desc = m[2].replace(/\s{2,}/g, " ").trim();
      const qty = parseInt(m[3], 10);
      if (!qty) continue;
      let buyerNo = "";
      const parts = desc.split(/\s+/);
      const bIdx = parts.findIndex(looksLikeBuyerCode);
      if (bIdx >= 0) { buyerNo = parts[bIdx]; desc = parts.filter((_, k) => k !== bIdx).join(" "); }
      desc = desc.replace(/(buyer\s*no|packing.*|cbm.*)$/i, "").replace(/[,\s]+$/, "").trim();
      const key = itemNo + "|" + qty + "|" + desc;
      if (seen.has(key)) continue;
      seen.add(key);
      skus.push({ item_no: itemNo, buyer_no: buyerNo, description: desc, qty });
    }
  }

  return { pi, po, buyer, buyer_address: addr.join(", "), pi_date: piDate, ex_factory_date: exf, ship_date: ship, skus, _text: text };
}

async function parseInvoicePdf(buffer) {
  const attempts = [];

  // 1) Positional extraction — rebuilds the invoice's visual rows. Best for table layouts.
  if (positional) {
    try {
      const text = await positional.extractTextByPosition(buffer);
      if (text && text.trim()) {
        const parsed = parseInvoiceText(text);
        parsed._method = "positional";
        if (parsed.skus.length) return parsed;
        attempts.push(parsed);
      }
    } catch (e) { attempts.push({ skus: [], _text: "", _method: "positional failed: " + e.message }); }
  }

  // 2) Plain text extraction as a fallback.
  if (pdfParse) {
    try {
      const data = await pdfParse(buffer);
      if (data && data.text && data.text.trim()) {
        const parsed = parseInvoiceText(data.text);
        parsed._method = "plain text";
        if (parsed.skus.length) return parsed;
        attempts.push(parsed);
      }
    } catch (e) { attempts.push({ skus: [], _text: "", _method: "plain text failed: " + e.message }); }
  }

  if (!attempts.length) throw new Error("PDF support isn't available on this server");
  // Return the attempt that produced the most text, so the diagnostic is useful.
  attempts.sort((a, b) => String(b._text || "").length - String(a._text || "").length);
  return attempts[0];
}

module.exports = { parseInvoicePdf, parseInvoiceText };
