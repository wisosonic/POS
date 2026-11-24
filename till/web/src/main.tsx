import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyAppearance, readAppearance } from './lib/appearance';
import { applyLang, readLang } from './lib/i18n';
import { rememberedShopName, setShopTitle } from './lib/shopTitle';
// Fonts are part of the app (nothing is fetched from the internet): the Latin and Arabic letters the screens use.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import './styles.css';

applyLang(readLang()); // the language and the reading direction, before anything is drawn
applyAppearance(readAppearance()); // before anything is drawn, so there is no flash of the wrong colours
setShopTitle(rememberedShopName()); // the tab carries the shop's name from the first moment, as last seen

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Lets the till open from its own saved copy of the app when the server cannot be reached (the worker is built, and registered, only for production).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined); // without it the app works as before
  });
}
