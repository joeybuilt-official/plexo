import type { NextConfig } from "next";

// Parse allowed origins from env — keeps production domains out of source.
// ADMIN_URL must be set in the operator's .env (e.g. https://your-admin.example.com).
const adminHost = process.env.ADMIN_URL
  ? new URL(process.env.ADMIN_URL).host
  : undefined;

const allowedOrigins = ["localhost:3002"];
if (adminHost) allowedOrigins.push(adminHost);

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    serverActions: {
      allowedOrigins,
    },
  },
};

export default nextConfig;
