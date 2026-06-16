'use client';

import { useState } from 'react';

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="group flex h-11 items-center gap-3 border border-white/15 bg-[#0b0b0c] px-4 font-mono text-[13px] text-neutral-300 transition-colors hover:border-white/30"
    >
      <span className="text-neutral-600">$</span>
      {command}
      <span className="text-neutral-600 transition-colors group-hover:text-neutral-400">
        {copied ? '✓' : '⧉'}
      </span>
    </button>
  );
}
