import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderOpen, LoaderCircle, LogOut, UserRound } from 'lucide-react';
import { HARMONY_STYLES, type AccountUser, type HarmonyJob } from './shared/types';

export default function AccountPanel({ disabled, completedProject, onUserChange, onOpen }: {
  disabled: boolean;
  completedProject: string;
  onUserChange: (user: AccountUser | null) => void;
  onOpen: (job: HarmonyJob) => void;
}) {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [form, setForm] = useState<'login' | 'register' | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [projects, setProjects] = useState<HarmonyJob[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const callbacks = useRef({ onUserChange, onOpen });
  callbacks.current = { onUserChange, onOpen };
  const formHeading = useRef<HTMLHeadingElement>(null);

  function updateUser(next: AccountUser | null) {
    setUser(next);
    setProjects([]);
    callbacks.current.onUserChange(next);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth/session', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not check your account.');
      const result = await response.json();
      if (!controller.signal.aborted) updateUser(result.user);
    }).catch(() => { if (!controller.signal.aborted) setError('Could not check your account. Refresh to try again.'); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => { if (form) formHeading.current?.focus(); }, [form]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setLoadingProjects(true);
    void fetch('/api/projects', { signal: controller.signal }).then(async response => {
      if (response.status === 401) { if (!controller.signal.aborted) updateUser(null); return; }
      if (!response.ok) throw new Error('Your projects could not be loaded.');
      const result = await response.json();
      if (!controller.signal.aborted) setProjects(result.projects);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load projects.'); })
      .finally(() => { if (!controller.signal.aborted) setLoadingProjects(false); });
    return () => controller.abort();
  }, [user?.id, completedProject]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || working || !form) return;
    setWorking(true); setError('');
    try {
      const response = await fetch(`/api/auth/${form}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Sign-in could not be completed.');
      updateUser(result.user);
      setPassword(''); setForm(null); setLibraryOpen(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Sign-in failed.'); }
    finally { setWorking(false); }
  }

  async function logout() {
    if (disabled || working) return;
    setWorking(true); setError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Could not sign out. Please try again.');
      updateUser(null); setLibraryOpen(false);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not sign out.'); }
    finally { setWorking(false); }
  }

  async function openProject(id: string) {
    if (disabled || working) return;
    setWorking(true); setError('');
    try {
      const response = await fetch(`/api/jobs/${id}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'This project is no longer available.');
      callbacks.current.onOpen(result);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not open project.'); }
    finally { setWorking(false); }
  }

  return <section className="account-panel" aria-label="Account and saved projects">
    <div className="account-summary"><span className="account-icon"><UserRound size={18} /></span><div><strong>{checking ? 'Checking your account…' : user ? user.email : 'Keep your best takes.'}</strong><p>{user ? 'New projects save automatically. Your latest 10 stay in your library.' : 'Sign in before generating to save your latest 10 projects.'}</p></div><div className="account-actions">{user ? <><button disabled={disabled || working} onClick={() => setLibraryOpen(!libraryOpen)} aria-expanded={libraryOpen}><FolderOpen size={14} /> My projects ({projects.length}/10)</button><button disabled={disabled || working} onClick={() => void logout()} aria-label="Sign out"><LogOut size={14} /> Sign out</button></> : <><button disabled={checking || disabled || working} onClick={() => { setForm('login'); setError(''); }}>Sign in</button><button disabled={checking || disabled || working} onClick={() => { setForm('register'); setError(''); }}>Create account</button></>}</div></div>
    {form && !user && <form className="account-form" onSubmit={event => void submit(event)}><h2 ref={formHeading} tabIndex={-1}>{form === 'login' ? 'Welcome back' : 'Create your account'}</h2><label>Email<input type="email" autoComplete="email" maxLength={254} required value={email} disabled={working} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete={form === 'login' ? 'current-password' : 'new-password'} minLength={12} maxLength={128} required value={password} disabled={working} onChange={event => setPassword(event.target.value)} /></label><p>Use 12–128 characters. Your projects belong to this account.</p><div className="account-form-actions"><button type="submit" disabled={working || disabled}>{working && <LoaderCircle size={13} className="spin" />}{form === 'login' ? 'Sign in to your account' : 'Create my account'}</button><button type="button" disabled={working} onClick={() => { setForm(null); setPassword(''); setError(''); }}>Cancel</button></div></form>}
    {user && libraryOpen && <div className="project-library"><div className="library-heading"><h2>Your projects</h2><span>{projects.length}/10 saved</span></div><p className="retention-note">When a new project finishes, the oldest beyond your latest 10 is removed. Download anything you want to keep longer.</p>{loadingProjects ? <p role="status">Loading your projects…</p> : projects.length === 0 ? <p className="library-empty">Your next finished harmony will appear here.</p> : <div className="project-grid">{projects.map(project => <button className="saved-project" key={project.id} disabled={disabled || working} onClick={() => void openProject(project.id)}><span className="saved-project-name">{project.sourceName}</span><span>{HARMONY_STYLES[project.style].label} · {project.parts} parts</span><span>{new Date(project.createdAt).toLocaleDateString()} · Open project →</span></button>)}</div>}</div>}
    {error && <p className="account-error" role="alert">{error}</p>}
  </section>;
}
