import { join } from 'node:path';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    // Monorepo root, so Turbopack can resolve workspace-hoisted packages
    // (e.g. `next`) that Bun installs above the `site/` directory.
    root: join(__dirname, '..'),
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
