import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: ["public/ffmpeg/**", "tmp/**"],
  },
];

export default eslintConfig;
