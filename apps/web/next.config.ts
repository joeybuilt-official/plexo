// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { NextConfig } from "next";
import localPkg from "./package.json";

const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  transpilePackages: ["@plexo/ui"],
  turbopack: {
    root: "../../",
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: localPkg.version,
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
