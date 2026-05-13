// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { NextConfig } from "next";
import localPkg from "./package.json";

const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  transpilePackages: ["@plexo/ui", "@plexo/logger", "@plexo/db"],
  // L4.5 — strip data-testid attributes from production builds. Tests use them
  // freely in dev / e2e, but they should not ship to operators (slight bundle
  // bloat + an information signal about test surfaces).
  compiler: {
    reactRemoveProperties: process.env.NODE_ENV === 'production'
      ? { properties: ['^data-testid$'] }
      : false,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },
  turbopack: {
    root: "../../",
  },
  // Phase 8: belt-and-braces tree-shake hint for lucide-react + other
  // heavy named-import packages. The single biggest bloat source was a
  // stray `import * as Icons from 'lucide-react'` in packages/ui
  // (category-badge), which forced every icon into a shared chunk
  // (~690 KB). That call site now uses lucide-react/dynamic instead.
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "react-syntax-highlighter",
      "date-fns",
    ],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: localPkg.version,
    NEXT_PUBLIC_APP_NAME: process.env.APP_NAME || 'Plexo',
    ...(process.env.DEFAULT_WORKSPACE_ID && { NEXT_PUBLIC_DEFAULT_WORKSPACE: process.env.DEFAULT_WORKSPACE_ID }),
  },
  async redirects() {
    // Redirect old pre-/app/ routes to their new locations
    const oldRoutes = [
      'home', 'overview', 'chat', 'tasks', 'conversations', 'projects',
      'sprints', 'insights', 'approvals', 'agents', 'extensions',
      'functions', 'tools', 'skills', 'connections', 'marketplace',
      'settings', 'cron', 'logs', 'audit', 'debug',
    ];
    const legacyRedirects = oldRoutes.map((route) => ({
      source: `/${route}/:path*`,
      destination: `/app/${route}/:path*`,
      permanent: true,
    }));

    // Deprecated in-app route redirects (terminology lockdown)
    const deprecatedRedirects = [
      { source: '/app/sprints', destination: '/app/projects', permanent: true },
      { source: '/app/sprints/:id', destination: '/app/projects/:id', permanent: true },
      { source: '/app/skills/:path*', destination: '/app/extensions/:path*', permanent: true },
      { source: '/app/tools/:path*', destination: '/app/extensions/:path*', permanent: true },
      { source: '/app/insights/:path*', destination: '/app/memory/:path*', permanent: true },
      // UI-audit Phase 6 — settings consolidation.
      // Integrations moved from /app/settings/connections to /app/connections (canonical).
      // AI Models / AI Providers legacy stubs now fold straight into the intelligence providers tab.
      // /app/settings/agent + /app/settings/behavior stay as stubs because they pass ?tab= through to /app/agents.
      { source: '/app/settings/connections/:path*', destination: '/app/connections/:path*', permanent: true },
      { source: '/app/settings/ai-models/:path*', destination: '/app/settings/intelligence/providers', permanent: true },
      { source: '/app/settings/ai-providers/:path*', destination: '/app/settings/intelligence/providers', permanent: true },
    ];

    return [...deprecatedRedirects, ...legacyRedirects];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path((?!auth|ops).*)",
        destination: `${process.env.INTERNAL_API_URL || 'http://localhost:3001'}/api/:path`,
      },
      {
        source: "/.well-known/:path*",
        destination: `${process.env.INTERNAL_API_URL || 'http://localhost:3001'}/.well-known/:path*`,
      },
    ];
  },
};

export default nextConfig;
