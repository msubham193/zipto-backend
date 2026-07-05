/**
 * Shared invoice builder + renderers (HTML for preview, PDF for download/email).
 * Used by: the customer invoice JSON endpoint, the email-on-delivery flow, and
 * the in-app "Download Invoice". One source of truth so every channel issues an
 * identical GST/tax invoice.
 */
// pdfkit is CommonJS (`export =`) and the project has esModuleInterop off, so a
// default import compiles to `pdfkit_1.default` (undefined at runtime). Use the
// CommonJS import form so `new PDFDocument()` resolves to the real constructor.
import PDFDocument = require('pdfkit');

export interface InvoiceData {
  invoice_number: string;
  invoice_date: Date | string;
  is_tax_invoice: boolean;
  seller: { name: string | null; gstin: string | null; address: string | null; state: string | null };
  buyer: { name: string | null; phone: string | null; gstin: string | null };
  booking_id: string;
  payment_id: string | null;
  description: string;
  charges: {
    delivery_charge: number | null;
    platform_fee: number | null;
    taxable_value: number | null;
    gst_percent: number | null;
    cgst_amount: number | null;
    sgst_amount: number | null;
    gst_amount: number | null;
  };
  total: number | null;
  payment_method: string | null;
  payment_status: string | null;
  note?: string;
}

interface TaxSettings {
  zipto_gstin?: string;
  zipto_legal_name?: string;
  zipto_gst_state?: string;
  zipto_invoice_address?: string;
}

/**
 * Build the canonical invoice object from a booking + its payment + tax config.
 * Pure — no DB access, no auth. Callers fetch the rows and pass them in.
 */
export function buildInvoiceData(booking: any, payment: any, tax: TaxSettings): InvoiceData {
  const bd = (booking?.fare_breakdown || {}) as any;
  const customerGstin = booking?.customer_gstin || null;
  const isTaxInvoice = !!customerGstin && !!tax.zipto_gstin;

  return {
    invoice_number: `ZPT-${String(booking.id).slice(0, 8).toUpperCase()}`,
    invoice_date: payment?.created_at ?? booking?.completion_time ?? new Date(),
    is_tax_invoice: isTaxInvoice,
    seller: {
      name: tax.zipto_legal_name ?? 'Zipto Hyperlogistics Pvt. Ltd.',
      gstin: tax.zipto_gstin || null,
      address: tax.zipto_invoice_address || null,
      state: tax.zipto_gst_state ?? null,
    },
    buyer: {
      name: booking?.name || booking?.customer?.name || null,
      phone: booking?.mobile_number || booking?.customer?.phone || null,
      gstin: customerGstin,
    },
    booking_id: booking.id,
    payment_id: payment?.id ?? null,
    description: `Delivery service${booking?.pickup_address ? ` (${booking.pickup_address} → ${booking.drop_address})` : ''}`,
    charges: {
      delivery_charge: bd.delivery_charge ?? null,
      platform_fee: bd.platform_fee ?? 0,
      // Taxable value = delivery + platform (GST base). Fall back for old orders.
      taxable_value:
        bd.taxable_value ??
        ((Number(bd.delivery_charge) || 0) + (Number(bd.platform_fee) || 0)),
      gst_percent: bd.gst_percent ?? 0,
      cgst_amount: bd.cgst_amount ?? 0,
      sgst_amount: bd.sgst_amount ?? 0,
      gst_amount: bd.gst_amount ?? 0,
    },
    total: payment?.amount != null ? Number(payment.amount) : (booking?.final_fare ?? booking?.estimated_fare ?? null),
    payment_method: payment?.payment_method ?? null,
    payment_status: payment?.payment_status ?? null,
    note:
      customerGstin && !tax.zipto_gstin
        ? 'Seller GSTIN not yet configured — set it in Admin → GST settings to issue a valid tax invoice.'
        : undefined,
  };
}

const inr = (n: number | null | undefined) =>
  `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
const fmtDate = (d: Date | string) => {
  try { return new Date(d).toLocaleDateString('en-IN', { dateStyle: 'long' } as any); }
  catch { return String(d); }
};

/** Render a print-ready (and email-ready) HTML invoice. */
export function renderInvoiceHtml(inv: InvoiceData): string {
  const c = inv.charges;
  const title = inv.is_tax_invoice ? 'TAX INVOICE' : 'INVOICE';
  const row = (label: string, val: string, strong = false) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(label)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right${strong ? ';font-weight:700' : ''}">${val}</td></tr>`;
  const half = (Number(c.gst_percent) || 0) / 2;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(inv.invoice_number)}</title>
<style>
  *{box-sizing:border-box} body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;margin:0;padding:24px;background:#f8fafc}
  .wrap{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1d4ed8;padding-bottom:16px;margin-bottom:24px}
  .brand{font-size:26px;font-weight:800;color:#1d4ed8;letter-spacing:-.5px}
  .doc{font-size:18px;font-weight:700;text-align:right}
  .muted{color:#64748b;font-size:12px;line-height:1.5}
  .grid{display:flex;gap:24px;margin-bottom:24px;flex-wrap:wrap}
  .box{flex:1;min-width:200px;font-size:13px;line-height:1.6}
  .box h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#64748b}
  table{width:100%;border-collapse:collapse;font-size:13px;border:1px solid #eee;border-radius:8px;overflow:hidden}
  th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #eee}
  .total td{padding:12px;background:#eef2ff;color:#1d4ed8;font-weight:800;font-size:15px}
  .note{margin-top:16px;font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;padding:10px;border-radius:8px}
  .foot{margin-top:28px;text-align:center;color:#94a3b8;font-size:11px}
  .btn{display:inline-block;background:#1d4ed8;color:#fff;border:0;padding:11px 26px;border-radius:8px;font-size:14px;font-family:inherit;font-weight:600;cursor:pointer;text-decoration:none}
  @media print{body{padding:0;background:#fff}.wrap{border:0;border-radius:0}.noprint{display:none}}
</style></head>
<body><div class="wrap">
  <div class="head">
    <div>
      <div class="brand">bookfleet</div>
      <div class="muted">${esc(inv.seller.name || 'Zipto Hyperlogistics Pvt. Ltd.')}</div>
      ${inv.seller.address ? `<div class="muted">${esc(inv.seller.address)}</div>` : ''}
      ${inv.seller.state ? `<div class="muted">State: ${esc(inv.seller.state)}</div>` : ''}
      ${inv.seller.gstin ? `<div class="muted">GSTIN: ${esc(inv.seller.gstin)}</div>` : ''}
    </div>
    <div>
      <div class="doc">${title}</div>
      <div class="muted">No: ${esc(inv.invoice_number)}</div>
      <div class="muted">Date: ${esc(fmtDate(inv.invoice_date))}</div>
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <h4>Billed To</h4>
      <div><strong>${esc(inv.buyer.name || 'Customer')}</strong></div>
      ${inv.buyer.phone ? `<div>${esc(inv.buyer.phone)}</div>` : ''}
      ${inv.buyer.gstin ? `<div>GSTIN: ${esc(inv.buyer.gstin)}</div>` : '<div class="muted">B2C (no GSTIN)</div>'}
    </div>
    <div class="box">
      <h4>Order</h4>
      <div>Booking: ${esc(String(inv.booking_id).slice(0, 8).toUpperCase())}</div>
      <div>Payment: ${esc((inv.payment_method || '').toUpperCase())} · ${esc(inv.payment_status || '')}</div>
    </div>
  </div>

  <table>
    <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      <tr><td colspan="2" style="padding:8px 12px;border-bottom:1px solid #eee;color:#64748b">${esc(inv.description)}</td></tr>
      ${row('Delivery charge', inr(c.delivery_charge))}
      ${(Number(c.platform_fee) > 0) ? row('Platform fee', inr(c.platform_fee)) : ''}
      ${row('Taxable value', inr(c.taxable_value))}
      ${(Number(c.cgst_amount) > 0) ? row(`CGST (${half}%)`, inr(c.cgst_amount)) : ''}
      ${(Number(c.sgst_amount) > 0) ? row(`SGST (${half}%)`, inr(c.sgst_amount)) : ''}
      ${(Number(c.gst_amount) > 0 && !(Number(c.cgst_amount) > 0)) ? row(`GST (${Number(c.gst_percent) || 0}%)`, inr(c.gst_amount)) : ''}
      <tr class="total"><td>Total Paid</td><td style="text-align:right">${inr(inv.total)}</td></tr>
    </tbody>
  </table>

  ${inv.note ? `<div class="note">${esc(inv.note)}</div>` : ''}

  <div class="noprint" style="text-align:center;margin-top:22px">
    <button type="button" class="btn" onclick="window.print()">Download / Print PDF</button>
    <p class="muted" style="margin-top:10px">Tip: choose “Save as PDF” in the print dialog. On phones, you can also use your browser menu → Print / Share.</p>
  </div>
  <div class="foot">This is a computer-generated invoice and does not require a signature.<br/>© ${new Date().getFullYear()} Zipto Hyperlogistics Pvt. Ltd.</div>
  <script>
    // Some in-app browsers strip inline handlers; bind defensively too.
    document.addEventListener('DOMContentLoaded', function () {
      var b = document.querySelector('.btn');
      if (b) b.addEventListener('click', function () { try { window.print(); } catch (e) {} });
    });
  </script>
</div></body></html>`;
}

// Standard PDF fonts don't carry the ₹ glyph, so use "Rs" in the PDF.
const rs = (n: number | null | undefined) =>
  `Rs ${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A filesystem-safe filename for the invoice PDF. */
export function invoiceFileName(inv: InvoiceData): string {
  return `${inv.invoice_number.replace(/[^A-Za-z0-9_-]/g, '')}.pdf`;
}

/**
 * Draw one invoice onto the CURRENT page of an already-open PDFDocument.
 * Shared by buildInvoicePdf() (one invoice, one PDF) and buildInvoicesPdf()
 * (many invoices, one PDF — a new page per invoice) so the two never drift.
 */
function drawInvoicePage(doc: PDFKit.PDFDocument, inv: InvoiceData): void {
      const L = 40, R = 555; // content bounds (A4 width 595 − margins)
      const W = R - L;
      const BLUE = '#1d4ed8', DARK = '#0f172a', MUTED = '#64748b';
      const c = inv.charges;

      // ── Header ──
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(24).text('bookfleet', L, 40);
      const title = inv.is_tax_invoice ? 'TAX INVOICE' : 'INVOICE';
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(16).text(title, L, 42, { width: W, align: 'right' });
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
        .text(`No: ${inv.invoice_number}`, L, 64, { width: W, align: 'right' })
        .text(`Date: ${fmtDate(inv.invoice_date)}`, L, 76, { width: W, align: 'right' });

      // ── Seller ──
      doc.fillColor(MUTED).font('Helvetica').fontSize(9);
      let y = 70;
      const sline = (t?: string | null) => { if (t) { doc.text(t, L, y, { width: 300 }); y += doc.heightOfString(t, { width: 300 }); } };
      sline(inv.seller.name || 'Zipto Hyperlogistics Pvt. Ltd.');
      sline(inv.seller.address);
      sline(inv.seller.state ? `State: ${inv.seller.state}` : null);
      sline(inv.seller.gstin ? `GSTIN: ${inv.seller.gstin}` : null);

      // ── Rule ──
      y = Math.max(y, 120) + 8;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(2).strokeColor(BLUE).stroke();
      y += 16;

      // ── Billed To / Order ──
      const colX = 320;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('BILLED TO', L, y).text('ORDER', colX, y);
      y += 14;
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(11).text(inv.buyer.name || 'Customer', L, y, { width: 260 });
      doc.font('Helvetica').fontSize(9).fillColor(DARK)
        .text(`Booking: ${String(inv.booking_id).slice(0, 8).toUpperCase()}`, colX, y);
      let yb = y + 14, yo = y + 14;
      if (inv.buyer.phone) { doc.text(inv.buyer.phone, L, yb, { width: 260 }); yb += 12; }
      doc.text(inv.buyer.gstin ? `GSTIN: ${inv.buyer.gstin}` : 'B2C (no GSTIN)', L, yb, { width: 260 }); yb += 12;
      doc.text(`Payment: ${(inv.payment_method || '').toUpperCase()} - ${inv.payment_status || ''}`, colX, yo); yo += 12;
      y = Math.max(yb, yo) + 12;

      // ── Description ──
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(inv.description, L, y, { width: W });
      y += doc.heightOfString(inv.description, { width: W }) + 10;

      // ── Line items ──
      doc.rect(L, y - 2, W, 18).fill('#f1f5f9');
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(10)
        .text('Description', L + 6, y + 2, { width: 360 })
        .text('Amount', L, y + 2, { width: W - 6, align: 'right' });
      y += 20;

      const drawRow = (label: string, val: string) => {
        doc.font('Helvetica').fontSize(10).fillColor(DARK)
          .text(label, L + 6, y, { width: 360 })
          .text(val, L, y, { width: W - 6, align: 'right' });
        y += 17;
        doc.moveTo(L, y - 3).lineTo(R, y - 3).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
      };

      const half = (Number(c.gst_percent) || 0) / 2;
      drawRow('Delivery charge', rs(c.delivery_charge));
      if (Number(c.platform_fee) > 0) drawRow('Platform fee', rs(c.platform_fee));
      drawRow('Taxable value', rs(c.taxable_value));
      if (Number(c.cgst_amount) > 0) drawRow(`CGST (${half}%)`, rs(c.cgst_amount));
      if (Number(c.sgst_amount) > 0) drawRow(`SGST (${half}%)`, rs(c.sgst_amount));
      if (Number(c.gst_amount) > 0 && !(Number(c.cgst_amount) > 0)) drawRow(`GST (${Number(c.gst_percent) || 0}%)`, rs(c.gst_amount));

      // ── Total ──
      y += 4;
      doc.rect(L, y - 2, W, 24).fill('#eef2ff');
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(12)
        .text('Total Paid', L + 6, y + 4, { width: 360 })
        .text(rs(inv.total), L, y + 4, { width: W - 6, align: 'right' });
      y += 34;

      if (inv.note) {
        doc.fillColor('#b45309').font('Helvetica').fontSize(9).text(inv.note, L, y, { width: W });
      }

      // ── Footer ──
      doc.fillColor(MUTED).font('Helvetica').fontSize(8)
        .text('This is a computer-generated invoice and does not require a signature.', L, 788, { width: W, align: 'center' })
        .text(`© ${new Date().getFullYear()} Zipto Hyperlogistics Pvt. Ltd.`, L, 800, { width: W, align: 'center' });
}

/**
 * Render a single invoice as a real PDF (Buffer) — used for the in-app
 * download (served with Content-Disposition: attachment) and the email
 * attachment. Reliable on every phone, unlike window.print() in an in-app
 * browser.
 */
export function buildInvoicePdf(inv: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      drawInvoicePage(doc, inv);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Render MANY invoices into a SINGLE combined PDF — one invoice per page, in
 * the order given. Used by the admin GST report's "Download all as PDF".
 * Individual per-order invoice download is unaffected — this is additive.
 */
export function buildInvoicesPdf(invoices: InvoiceData[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      if (!invoices.length) {
        resolve(Buffer.from(''));
        return;
      }
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      invoices.forEach((inv, i) => {
        if (i > 0) doc.addPage();
        drawInvoicePage(doc, inv);
      });
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ─── GSTR-1 export (PDF) — for the CA / IT return filing ───────────────────

export interface Gstr1B2BRow {
  gstin: string;
  name: string;
  invoice_no: string;
  invoice_date: string; // already formatted, e.g. "05-07-2026"
  invoice_value: number;
  pos: string;
  rate: number;
  taxable_value: number;
  cgst: number;
  sgst: number;
}

export interface Gstr1B2csRow {
  pos: string;
  rate: number;
  taxable_value: number;
  cgst: number;
  sgst: number;
}

interface Gstr1Col {
  key: string;
  label: string;
  w: number;
  right?: boolean;
}

/**
 * Render the GSTR-1 export as a PDF — two sections: B2B (invoice-level, one
 * row per registered-GSTIN customer) and B2CS (consolidated by place of
 * supply + rate, per GSTR-1 rules for unregistered/B2C customers — never
 * invoice-level). Landscape A4 so the wide tables stay readable.
 */
export function buildGstr1Pdf(b2b: Gstr1B2BRow[], b2cs: Gstr1B2csRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const L = 30;
      const R = doc.page.width - 30;
      const BOTTOM = doc.page.height - 40;
      const BLUE = '#1d4ed8', DARK = '#0f172a', MUTED = '#64748b';
      const money = (n: number) =>
        `Rs ${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      let y = 40;

      const drawTitle = (text: string) => {
        doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(16).text(text, L, y, { width: R - L });
        y += 26;
      };

      const drawHeaderRow = (cols: Gstr1Col[]) => {
        doc.rect(L, y - 2, R - L, 18).fill('#eef2ff');
        let x = L;
        doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(8);
        for (const c of cols) {
          doc.text(c.label, x + 3, y + 3, { width: c.w - 6, align: c.right ? 'right' : 'left' });
          x += c.w;
        }
        y += 20;
      };

      const ensureSpace = (cols: Gstr1Col[], continuedTitle: string) => {
        if (y > BOTTOM) {
          doc.addPage();
          y = 40;
          drawTitle(continuedTitle);
          drawHeaderRow(cols);
        }
      };

      const drawRow = (cols: Gstr1Col[], vals: Record<string, string>) => {
        let x = L;
        doc.fillColor(DARK).font('Helvetica').fontSize(8);
        for (const c of cols) {
          doc.text(vals[c.key] ?? '', x + 3, y, { width: c.w - 6, align: c.right ? 'right' : 'left' });
          x += c.w;
        }
        y += 16;
        doc.moveTo(L, y - 2).lineTo(R, y - 2).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
      };

      // ── B2B — invoice-level ──
      const b2bCols: Gstr1Col[] = [
        { key: 'gstin', label: 'GSTIN', w: 95 },
        { key: 'name', label: 'Receiver Name', w: 100 },
        { key: 'invoice_no', label: 'Invoice No.', w: 75 },
        { key: 'invoice_date', label: 'Date', w: 60 },
        { key: 'invoice_value', label: 'Invoice Value', w: 75, right: true },
        { key: 'pos', label: 'Place of Supply', w: 85 },
        { key: 'rate', label: 'Rate', w: 40, right: true },
        { key: 'taxable_value', label: 'Taxable Value', w: 80, right: true },
        { key: 'cgst', label: 'CGST', w: 68, right: true },
        { key: 'sgst', label: 'SGST', w: 68, right: true },
      ];

      drawTitle('GSTR-1 Export — B2B Invoices (Registered Customers)');
      if (!b2b.length) {
        doc.fillColor(MUTED).font('Helvetica').fontSize(10)
          .text('No B2B invoices for the selected filters.', L, y);
        y += 20;
      } else {
        drawHeaderRow(b2bCols);
        for (const row of b2b) {
          ensureSpace(b2bCols, 'GSTR-1 Export — B2B Invoices (contd.)');
          drawRow(b2bCols, {
            gstin: row.gstin,
            name: row.name,
            invoice_no: row.invoice_no,
            invoice_date: row.invoice_date,
            invoice_value: money(row.invoice_value),
            pos: row.pos,
            rate: `${row.rate}%`,
            taxable_value: money(row.taxable_value),
            cgst: money(row.cgst),
            sgst: money(row.sgst),
          });
        }
      }

      // ── B2CS — consolidated by place of supply + rate ──
      doc.addPage();
      y = 40;
      const b2csCols: Gstr1Col[] = [
        { key: 'pos', label: 'Place of Supply', w: 160 },
        { key: 'rate', label: 'Rate', w: 60, right: true },
        { key: 'taxable_value', label: 'Taxable Value', w: 130, right: true },
        { key: 'cgst', label: 'CGST', w: 120, right: true },
        { key: 'sgst', label: 'SGST', w: 120, right: true },
      ];

      drawTitle('GSTR-1 Export — B2CS (Consolidated — Unregistered/B2C Customers)');
      if (!b2cs.length) {
        doc.fillColor(MUTED).font('Helvetica').fontSize(10)
          .text('No B2C supplies for the selected filters.', L, y);
        y += 20;
      } else {
        drawHeaderRow(b2csCols);
        for (const row of b2cs) {
          ensureSpace(b2csCols, 'GSTR-1 Export — B2CS (contd.)');
          drawRow(b2csCols, {
            pos: row.pos,
            rate: `${row.rate}%`,
            taxable_value: money(row.taxable_value),
            cgst: money(row.cgst),
            sgst: money(row.sgst),
          });
        }
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
