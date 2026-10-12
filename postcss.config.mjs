import path from "node:path";

const config = {
  plugins: {
    [path.resolve("scripts/tailwind-entry-postcss.cjs")]: {},
  },
};

export default config;
