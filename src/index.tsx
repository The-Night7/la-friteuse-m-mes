import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx'; // On importe le composant qu'on vient de créer
import './index.css';        // Votre CSS global (facultatif)

// Création de la racine React et rendu du composant App
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);