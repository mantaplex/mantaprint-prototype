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
        // Palette sampled from the Mantaplex logo ring: teal -> navy -> plum -> wine.
        // `manta` (teal) is the single UI accent; the others appear only in brand gradients.
        manta: {
          50: '#ecfdfd',
          100: '#cff7f8',
          200: '#a3eef1',
          300: '#67dde3',
          400: '#2cc2cb',
          500: '#12a3ad',
          600: '#0a818b',
          700: '#0d6770',
          800: '#11535b',
          900: '#13454d',
          950: '#052b32'
        },
        navy: { 400: '#4d6fb3', 500: '#264a8f', 600: '#153573', 700: '#092457', 900: '#061633' },
        plum: { 300: '#d7a1c4', 400: '#b8679a', 500: '#8e3a6d', 600: '#6e2654', 700: '#56193d' },
        wine: { 300: '#f0a3b5', 400: '#d9627f', 500: '#b63a5a', 600: '#8e2c47', 700: '#6b1f35' },
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        }
      }
    },
  },
  plugins: [],
}
