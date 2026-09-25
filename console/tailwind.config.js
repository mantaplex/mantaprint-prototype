/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        console: {
          900: '#090d16',
          800: '#0f172a',
          700: '#1e293b',
          600: '#334155',
          primary: '#6366f1',
          accent: '#10b981',
          danger: '#ef4444',
          warning: '#f59e0b'
        }
      }
    },
  },
  plugins: [],
}
