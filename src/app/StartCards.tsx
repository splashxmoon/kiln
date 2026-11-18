import { Plus, LayoutTemplate } from 'lucide-react'
import { isTauri } from '../platform/tauri'

/** Blank and Starter cards: they create a file in the given project, or in Drafts. */
export function StartCards({ make, note }: { make: (kind: 'blank' | 'starter') => void; note?: boolean }) {
  return (
    <section className="k-files-start">
      <button className="k-start-card" onClick={() => make('blank')}>
        <span className="k-start-art is-blank">
          <Plus size={22} />
        </span>
        <span>
          <b>Blank canvas</b>
          <span className="k-dim">A 1440 artboard, nothing else</span>
        </span>
      </button>
      <button className="k-start-card" onClick={() => make('starter')}>
        <span className="k-start-art is-starter">
          <LayoutTemplate size={20} />
        </span>
        <span>
          <b>Starter: ceramics shop</b>
          <span className="k-dim">Flex layouts, shaders, tokens, mobile variant</span>
        </span>
      </button>
      {note && (
        <div className="k-start-note">
          <b>{isTauri ? 'Saved as .kiln files' : 'Saved in this browser'}</b>
          <span className="k-dim">
            {isTauri ? 'In Documents/Kiln — plain JSON you can version with git.' : 'Get the desktop app for files on disk and agent subscriptions.'}
          </span>
        </div>
      )}
    </section>
  )
}
