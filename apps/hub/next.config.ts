import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  transpilePackages: ["@plexo/db"],
  turbopack: {
    root: "../../",
  },
};

export default nextConfig;
