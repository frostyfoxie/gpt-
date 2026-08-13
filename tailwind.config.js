/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{ts,tsx,js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        theta: {
          bg: 'var(--bg-main)',
          panel: 'var(--panel-bg)',
          panelHover: 'var(--panel-hover)',
          border: 'var(--border-color)',
          accent: 'var(--accent)',
          accentHover: 'var(--accent-hover)',
          text: 'var(--text-primary)',
          muted: 'var(--text-muted)',
          codeBg: 'var(--code-bg)',
          terminalBg: 'var(--terminal-bg)',
          terminalText: 'var(--terminal-text)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
