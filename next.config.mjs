/**
 * Prototype build: no server, no database, no model. Every screen is a client
 * component reading lib/demo-data.ts, and the only "backend" is the pure
 * functions in lib/replan.ts and lib/constraints.ts running in the browser.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
