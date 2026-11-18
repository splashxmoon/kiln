import { useEffect, useState } from 'react'
import { subscribeToast } from './home-data'

/** The latest toast message at the bottom of the home screen; it clears itself after a few seconds. */
export function ToastHost() {
  const [msg, setMsg] = useState<{ text: string; id: number } | null>(null)
  useEffect(() => {
    let timer = 0
    const off = subscribeToast((text) => {
      setMsg({ text, id: Date.now() })
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setMsg(null), 2800)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [])
  if (!msg) return null
  return (
    <div className="k-toast" role="status" key={msg.id}>
      {msg.text}
    </div>
  )
}
