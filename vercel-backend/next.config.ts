import type { NextConfig } from "next";
import path from "path";

// This project has its own package-lock.json but lives inside the main
// Clonosaur repo, which also has one at its root — without this, Next.js
// guesses the wrong workspace root and warns on every build.
const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
