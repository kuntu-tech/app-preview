import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

declare const __APP_VERSION__: string;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App appVersion={__APP_VERSION__} />
  </React.StrictMode>,
);
