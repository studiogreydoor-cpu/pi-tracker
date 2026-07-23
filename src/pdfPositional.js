// Reads a PDF by pulling every text fragment together with its x/y position on the page,
// then rebuilding the visual rows. This is far more reliable for table-style invoices than
// plain text extraction, which glues neighbouring cells together or reorders them.

async function extractRows(buffer) {
  // pdfjs-dist ships as ESM; load it dynamically so this file can stay CommonJS.
  let pdfjs;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (e) {
    try { pdfjs = await import("pdfjs-dist/build/pdf.mjs"); }
    catch (e2) { throw new Error("PDF engine unavailable: " + (e2.message || e.message)); }
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const frags = content.items
      .map((it) => ({
        str: String(it.str || ""),
        x: it.transform ? it.transform[4] : 0,
        y: it.transform ? it.transform[5] : 0,
        w: it.width || 0,
      }))
      .filter((f) => f.str.trim());

    // Group fragments into visual rows by their y position (PDF y grows upwards).
    const rows = [];
    const TOL = 3.2; // points; tolerant of slight baseline differences within a row
    for (const f of frags) {
      let row = rows.find((r) => Math.abs(r.y - f.y) <= TOL);
      if (!row) { row = { y: f.y, items: [] }; rows.push(row); }
      row.items.push(f);
    }
    rows.sort((a, b) => b.y - a.y); // top of page first

    const lines = rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      // Join cells with a space; add a wider gap marker when columns are far apart,
      // which keeps "column-order" parsing working too.
      let out = "";
      let prevEnd = null;
      for (const it of r.items) {
        const gap = prevEnd == null ? 0 : it.x - prevEnd;
        if (out) out += gap > 12 ? "   " : (gap > 1.5 ? " " : "");
        out += it.str;
        prevEnd = it.x + it.w;
      }
      return out.replace(/\s+$/, "");
    });
    pages.push(lines);
  }
  try { await doc.destroy(); } catch (e) {}
  return pages;
}

async function extractTextByPosition(buffer) {
  const pages = await extractRows(buffer);
  return pages.map((lines) => lines.join("\n")).join("\n");
}

module.exports = { extractTextByPosition, extractRows };
