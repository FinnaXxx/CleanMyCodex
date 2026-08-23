import appIcon from './assets/app-icon.png'

/** Shared row icons, so the session, plugin and workspace lists read the same. */

export function FolderIcon() {
  return <svg className="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>
  </svg>
}

export function BackIcon() {
  return <svg className="navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 5-7 7 7 7"/>
  </svg>
}

export function SaveIcon() {
  return <svg className="navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 4h11l3 3v13H5V4Z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/>
  </svg>
}

export function RescanIcon() {
  return <svg className="navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.6h-4.6"/>
  </svg>
}

export function StopIcon() {
  return <svg className="navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none"/>
  </svg>
}

/** The one glyph set the sidebar navigation is drawn from. */
export type NavGlyphName = 'overview' | 'sessions' | 'workspace' | 'plugins' | 'settings'

const NavGlyph: Record<NavGlyphName, string> = {
  overview: 'M12 4a8 8 0 1 0 8 8h-8V4Z M14.6 3.6A8 8 0 0 1 20.4 9.4h-5.8V3.6Z',
  sessions: 'M4 6.4A2.4 2.4 0 0 1 6.4 4h11.2A2.4 2.4 0 0 1 20 6.4v7.2a2.4 2.4 0 0 1-2.4 2.4H10l-4.4 3.4a.6.6 0 0 1-1-.5V16H6.4A2.4 2.4 0 0 1 4 13.6Z',
  workspace: 'M3.5 6.2A1.7 1.7 0 0 1 5.2 4.5h3.3l1.9 2.4h8.4a1.7 1.7 0 0 1 1.7 1.7v9.2a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z',
  plugins: 'M9.4 3.4h4.2v2a2 2 0 1 0 4 0v2.2h2.1v4h-2.4a2 2 0 1 0 0 4h2.4v4.9H9.4v-2.4a2 2 0 1 0-4 0v-4.9h2.4a2 2 0 1 0 0-4H5.4V7.6h4V3.4Z',
  settings: 'M9.7 3.4h4.6l.6 2.2c.5.2.9.4 1.3.7l2.2-.7 2.3 4-1.7 1.5a7 7 0 0 1 0 1.8l1.7 1.5-2.3 4-2.2-.7c-.4.3-.8.5-1.3.7l-.6 2.2H9.7l-.6-2.2c-.5-.2-.9-.4-1.3-.7l-2.2.7-2.3-4L5 12.9a7 7 0 0 1 0-1.8L3.3 9.6l2.3-4 2.2.7c.4-.3.8-.5 1.3-.7l.6-2.2Z'
}

export function NavIcon({ name }: { name: NavGlyphName }) {
  return <svg className="nav-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={NavGlyph[name]} />
    {name === 'settings' && <circle cx="12" cy="12" r="2.6" />}
  </svg>
}

/** The app's own icon, so the sidebar and the first-run screen show what the Dock shows. */
export function BrandMark() {
  return <img className="brand-mark" src={appIcon} alt="" aria-hidden="true" width={30} height={30} />
}
