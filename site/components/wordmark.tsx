const OPEN = '#a1a1aa';
const QUEUE = '#f4f4f5';
const SHADOW = '#3f3f46';
const ACCENT = '#4ade80';

/**
 * Blocky two-tone wordmark — light outer letterforms with dark inner
 * shadow blocks, drawn on a 24-unit letter grid with a 30-unit pitch.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 264 42"
      fill="none"
      aria-label="openqueue"
      role="img"
      className={className}
    >
      {/* o */}
      <path d="M18 30H6V18H18V30Z" fill={SHADOW} />
      <path
        d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z"
        fill={OPEN}
        fillRule="evenodd"
      />
      {/* p */}
      <path d="M48 30H36V18H48V30Z" fill={SHADOW} />
      <path
        d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z"
        fill={OPEN}
        fillRule="evenodd"
      />
      {/* e */}
      <path d="M84 24V30H66V24H84Z" fill={SHADOW} />
      <path
        d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z"
        fill={OPEN}
        fillRule="evenodd"
      />
      {/* n */}
      <path d="M108 36H96V18H108V36Z" fill={SHADOW} />
      <path
        d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z"
        fill={OPEN}
        fillRule="evenodd"
      />
      {/* q */}
      <path d="M138 30H126V18H138V30Z" fill={SHADOW} />
      <path
        d="M138 30H126V12H138V30ZM144 6H120V36H138V42H144V6Z"
        fill={QUEUE}
        fillRule="evenodd"
      />
      <path d="M144 36H138V42H144V36Z" fill={ACCENT} />
      {/* u */}
      <path d="M168 30H156V18H168V30Z" fill={SHADOW} />
      <path d="M156 6V30H168V6H174V36H150V6H156Z" fill={QUEUE} />
      {/* e */}
      <path d="M204 24V30H186V24H204Z" fill={SHADOW} />
      <path
        d="M204 24H186V30H204V36H180V6H204V24ZM186 18H198V12H186V18Z"
        fill={QUEUE}
        fillRule="evenodd"
      />
      {/* u */}
      <path d="M228 30H216V18H228V30Z" fill={SHADOW} />
      <path d="M216 6V30H228V6H234V36H210V6H216Z" fill={QUEUE} />
      {/* e */}
      <path d="M264 24V30H246V24H264Z" fill={SHADOW} />
      <path
        d="M264 24H246V30H264V36H240V6H264V24ZM246 18H258V12H246V18Z"
        fill={QUEUE}
        fillRule="evenodd"
      />
    </svg>
  );
}

/**
 * Square mark — the blocky O-ring from the wordmark with a green tail
 * block on the bottom-right corner, turning it into a Q.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 40"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path d="M24 32H8V16H24V32Z" fill={SHADOW} />
      <path
        d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z"
        fill={QUEUE}
        fillRule="evenodd"
      />
      <path d="M32 40H24V32H32V40Z" fill={ACCENT} />
    </svg>
  );
}
