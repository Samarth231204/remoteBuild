import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // trycloudflare.com hostnames are random per run, so allow any host here.
  // Dev-only convenience — the real client will be deployed to a fixed
  // domain (Cloudflare Pages) later, where this doesn't apply.
  server: {
    allowedHosts: true,
  },
  preview: {
    allowedHosts: true,
  },
})
