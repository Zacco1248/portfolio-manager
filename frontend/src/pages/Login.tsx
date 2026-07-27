import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { useApp } from '@/state/app';

export function Login() {
  const { login } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nie udało się zalogować');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={(e) => void submit(e)} className="card w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">Portfolio Manager</h1>
        <p className="mt-1 text-2xs text-content-muted">
          Aplikacja dostępna w sieci lokalnej i przez Tailscale. Zaloguj się hasłem z pliku <code>.env</code>.
        </p>

        <label className="mt-5 block">
          <span className="label">Hasło</span>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className="mt-3 rounded-md border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</p>}

        <button type="submit" className="btn btn-primary mt-4 w-full" disabled={busy || password.length === 0}>
          {busy ? 'Sprawdzam…' : 'Zaloguj'}
        </button>
      </form>
    </div>
  );
}
