import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Single-thread ffmpeg.wasm does not need cross-origin isolation.
  async headers() {
    return [
      {
        source: "/ffmpeg/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
