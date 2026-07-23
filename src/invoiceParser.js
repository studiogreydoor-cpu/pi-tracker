// Reads the ERP's invoice-style Excel export (header info scattered in cells,
// SKU tables under an ITEM#/Qty header row, invoice repeated per page,
// item# and buyer# stacked in one cell). Falls back gracefully.
const XLSX = require("xlsx");

function normDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            // 2020-10-07 00:00:00
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/); // 28/04/20 day-first
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${String(+mo).padStart(2, "0")}-${String(+d).padStart(2, "0")}`;
  }
  const dt = new Date(s);
  return isNaN(dt) ? "" : dt.toISOString().slice(0, 10);
}

function cleanDesc(s) {
  // drop internal price lines like "INR :0" but keep genuine second lines (colour, etc.)
  return String(s || "")
    .split(/\n/)
    .map((x) => x.trim())
    .filter((x) => x && !/^inr\s*[:.]?\s*\d*$/i.test(x) && !/^us\s*\$/i.test(x))
    .join(" — ");
}

function parseInvoiceXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: true });
  const nrows = grid.length;
  const ncols = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const cell = (r, c) => (r >= 0 && r < nrows && c >= 0 && c < (grid[r] || []).length ? String(grid[r][c] ?? "").trim() : "");

  const findLabel = (label) => {
    for (let r = 0; r < nrows; r++)
      for (let c = 0; c < ncols; c++)
        if (cell(r, c).toLowerCase().includes(label.toLowerCase()))
          for (let cc = c + 1; cc < ncols; cc++) if (cell(r, cc)) return cell(r, cc);
    return "";
  };

  const pi = findLabel("PROFORMA #");
  const po = findLabel("ORDER No");
  const ship = normDate(findLabel("SHIP DATE"));
  let piDate = normDate(findLabel("DATE :"));
  const exf = normDate(findLabel("Ex-Factory")) || normDate(findLabel("Ex Factory"));

  // buyer block: cells directly under a "Buyer :" label, same column
  let buyer = "", addrParts = [];
  outer: for (let r = 0; r < nrows; r++)
    for (let c = 0; c < ncols; c++)
      if (/\bbuyer\s*:/i.test(cell(r, c))) {
        for (let rr = r + 1; rr < Math.min(r + 6, nrows); rr++) {
          const t = cell(rr, c);
          if (t && !/bank/i.test(t)) addrParts.push(t);
        }
        break outer;
      }
  if (addrParts.length) { buyer = addrParts[0]; }
  const buyerAddress = addrParts.slice(1).join(", ");

  // SKU tables: each starts at a header row containing ITEM# and Qty
  const skus = [];
  for (let r = 0; r < nrows; r++) {
    const join = Array.from({ length: ncols }, (_, c) => cell(r, c).toLowerCase()).join(" ");
    const isHeader = join.replace(/\s/g, "").includes("item#") || (join.includes("item") && join.includes("qty") && join.includes("description"));
    if (!isHeader) continue;
    const colOf = (...keys) => {
      for (let c = 0; c < ncols; c++) {
        const cv = cell(r, c).toLowerCase().replace(/\n/g, " ");
        if (keys.some((k) => cv.includes(k))) return c;
      }
      return null;
    };
    const cItem = colOf("item"), cDesc = colOf("description", "desc"), cQty = colOf("qty", "quantity");
    for (let rr = r + 1; rr < nrows; rr++) {
      const nextJoin = Array.from({ length: ncols }, (_, c) => cell(rr, c).toLowerCase()).join(" ");
      if (nextJoin.includes("proforma invoice") || nextJoin.replace(/\s/g, "").includes("item#")) break;
      const itemCell = cItem != null ? cell(rr, cItem) : "";
      const qnum = cQty != null ? cell(rr, cQty).replace(/[^0-9]/g, "") : "";
      if (itemCell && qnum) {
        const parts = itemCell.split(/\n/).map((p) => p.trim()).filter(Boolean);
        skus.push({
          item_no: parts[0] || itemCell,
          buyer_no: parts[1] || "",
          description: cDesc != null ? cleanDesc(cell(rr, cDesc)) : "",
          qty: parseInt(qnum, 10),
        });
      }
    }
  }
  // de-dupe repeated page listings
  const seen = new Set(), uniq = [];
  for (const s of skus) {
    const k = s.item_no + "|" + s.qty + "|" + s.description;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(s);
  }

  return { pi, po, buyer, buyer_address: buyerAddress, pi_date: piDate, ex_factory_date: exf, ship_date: ship, skus: uniq };
}

module.exports = { parseInvoiceXlsx };
