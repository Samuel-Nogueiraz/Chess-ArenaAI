export function BrandMark() {
  return (
    <div className="brand">
      <svg className="brand-glyph" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <rect className="brand-glyph-bg" width="32" height="32" rx="7" />
        <path
          className="brand-glyph-fg"
          d="M10.2 25.5h12.6l.5-2.4c.5-2.8.3-6.1-1.1-8.9-1.1-2.2-3-3.8-5.4-4.5l.4-2.1-2.6 1.7c-.5-.3-1.1-.5-1.7-.5l-.2 1.8-4.1 5.4c-.5.8-.4 1.9.3 2.5l1 .9c.7.6 1.8.6 2.5-.1l1.9-1.9c-1.1 1.3-2.3 2.8-2.6 4.6l-.2 1.2z"
        />
        <rect className="brand-glyph-fg" x="9" y="25.5" width="15" height="2.2" rx="1" />
        <circle className="brand-glyph-eye" cx="14.4" cy="12.6" r="0.9" />
      </svg>
      <div className="brand-text">
        <h1 className="brand-name">JEV Chess Arena</h1>
        <span className="brand-sub">Deep Blue · torneio entre máquinas</span>
      </div>
    </div>
  );
}
