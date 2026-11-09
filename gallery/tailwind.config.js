/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  // 与 115Deck 一致：hover 只在真正支持悬停的设备上生效，避免触屏点按后卡片「锁存」抬起
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      colors: { background: '#0f172a', surface: '#1e293b' },
      keyframes: { fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } } },
      animation: { fadeIn: 'fadeIn 160ms ease-out' },
    },
  },
  plugins: [],
};
