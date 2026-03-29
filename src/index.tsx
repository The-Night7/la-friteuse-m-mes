import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css'; // ou './App.css' selon comment tu l'as nommé

// On cherche la balise <div id="root"></div> dans le index.html
const container = document.getElementById('root');

if (container) {
  const root = createRoot(container);
  // On injecte notre application dedans !
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}