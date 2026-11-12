import type { NextConfig } from 'next';

/** Static verification page served by the Bun server at /verify/paypal/. */
const exporting = process.env.NODE_ENV === 'production';

/** Where the Bun server listens in development. The default port is 8787. */
const API_ORIGIN = process.env.AGENTTRUST_API ?? 'http://127.0.0.1:8787';

const nextConfig: NextConfig = {
  basePath: '/verify',
  trailingSlash: true,
  // Otherwise next dev writes an AGENTS.md scaffold back into the app on every start.
  agentRules: false,
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: { externalDir: true },
  ...(exporting
    ? { output: 'export' as const }
    : {
        // The API is at the origin's root, outside /verify, on the Bun server.
        async rewrites() {
          return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*`, basePath: false as const }];
        },
      }),
};

export default nextConfig;
