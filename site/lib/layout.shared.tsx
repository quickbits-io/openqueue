import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Wordmark } from '@/components/wordmark';

export const GITHUB_URL = 'https://github.com/quickbits-io/openqueue';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Wordmark className="h-[17px] w-auto" />,
    },
    githubUrl: GITHUB_URL,
    themeSwitch: { enabled: false },
  };
}
