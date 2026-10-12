/* Keep native Tailwind processing on entry sheets; plain CSS modules stay local. */
const tailwind = require('@tailwindcss/postcss');

module.exports = (options = {}) => {
  const native = tailwind(options).plugins;
  if (!native.every((plugin) => typeof plugin.Once === 'function' &&
      Object.keys(plugin).every((key) => key === 'postcssPlugin' || key === 'Once'))) {
    throw new Error('Tailwind plugin lifecycle changed; revalidate the entry-sheet wrapper.');
  }
  return {
    postcssPlugin: 'shiba-tailwind-entry',
    async Once(root, helpers) {
      const file = helpers.result.opts.from || root.source?.input?.file || '';
      if (/\.module\.css(?:$|\?)/i.test(file)) return;
      // Avoid a cached Tailwind/global result leaking into a plain stylesheet in
      // parallel compiler workers. Existing module CSS uses ordinary variables.
      if (!/@(?:import|tailwind|apply|theme|utility|variant|custom-variant|reference|plugin|config)\b/.test(root.toString())) return;
      for (const plugin of native) await plugin.Once(root, helpers);
    },
  };
};
module.exports.postcss = true;
