// Peer-to-peer rooms: Trystero over WebRTC, peers discovered through Nostr
// relays (same approach as spanish-game). No game traffic touches our server.
//
// A room is identified by a 6-character code that is also its password. The
// host browser owns the room; phones join it as "scanner", other browsers as
// "player". Everyone announces their role with a `hi` message.

export const APP_ID = 'gemify-v1'

// No 0/O or 1/I: codes get read aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const makeCode = (n = 6) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), b => ALPHABET[b % ALPHABET.length]).join('')

export const normaliseCode = txt =>
  (txt || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6)

// A stable id per browser, so a player who reloads gets their seat back.
export const clientId = (() => {
  try {
    let id = localStorage.getItem('gemify:client')
    if (!id) localStorage.setItem('gemify:client', id = makeCode(10))
    return id
  } catch {
    return makeCode(10)
  }
})()

const CDNS = [
  'https://esm.sh/trystero@0.25.4',
  'https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm'
]

let trystero = null
const loadTrystero = async () => {
  if (trystero) return trystero
  if (!globalThis.crypto?.subtle) {
    throw new Error('This page needs a secure (https) connection for peer-to-peer. Open the https:// link from the QR code.')
  }
  const failures = []
  for (const url of CDNS) {
    try {
      return (trystero = await import(url))
    } catch (err) {
      failures.push(`${url}: ${err.message}`)
    }
  }
  throw new Error(`Could not load Trystero. ${failures.join(' · ')}`)
}

/**
 * Join (or create) a room.
 *
 * @returns {Promise<{
 *   code: string,
 *   send: (channel: string, data: any, opts?: {target?: string|string[], metadata?: object, onProgress?: Function}) => Promise<void>,
 *   on: (channel: string, fn: (data: any, info: {peerId: string, metadata?: object}) => void) => void,
 *   onReceiveProgress: (channel: string, fn: (pct: number, info: {peerId: string, metadata?: object}) => void) => void,
 *   peers: () => string[],
 *   leave: () => void
 * }>}
 */
export const openRoom = async ({code, onPeerJoin = () => {}, onPeerLeave = () => {}, onError = () => {}}) => {
  const {joinRoom} = await loadTrystero()
  const room = joinRoom(
    {appId: APP_ID, password: code},
    code,
    {onJoinError: d => onError(new Error(d.error))}
  )

  // Channel names are limited to 12 bytes by Trystero.
  const channels = new Map()
  const channel = name => {
    if (!channels.has(name)) channels.set(name, room.makeAction(name))
    return channels.get(name)
  }

  room.onPeerJoin = id => onPeerJoin(id)
  room.onPeerLeave = id => onPeerLeave(id)

  return {
    code,
    send: (name, data, opts = {}) => channel(name).send(data, opts),
    on: (name, fn) => { channel(name).onMessage = fn },
    onReceiveProgress: (name, fn) => { channel(name).onReceiveProgress = fn },
    peers: () => Object.keys(room.getPeers()),
    leave: () => { try { room.leave() } catch {} }
  }
}
