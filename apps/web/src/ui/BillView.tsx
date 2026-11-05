import type { ApiBill } from '../live/api';
import { useState } from 'react';
import { Icon, SeverityBadge, aed, fmtDate } from './ui';

// The professional bill built from the advisor's entries. Printable, so "Save as PDF" works from the browser.
export function BillView({
  bill,
  preview = false,
  customer = false,
}: {
  bill: ApiBill;
  preview?: boolean;
  customer?: boolean;
}) {
  const isInvoice = bill.document === 'invoice';
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const paymentLabel =
    bill.paymentStatus === 'received'
      ? 'Paid'
      : bill.paymentStatus === 'reversed'
        ? 'Payment pending'
        : 'Due on delivery';
  return (
    <article
      className={customer ? 'bill customer-bill' : 'bill'}
      aria-label={isInvoice ? 'Invoice' : 'Quote'}
    >
      <header className="bill-head">
        <div className="bill-brand">
          <span className="brand-mark">AVC</span>
          <div>
            <strong>{bill.business.name}</strong>
            <span>{bill.business.branch}</span>
          </div>
        </div>
        <div className="bill-id">
          <h2>{isInvoice ? 'Invoice' : preview ? 'Quote preview' : 'Quote'}</h2>
          <span>{bill.number}</span>
          <span>{fmtDate(new Date(bill.issuedAt).getTime())}</span>
        </div>
      </header>

      {customer && (
        <section className="bill-summary" aria-label="Payment summary">
          <div>
            <span>{paymentLabel}</span>
            <strong>{aed(bill.totals.approvedAed, 2)}</strong>
            <small>Based on the work you approved</small>
          </div>
          <span className="bill-summary-mark" aria-hidden="true">
            <Icon name="check" size={20} />
          </span>
        </section>
      )}

      <section className="bill-parties">
        <div>
          <h3>Customer</h3>
          <p>
            <strong>{bill.customer.name}</strong>
          </p>
          {bill.customer.email && <p>{bill.customer.email}</p>}
          <p>{bill.customer.mobile}</p>
        </div>
        <div>
          <h3>Vehicle</h3>
          <p>
            <strong>{bill.vehicle.title}</strong>
          </p>
          {bill.vehicle.plate && <p>{bill.vehicle.plate}</p>}
          <p>{bill.vehicle.mileageKm.toLocaleString()} km</p>
        </div>
        <div>
          <h3>Your advisor</h3>
          <p>
            <strong>{bill.advisor}</strong>
          </p>
        </div>
      </section>

      {customer && (
        <div className="bill-section-heading">
          <span>01</span>
          <div>
            <h3>Work breakdown</h3>
            <p>Every item, clearly accounted for</p>
          </div>
        </div>
      )}
      <table className="bill-lines">
        <thead>
          <tr>
            <th>#</th>
            <th>Work</th>
            <th>Priority</th>
            <th className="num">Price</th>
            {!preview && <th>Status</th>}
          </tr>
        </thead>
        <tbody>
          {bill.lines.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No lines yet.
              </td>
            </tr>
          )}
          {bill.lines.map((l) => (
            <tr key={l.position} className={l.decision === 'rejected' ? 'declined' : ''}>
              <td data-label="Item">{l.position}</td>
              <td data-label="Work">
                <strong>{l.title}</strong>
                {l.detail && <small>{l.detail}</small>}
                {l.evidenceCount > 0 && (
                  <small>
                    <Icon name="camera" size={11} /> {l.evidenceCount} photo
                    {l.evidenceCount > 1 ? 's' : ''} on file
                  </small>
                )}
              </td>
              <td data-label="Priority">
                <SeverityBadge level={l.severity} />
              </td>
              <td className="num" data-label="Price">
                {aed(l.priceAed, 2)}
              </td>
              {!preview && (
                <td data-label="Status">
                  <span className={`decision d-${l.decision}`}>
                    {l.decision === 'pending' ? 'awaiting you' : l.decision}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <section className="bill-totals">
        <div>
          <span>{preview ? 'Total' : 'Quoted'}</span>
          <strong>{aed(bill.totals.quotedAed, 2)}</strong>
        </div>
        {!preview && (
          <>
            <div>
              <span>Approved by you</span>
              <strong>{aed(bill.totals.approvedAed, 2)}</strong>
            </div>
            {bill.totals.declinedAed > 0 && (
              <div className="muted">
                <span>Declined, not charged</span>
                <strong>{aed(bill.totals.declinedAed, 2)}</strong>
              </div>
            )}
            <div className="grand">
              <span>{paymentLabel}</span>
              <strong>{aed(bill.totals.approvedAed, 2)}</strong>
            </div>
          </>
        )}
      </section>

      <section className="bill-notes">
        <h3>What happens next</h3>
        <ol>
          {bill.instructions.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ol>
        <h3>Terms</h3>
        <ul>
          {bill.terms.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>

      <footer className="bill-actions no-print">
        {customer ? (
          <>
            {downloadError && (
              <p className="banner banner-critical" role="alert">
                Could not download your PDF. Please try again.
              </p>
            )}
            <button
              type="button"
              className="btn primary"
              disabled={downloading}
              onClick={async () => {
                setDownloading(true);
                setDownloadError(false);
                try {
                  const { downloadBillPdf } = await import('./billPdf');
                  await downloadBillPdf(bill);
                } catch {
                  setDownloadError(true);
                } finally {
                  setDownloading(false);
                }
              }}
            >
              <Icon name="download" size={17} /> {downloading ? 'Preparing PDF…' : 'Download PDF'}
            </button>
          </>
        ) : (
          <button type="button" className="btn primary" onClick={() => window.print()}>
            Print or save as PDF
          </button>
        )}
      </footer>
    </article>
  );
}
