interface Metric {
  label: string;
  value: string;
}

export function MetricList({ rows }: { rows: Metric[] }) {
  return (
    <dl className="metrics">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className="mono">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
