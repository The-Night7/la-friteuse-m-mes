import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './App.css';

// Look up the root container and mount the React application.  This entry
// point assumes that your host HTML page contains a <div id="root"></div>.
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}