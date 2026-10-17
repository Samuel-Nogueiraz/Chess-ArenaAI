interface ThinkingIndicatorProps {
  label?: string;
}

export function ThinkingIndicator({ label = "pensando" }: ThinkingIndicatorProps) {
  return (
    <span className="thinking">
      <span className="thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-label">{label}</span>
    </span>
  );
}
