import type { ApiBill } from '../live/api';
import { Icon, SeverityBadge, aed, fmtDate } from './ui';

// The professional bill built from the advisor's entries. Printable, so "Save as PDF" works from the browser.
export function BillView({ bill, preview = false }: { bill: ApiBill; preview?: boolean }) {
  const isInvoice = bill.document === 'invoice';
  return (
    <article className="bill" aria-label={isInvoice ? 'Invoice' : 'Quote'}>
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
              <td>{l.position}</td>
              <td>
                <strong>{l.title}</strong>
                {l.detail && <small>{l.detail}</small>}
                {l.evidenceCount > 0 && (
                  <small>
                    <Icon name="camera" size={11} /> {l.evidenceCount} photo
                    {l.evidenceCount > 1 ? 's' : ''} on file
                  </small>
                )}
              </td>
              <td>
                <SeverityBadge level={l.severity} />
              </td>
              <td className="num">{aed(l.priceAed, 2)}</td>
              {!preview && (
                <td>
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
              <span>
                {bill.paymentStatus === 'received'
                  ? 'Paid'
                  : bill.paymentStatus === 'reversed'
                    ? 'Payment pending'
                    : 'Due on delivery'}
              </span>
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
        <button type="button" className="btn primary" onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </footer>
    </article>
  );
}
