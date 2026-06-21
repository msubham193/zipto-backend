/**
 * Shared invoice builder + print-ready HTML renderer.
 * Used by: the customer invoice JSON endpoint, the email-on-delivery flow, and
 * the in-app "Download Invoice" (browser view). One source of truth so every
 * channel issues an identical GST/tax invoice.
 */

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
        ? 'Zipto GSTIN not yet configured — set it in Admin → GST settings to issue a valid tax invoice.'
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
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #16a34a;padding-bottom:16px;margin-bottom:24px}
  .brand{font-size:26px;font-weight:800;color:#16a34a;letter-spacing:-.5px}
  .doc{font-size:18px;font-weight:700;text-align:right}
  .muted{color:#64748b;font-size:12px;line-height:1.5}
  .grid{display:flex;gap:24px;margin-bottom:24px;flex-wrap:wrap}
  .box{flex:1;min-width:200px;font-size:13px;line-height:1.6}
  .box h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#64748b}
  table{width:100%;border-collapse:collapse;font-size:13px;border:1px solid #eee;border-radius:8px;overflow:hidden}
  th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #eee}
  .total td{padding:12px;background:#f0fdf4;font-weight:800;font-size:15px}
  .note{margin-top:16px;font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;padding:10px;border-radius:8px}
  .foot{margin-top:28px;text-align:center;color:#94a3b8;font-size:11px}
  .btn{display:inline-block;background:#16a34a;color:#fff;border:0;padding:11px 26px;border-radius:8px;font-size:14px;cursor:pointer;text-decoration:none}
  @media print{body{padding:0;background:#fff}.wrap{border:0;border-radius:0}.noprint{display:none}}
</style></head>
<body><div class="wrap">
  <div class="head">
    <div>
      <div class="brand">ZIPTO</div>
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
      ${row('Delivery charge (taxable value)', inr(c.delivery_charge))}
      ${(Number(c.platform_fee) > 0) ? row('Platform fee', inr(c.platform_fee)) : ''}
      ${(Number(c.cgst_amount) > 0) ? row(`CGST (${half}%)`, inr(c.cgst_amount)) : ''}
      ${(Number(c.sgst_amount) > 0) ? row(`SGST (${half}%)`, inr(c.sgst_amount)) : ''}
      ${(Number(c.gst_amount) > 0 && !(Number(c.cgst_amount) > 0)) ? row(`GST (${Number(c.gst_percent) || 0}%)`, inr(c.gst_amount)) : ''}
      <tr class="total"><td>Total Paid</td><td style="text-align:right">${inr(inv.total)}</td></tr>
    </tbody>
  </table>

  ${inv.note ? `<div class="note">${esc(inv.note)}</div>` : ''}

  <div class="noprint" style="text-align:center;margin-top:22px">
    <a class="btn" href="javascript:window.print()">Download / Print PDF</a>
  </div>
  <div class="foot">This is a computer-generated invoice and does not require a signature.<br/>© ${new Date().getFullYear()} Zipto Hyperlogistics Pvt. Ltd.</div>
</div></body></html>`;
}
