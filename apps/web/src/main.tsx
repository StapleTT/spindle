import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const [status, setStatus] = useState('Checking service availability…');

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/ready', { signal: controller.signal })
      .then((response) =>
        setStatus(
          response.ok
            ? 'Service available.'
            : 'Service temporarily unavailable.',
        ),
      )
      .catch(() => {
        if (!controller.signal.aborted)
          setStatus('Service temporarily unavailable.');
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Spindle</h1>
      <p>Your private mailboxes, together.</p>
      <p>Spindle 2.0 is under development.</p>
      <p role="status">{status}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
