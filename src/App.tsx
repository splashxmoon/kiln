import { lazy, Suspense, useEffect, useState } from 'react'
import { Files } from './app/Files'
import { createFile, type HomeView } from './app/home-data'
import { isTauri } from './platform/tauri'
import { TooltipHost, ContextMenuGuard } from './ui/Chrome'
import { DialogHost } from './ui/Dialogs'
import './ui/ui.css'

const Landing = lazy(() => import('./site/Landing'))
// The editor (canvas, codegen, shaders, agent tools) is most of the app's code; the files home
// and the site don't need it, so it loads on first open and is fetched early once the home is idle.
const loadEditor = () => import('./editor/Editor')
const Editor = lazy(() => loadEditor().then((m) => ({ default: m.Editor })))

let creating: Promise<string> | null = null

type Route = { name: 'landing' } | { name: 'home'; view: HomeView } | { name: 'new' } | { name: 'file'; id: string }

function parse(hash: string): Route {
  const h = hash.replace(/^#/, '')
  const m = /^\/file\/([\w-]+)/.exec(h)
  if (m) return { name: 'file', id: m[1] }
  const p = /^\/project\/([\w-]+)/.exec(h)
  if (p) return { name: 'home', view: { kind: 'project', id: p[1] } }
  if (h.startsWith('/files')) return { name: 'home', view: { kind: 'recent' } }
  if (h.startsWith('/drafts')) return { name: 'home', view: { kind: 'drafts' } }
  if (h.startsWith('/trash')) return { name: 'home', view: { kind: 'trash' } }
  if (h.startsWith('/new')) return { name: 'new' }
  // the desktop app opens straight to files; the web root is the marketing site
  if (isTauri && (h === '' || h === '/')) return { name: 'home', view: { kind: 'recent' } }
  return { name: 'landing' }
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.hash))
  useEffect(() => {
    const f = () => setRoute(parse(location.hash))
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])

  useEffect(() => {
    if (route.name !== 'new') return
    // one creation per visit to #/new, even when effects run twice (StrictMode)
    creating ??= createFile('starter').finally(() => setTimeout(() => (creating = null), 500))
    creating.then((id) => location.replace('#/file/' + id))
  }, [route])

  // warm the editor's code while the files home sits idle, so opening a file is instant
  useEffect(() => {
    if (route.name !== 'home') return
    const warm = () => void loadEditor()
    if (typeof window.requestIdleCallback === 'function') {
      const h = window.requestIdleCallback(warm, { timeout: 3000 })
      return () => window.cancelIdleCallback(h)
    }
    const t = window.setTimeout(warm, 1200)
    return () => window.clearTimeout(t)
  }, [route.name])

  useEffect(() => {
    document.title = route.name === 'landing' ? 'Kiln — design that ships as code' : 'Kiln'
    if (route.name === 'landing') window.scrollTo(0, 0)
  }, [route.name])

  return (
    <>
      <Screen route={route} />
      <TooltipHost />
      <ContextMenuGuard />
      <DialogHost />
    </>
  )
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'file':
      return (
        <Suspense fallback={null}>
          <Editor key={route.id} fileId={route.id} onBack={() => (location.hash = '#/files')} />
        </Suspense>
      )
    case 'home':
      return <Files view={route.view} open={(id) => (location.hash = '#/file/' + id)} />
    case 'new':
      return null
    default:
      return (
        <Suspense fallback={null}>
          <Landing />
        </Suspense>
      )
  }
}
