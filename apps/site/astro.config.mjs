import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://darkharasho.github.io',
  base: '/starlight',
  output: 'static',
  integrations: [tailwind({ applyBaseStyles: false })],
});
