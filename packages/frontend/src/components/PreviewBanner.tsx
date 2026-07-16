/** Marks a deferred page whose data is still the in-memory simulator (#19/#20),
 * so nothing simulated reads as operational. */
export function PreviewBanner(props: { note?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '8px',
        padding: '8px 12px',
        background: 'var(--amber-bg)',
        border: '1px solid var(--amber)',
        'border-radius': '8px',
        font: "500 11.5px 'Geist',sans-serif",
        color: 'var(--amber)',
      }}
    >
      <span style="width:7px;height:7px;border-radius:50%;background:var(--amber);flex:none" />
      Preview — simulated data.{' '}
      <span style="color:var(--text3);font-weight:400">
        {props.note ?? 'Live figures land in a later change; write-controls here are demo-only.'}
      </span>
    </div>
  );
}
