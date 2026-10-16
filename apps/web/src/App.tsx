import { PROTOCOL_VERSION } from '@zipply/protocol';

// Phase 1 placeholder. Layout, theming and features arrive in Phase 2+; keep App as wiring only.
export default function App() {
  return (
    <main>
      <h1>zipply</h1>
      <p>Private file sharing, directly between browsers. Under construction.</p>
      <p>protocol v{PROTOCOL_VERSION}</p>
    </main>
  );
}
