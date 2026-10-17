interface ModeBadgeProps {
  mode: "demo" | "live";
}

export function ModeBadge({ mode }: ModeBadgeProps) {
  const demo = mode === "demo";
  return (
    <p className={`mode-badge ${demo ? "demo" : "live"}`}>
      <span className="mode-dot" aria-hidden="true" />
      <span className="mode-key">{demo ? "DEMO" : "LOCAL"}</span>
      <span className="mode-sep" aria-hidden="true">·</span>
      <span className="mode-text">{demo ? "dados simulados, sem chaves" : "chaves só no servidor"}</span>
    </p>
  );
}
