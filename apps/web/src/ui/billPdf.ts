import type { ApiBill } from '../live/api';
import { aed, fmtDate } from './ui';

// Generate a real, downloadable PDF without opening the browser's print dialog.
export async function downloadBillPdf(bill: ApiBill): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const width = doc.internal.pageSize.getWidth();
  const bottom = doc.internal.pageSize.getHeight() - 18;
  const left = 18;
  let y = 20;

  const ensure = (height: number) => {
    if (y + height > bottom) {
      doc.addPage();
      y = 20;
    }
  };
  const text = (
    value: string,
    options: {
      bold?: boolean;
      size?: number;
      color?: [number, number, number];
      indent?: number;
    } = {},
  ) => {
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    doc.setFont('helvetica', options.bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...(options.color ?? [63, 78, 98]));
    const lines = doc.splitTextToSize(value || '—', width - left * 2 - indent) as string[];
    const lineHeight = size * 0.46;
    for (const line of lines) {
      ensure(lineHeight);
      doc.text(line, left + indent, y);
      y += lineHeight;
    }
  };
  const section = (title: string) => {
    ensure(16);
    y += 5;
    doc.setDrawColor(220, 230, 240);
    doc.line(left, y, width - left, y);
    y += 7;
    text(title.toUpperCase(), { bold: true, size: 10, color: [0, 105, 159] });
    y += 2;
  };

  text('AVC', { bold: true, size: 19, color: [0, 161, 242] });
  text(bill.business.name, { bold: true, size: 13, color: [29, 42, 59] });
  text(bill.business.branch);
  y += 5;
  text(bill.document === 'invoice' ? 'INVOICE' : 'QUOTE', {
    bold: true,
    size: 18,
    color: [29, 42, 59],
  });
  text(`${bill.number}  |  ${fmtDate(new Date(bill.issuedAt).getTime())}`);
  section('Customer');
  text(bill.customer.name, { bold: true });
  if (bill.customer.email) text(bill.customer.email);
  text(bill.customer.mobile);
  section('Vehicle');
  text(bill.vehicle.title, { bold: true });
  if (bill.vehicle.plate) text(bill.vehicle.plate);
  text(`${bill.vehicle.mileageKm.toLocaleString()} km`);
  text(`Advisor: ${bill.advisor}`);
  section('Work breakdown');
  if (!bill.lines.length) text('No lines yet.');
  for (const line of bill.lines) {
    ensure(22);
    text(`${line.position}. ${line.title}`, { bold: true, size: 11, color: [29, 42, 59] });
    if (line.detail) text(line.detail, { indent: 4 });
    text(
      `Priority: ${line.severity}  |  Status: ${line.decision === 'pending' ? 'awaiting you' : line.decision}  |  ${aed(line.priceAed, 2)}`,
      { size: 9, indent: 4 },
    );
    if (line.evidenceCount)
      text(`${line.evidenceCount} photo${line.evidenceCount === 1 ? '' : 's'} on file`, {
        size: 9,
        indent: 4,
      });
    y += 4;
  }
  section('Summary');
  text(`Quoted: ${aed(bill.totals.quotedAed, 2)}`);
  text(`Approved by you: ${aed(bill.totals.approvedAed, 2)}`);
  if (bill.totals.declinedAed > 0)
    text(`Declined, not charged: ${aed(bill.totals.declinedAed, 2)}`);
  const label =
    bill.paymentStatus === 'received'
      ? 'Paid'
      : bill.paymentStatus === 'reversed'
        ? 'Payment pending'
        : 'Due on delivery';
  text(`${label}: ${aed(bill.totals.approvedAed, 2)}`, {
    bold: true,
    size: 12,
    color: [29, 42, 59],
  });
  section('What happens next');
  bill.instructions.forEach((item, index) => text(`${index + 1}. ${item}`));
  section('Terms');
  bill.terms.forEach((item) => text(`- ${item}`));
  const filename = bill.number.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'bill';
  doc.save(`${filename}.pdf`);
}
