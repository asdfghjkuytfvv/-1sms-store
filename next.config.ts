import type { NextConfig } from "next";

function configuredPublicAssetPattern() {
  try {
    const assetBase = new URL(process.env.S3_PUBLIC_BASE_URL || "");
    if (assetBase.protocol !== "https:" || assetBase.username || assetBase.password) return [];
    const basePath = assetBase.pathname.replace(/\/$/, "");
    return [{
      protocol: "https" as const,
      hostname: assetBase.hostname,
      port: assetBase.port,
      pathname: `${basePath}/**`,
    }];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  compress: true,
  experimental: {
    optimizePackageImports: ["three", "@react-three/drei", "gsap"],
  },
  images: {
    remotePatterns: configuredPublicAssetPattern(),
  },
};

export default nextConfig;
