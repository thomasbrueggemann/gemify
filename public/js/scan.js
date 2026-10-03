// The phone: joins the host's room as "scanner", walks the user through the
// rulebook and component photos, and streams each photo to the host browser.
// A photo only counts as delivered when the host acknowledges it.

import {openRoom, normaliseCode, makeCode} from './net.js'
import {shrinkPhoto} from './media.js'
import {escapeHtml} from './markdown.js'

const $ = sel => document.querySelector(sel)
const $$ = sel => [...document.querySelectorAll(sel)]

const ACK_TIMEOUT_MS = 45000

let room = null
let hostId = null
let finished = false
const photos = []   // {id, kind, blob, url, state: 'queued'|'sending'|'sent'|'failed', pct}

const show = id => {
  $$('.view').forEach(v => { v.hidden = v.id !== id })
  scrollTo(0, 0)
}

let toastTimer = null
const toast = (text, ms = 3000) => {
  const el = $('#toast')
  el.textContent = text
  el.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('on'), ms)
}

const setStatus = (text, state = 'wait') => {
  $('#connect-status').innerHTML = `<span class="dot ${state}"></span> ${escapeHtml(text)}`
}

// ── Photo list ────────────────────────────────────────────────────────

const render = () => {
  for (const kind of ['rules', 'components']) {
    $(`#list-${kind}`).replaceChildren(...photos.filter(p => p.kind === kind).map((p, i) => {
      const fig = document.createElement('figure')
      fig.className = `thumb ${p.state}`
      const badge = {queued: '…', sending: `${Math.round((p.pct || 0) * 100)}%`, sent: '✓', failed: '↻'}[p.state]
      fig.innerHTML = `<img alt="${kind} photo ${i + 1}"><figcaption>${i + 1}</figcaption><span class="badge">${badge}</span><button class="x" aria-label="Remove photo">×</button>`
      fig.querySelector('img').src = p.url
      fig.querySelector('.badge').onclick = () => p.state === 'failed' && upload(p)
      fig.querySelector('.x').onclick = () => remove(p)
      return fig
    }))
  }
  const sent = kind => photos.some(p => p.kind === kind && p.state === 'sent')
  const busy = photos.some(p => p.state === 'sending' || p.state === 'queued')
  $('#to-components').disabled = !sent('rules')
  $('#send').disabled = !sent('rules') || busy
  $('#send').textContent = busy ? 'Sending photos…' : '✨ Build my game'
}

const remove = p => {
  photos.splice(photos.indexOf(p), 1)
  URL.revokeObjectURL(p.url)
  if (hostId && p.state === 'sent') room.send('rmphoto', {id: p.id}, {target: hostId}).catch(() => {})
  render()
}

const upload = async p => {
  if (!hostId) {
    p.state = 'queued'
    return render()
  }
  p.state = 'sending'
  p.pct = 0
  render()
  try {
    await room.send('photo', p.blob, {
      target: hostId,
      metadata: {id: p.id, kind: p.kind},
      onProgress: pct => {
        p.pct = pct
        const badge = document.querySelector(`#list-${p.kind} figure:nth-child(${photos.filter(x => x.kind === p.kind).indexOf(p) + 1}) .badge`)
        if (badge && p.state === 'sending') badge.textContent = `${Math.round(pct * 100)}%`
      }
    })
    // Delivered; now wait for the host to confirm it stored the photo.
    clearTimeout(p.timer)
    p.timer = setTimeout(() => {
      if (p.state !== 'sent') {
        p.state = 'failed'
        render()
      }
    }, ACK_TIMEOUT_MS)
  } catch {
    p.state = 'failed'
    render()
  }
}

const addFiles = async (files, kind) => {
  for (const file of files) {
    let blob
    try {
      blob = await shrinkPhoto(file)
    } catch (err) {
      toast(`Could not read that photo: ${err.message}`)
      continue
    }
    const p = {id: makeCode(8), kind, blob, url: URL.createObjectURL(blob), state: 'queued', pct: 0}
    photos.push(p)
    render()
    upload(p)
  }
}

// ── Room ──────────────────────────────────────────────────────────────

const connect = async code => {
  show('s-connect')
  $('#form-code').hidden = true
  $('#chip').textContent = `Room ${code}`
  setStatus('Looking for the big screen…')
  const slow = setTimeout(() => {
    if (!hostId) setStatus('Still looking… make sure Gemify is open on the computer and the code matches.', 'warn')
  }, 20000)

  try {
    room = await openRoom({
      code,
      onPeerJoin: id => room.send('hi', {role: 'scanner'}, {target: id}).catch(() => {}),
      onPeerLeave: id => {
        if (id !== hostId) return
        hostId = null
        toast('Lost the big screen. Reconnecting…')
        photos.filter(p => p.state === 'sending').forEach(p => { p.state = 'queued' })
        render()
      },
      onError: err => setStatus(err.message, 'bad')
    })
  } catch (err) {
    clearTimeout(slow)
    return setStatus(err.message, 'bad')
  }

  room.on('hi', (msg, {peerId}) => {
    if (msg.role !== 'host') return
    clearTimeout(slow)
    hostId = peerId
    // Flush anything taken while disconnected.
    photos.filter(p => p.state === 'queued' || p.state === 'failed').forEach(upload)
  })

  room.on('ack', ({id}, {peerId}) => {
    if (peerId !== hostId) return
    const p = photos.find(x => x.id === id)
    if (!p) return
    clearTimeout(p.timer)
    p.state = 'sent'
    if (navigator.vibrate) navigator.vibrate(30)
    render()
  })

  room.on('rmphoto', ({id}, {peerId}) => {
    if (peerId !== hostId) return
    const p = photos.find(x => x.id === id)
    if (p) remove(p)
  })

  room.on('status', (msg, {peerId}) => {
    if (peerId !== hostId) return
    // First contact (or after a reload): take the host's word for what arrived.
    for (const id of msg.have || []) {
      const p = photos.find(x => x.id === id)
      if (p) p.state = 'sent'
    }
    if (msg.stage === 'collect' && !finished && $('#s-connect').hidden === false) show('s-rules')
    if (msg.stage === 'build') {
      show('s-status')
      $('#status-title').textContent = 'Claude is building your game'
      $('#status-text').textContent = msg.text || 'Working…'
      $('#status-spinner').hidden = false
      $('#again').hidden = true
    }
    if (msg.stage === 'ready') {
      show('s-status')
      $('#status-title').textContent = `“${msg.title || 'Your game'}” is ready 🎉`
      $('#status-text').textContent = 'Look at the big screen to pick players and start.'
      $('#status-spinner').hidden = true
      $('#again').hidden = false
    }
    if (msg.stage === 'error') {
      show('s-status')
      $('#status-title').textContent = 'That did not work'
      $('#status-text').textContent = msg.text || 'Check the big screen.'
      $('#status-spinner').hidden = true
      $('#again').hidden = false
    }
    render()
  })
}

// ── Wiring ────────────────────────────────────────────────────────────

$$('input[type=file]').forEach(input => {
  input.onchange = () => {
    addFiles([...input.files], input.dataset.kind)
    input.value = ''
  }
})
$('#to-components').onclick = () => show('s-components')
$('#back-rules').onclick = () => show('s-rules')
$('#notes').onchange = e => hostId && room.send('notes', {text: e.target.value}, {target: hostId}).catch(() => {})
$('#send').onclick = async () => {
  if (!hostId) return toast('Not connected to the big screen yet.')
  await room.send('notes', {text: $('#notes').value}, {target: hostId}).catch(() => {})
  await room.send('done', {}, {target: hostId}).catch(() => {})
  finished = true
  show('s-status')
}
$('#again').onclick = () => {
  photos.splice(0).forEach(p => URL.revokeObjectURL(p.url))
  finished = false
  $('#notes').value = ''
  render()
  show('s-rules')
  toast('Start a new scan on the computer (“Scan a new game”), then take your photos.', 5000)
}
$('#form-code').onsubmit = e => {
  e.preventDefault()
  const code = normaliseCode($('#code').value)
  if (code.length === 6) connect(code)
}

const code = normaliseCode(new URLSearchParams(location.search).get('room') || '')
if (code.length === 6) connect(code)
else {
  setStatus('No room in the link.', 'warn')
  $('#form-code').hidden = false
}
addEventListener('beforeunload', () => room?.leave())
