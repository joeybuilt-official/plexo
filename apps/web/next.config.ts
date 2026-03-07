import type { NextConfig } from "next";
import rootPkg from "../../package.json";

const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  transpilePackages: ["@plexo/ui"],
  turbopack: {
    root: "../../",
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: rootPkg.version,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path((?!auth).*)",
        destination: `${process.env.INTERNAL_API_URL || 'http://localhost:3001'}/api/:path`,
      },
    ];
  },
};

export default nextConfig;
