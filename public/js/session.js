// Parent-side handle on one game iframe (see frame.js for the other side).

// The frame document is assembled here and given to the iframe as srcdoc with
// the runtime inlined: a sandboxed (opaque-origin) frame cannot be relied on to
// load anything from this server — some embedders block it outright. It only
// needs the three.js CDN; photos are handed over as Blobs.
let frameHtmlPromise = null
const frameHtml = () => (frameHtmlPromise ??= Promise.all([
  fetch('/frame.html').then(r => r.text()),
  fetch('/js/frame.js').then(r => r.text())
]).then(([html, js]) => html.replace(
  '<script type="module" src="/js/frame.js"></script>',
  () => `<script type="module">\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`
)))

const fetchPhotos = photos => Promise.all(photos.map(async p => {
  try {
    return {kind: p.kind, blob: await fetch(p.url).then(r => r.blob())}
  } catch {
    return null
  }
})).then(list => list.filter(Boolean))

/**
 * @param {object} o
 * @param {HTMLElement} o.container
 * @param {string} o.code           the game module source
 * @param {'authority'|'mirror'} o.mode
 * @param {number|null} [o.me]      mirror: the seat this screen plays
 * @param {{url: string, kind: string}[]} [o.photos]
 * @param {(type: string, data: any) => void} o.onEvent  'loaded' | 'views' | 'action' | 'error'
 */
export const createSession = ({container, code, mode, me = null, photos = [], onEvent}) => {
  const frame = document.createElement('iframe')
  frame.className = 'game-frame'
  // allow-scripts only: the generated code runs with an opaque origin.
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('allow', 'fullscreen')
  frameHtml().then(html => { frame.srcdoc = html })
  const photoBlobs = fetchPhotos(photos)

  let ready = false
  let loaded = false
  const queue = []
  const post = msg => {
    if (!loaded && msg.t !== 'load') return queue.push(msg)
    frame.contentWindow?.postMessage(msg, '*')
  }

  const onMessage = e => {
    if (e.source !== frame.contentWindow) return
    const msg = e.data || {}
    if (msg.t === 'ready' && !ready) {
      ready = true
      photoBlobs.then(list => post({t: 'load', code, mode, me, photos: list}))
    } else if (msg.t === 'loaded') {
      loaded = true
      onEvent('loaded', msg.meta)
      queue.splice(0).forEach(post)
    } else if (msg.t === 'views') onEvent('views', msg)
    else if (msg.t === 'action') onEvent('action', msg.action)
    else if (msg.t === 'error') onEvent('error', msg)
  }
  addEventListener('message', onMessage)
  container.replaceChildren(frame)

  return {
    frame,
    /** authority: start with seats [{name, color, kind, where}], optionally from a saved state */
    start: (seats, restore = null) => post({t: 'start', seats, restore}),
    setSeats: seats => post({t: 'seats', seats}),
    remoteAction: (seat, action) => post({t: 'remote', seat, action}),
    /** mirror: show a snapshot from the host */
    view: payload => post({t: 'view', payload}),
    focus: () => frame.focus(),
    destroy: () => {
      removeEventListener('message', onMessage)
      frame.remove()
    }
  }
}
