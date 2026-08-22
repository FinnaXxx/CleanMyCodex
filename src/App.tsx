import { useEffect, useState } from 'react'

function App() {
  const [version, setVersion] = useState('')
  const [platform, setPlatform] = useState('')

  useEffect(() => {
    window.cleanmycodex.appInfo().then((info) => {
      setVersion(info.version)
      setPlatform(info.platform)
    })
  }, [])

  return (
    <main className="app">
      <header>
        <h1>CleanMyCodex</h1>
        <p className="subtitle">Codex 空间扫描与清理工具</p>
      </header>
      <section className="status">
        <p className="meta">
          {version && `v${version}`} {platform && `· ${platform}`}
        </p>
      </section>
    </main>
  )
}

export default App