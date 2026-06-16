import type { SVGProps } from 'react';
import { cn } from '@/lib/utils';

interface WorkbenchIconProps extends SVGProps<SVGSVGElement> {
  title?: string;
}

/**
 * Inline Workbench app icon — blocky W on a dark rounded square.
 * Simplified for small UI chrome (sidebar): no filters or `<use>` refs,
 * which break easily when inlined as React SVG.
 */
export function WorkbenchIcon({
  className,
  title = 'Workbench',
  ...props
}: WorkbenchIconProps) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
      className={cn('shrink-0', className)}
      {...props}
    >
      <title>{title}</title>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="#141414" />
      <rect
        x="101.5"
        y="101.5"
        width="821"
        height="821"
        rx="183.5"
        stroke="#333333"
        strokeOpacity="0.8"
        strokeWidth="3"
      />
      <g fill="#F4F4F4">
        <rect x="205" y="322" width="58" height="100" rx="6" />
        <rect x="335" y="602" width="58" height="100" rx="6" />
        <rect x="483" y="322" width="58" height="100" rx="6" />
        <rect x="631" y="602" width="58" height="100" rx="6" />
        <rect x="761" y="322" width="58" height="100" rx="6" />
        <rect x="270" y="462" width="58" height="100" rx="6" />
        <rect x="418" y="462" width="58" height="100" rx="6" />
        <rect x="548" y="462" width="58" height="100" rx="6" />
        <rect x="696" y="462" width="58" height="100" rx="6" />
      </g>
    </svg>
  );
}

function isBundledAppIcon(src: string): boolean {
  return (
    src === './app-icon.svg' ||
    src.endsWith('/app-icon.svg') ||
    src.endsWith('app-icon.svg')
  );
}

/**
 * Wordmark as rendered on getworkbench.dev nav (mono, lowercase).
 */
export function WorkbenchWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'font-mono text-sm lowercase tracking-tight text-foreground',
        className,
      )}
    >
      workbench
    </span>
  );
}

/**
 * Sidebar logo: React icon by default, `<img>` only for custom external URLs.
 */
export function WorkbenchLogo({
  src,
  className,
  showWordmark = false,
}: {
  src?: string;
  className?: string;
  showWordmark?: boolean;
}) {
  if (src && !isBundledAppIcon(src)) {
    return (
      <img
        src={src}
        alt="Workbench"
        className={cn('h-5 w-5 shrink-0', className)}
      />
    );
  }

  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)}>
      <WorkbenchIcon className="h-5 w-5 shrink-0" />
      {showWordmark && <WorkbenchWordmark className="truncate" />}
    </div>
  );
}
