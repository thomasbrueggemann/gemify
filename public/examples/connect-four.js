// Hand-written reference game that follows the Gemify module contract
// (lib/prompt.js). Used as the built-in demo and by the tests.

const COLS = 7
const ROWS = 6

export const meta = {
  title: 'Connect Four',
  minPlayers: 2,
  maxPlayers: 2,
  supportsBots: true,
  playerColors: ['#e4572e', '#f3c623']
}

export function setup() {
  return {grid: Array(COLS * ROWS).fill(-1), turn: 0, last: null, winner: null, line: null, moves: 0}
}

export function activePlayers(s) {
  return s.winner !== null || s.moves === COLS * ROWS ? [] : [s.turn]
}

const at = (s, c, r) => s.grid[r * COLS + c]
const dropRow = (s, c) => {
  for (let r = 0; r < ROWS; r++) if (at(s, c, r) === -1) return r
  return -1
}

const lineThrough = (s, c, r) => {
  const p = at(s, c, r)
  for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const cells = [[c, r]]
    for (const sign of [1, -1]) {
      let x = c + dc * sign, y = r + dr * sign
      while (x >= 0 && x < COLS && y >= 0 && y < ROWS && at(s, x, y) === p) {
        cells.push([x, y])
        x += dc * sign
        y += dr * sign
      }
    }
    if (cells.length >= 4) return cells
  }
  return null
}

export function applyAction(s, a, {player}) {
  if (!a || a.type !== 'drop') return {error: 'Unknown action'}
  if (!activePlayers(s).includes(player)) return {error: 'Not your turn'}
  const c = a.col
  if (!Number.isInteger(c) || c < 0 || c >= COLS) return {error: 'No such column'}
  const r = dropRow(s, c)
  if (r < 0) return {error: 'That column is full'}
  s.grid[r * COLS + c] = player
  s.last = [c, r]
  s.moves++
  const line = lineThrough(s, c, r)
  if (line) {
    s.winner = player
    s.line = line
  } else {
    s.turn = 1 - player
  }
  return {state: s}
}

export function result(s) {
  if (s.winner !== null) return {winners: [s.winner], message: `${s.winner === 0 ? 'Red' : 'Yellow'} connects four!`}
  if (s.moves === COLS * ROWS) return {winners: [], message: 'The board is full — a draw.'}
  return null
}

export function playerView(s) {
  return s
}

export function botAction(s, player, random) {
  const legal = []
  for (let c = 0; c < COLS; c++) if (dropRow(s, c) >= 0) legal.push(c)
  const wins = who => legal.find(c => {
    const t = JSON.parse(JSON.stringify(s))
    t.grid[dropRow(t, c) * COLS + c] = who
    return lineThrough(t, c, dropRow(s, c))
  })
  const win = wins(player)
  if (win !== undefined) return {type: 'drop', col: win}
  const block = wins(1 - player)
  if (block !== undefined) return {type: 'drop', col: block}
  // Prefer the centre, with a little noise.
  legal.sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3) + (random() - 0.5) * 2)
  return {type: 'drop', col: legal[0]}
}

export function createRenderer({THREE, addons, canvasHost, uiHost, sendAction}) {
  const renderer = new THREE.WebGLRenderer({antialias: true})
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  canvasHost.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#1b1f2a')
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.set(2.6, 5.2, 15)
  const controls = new addons.OrbitControls(camera, renderer.domElement)
  controls.target.set(0, 3.2, 0)
  controls.enablePan = false
  controls.minDistance = 8
  controls.maxDistance = 20
  controls.maxPolarAngle = Math.PI * 0.55

  scene.add(new THREE.HemisphereLight('#ffffff', '#40342a', 1.2))
  const sun = new THREE.DirectionalLight('#fff4e0', 2.2)
  sun.position.set(5, 12, 8)
  sun.castShadow = true
  scene.add(sun)

  const table = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.MeshStandardMaterial({color: '#6b4a2f', roughness: 0.8}))
  table.rotation.x = -Math.PI / 2
  table.receiveShadow = true
  scene.add(table)

  // The blue frame: a box with round holes cut out via an alpha texture.
  const W = COLS * 1.1 + 0.4
  const H = ROWS * 1.1 + 0.4
  const holes = document.createElement('canvas')
  holes.width = COLS * 64 + 24
  holes.height = ROWS * 64 + 24
  const g = holes.getContext('2d')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, holes.width, holes.height)
  g.fillStyle = '#000'
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    g.beginPath()
    g.arc(12 + c * 64 + 32, 12 + r * 64 + 32, 26, 0, Math.PI * 2)
    g.fill()
  }
  const alpha = new THREE.CanvasTexture(holes)
  const frameMat = new THREE.MeshStandardMaterial({color: '#2456c9', roughness: 0.35, alphaMap: alpha, alphaTest: 0.5, side: THREE.DoubleSide})
  for (const z of [0.32, -0.32]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), frameMat)
    face.position.set(0, H / 2 + 0.3, z)
    face.castShadow = true
    scene.add(face)
  }
  for (const x of [-W / 2, W / 2]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.2, H + 0.6, 1.2), new THREE.MeshStandardMaterial({color: '#1d47a8'}))
    side.position.set(x, (H + 0.6) / 2, 0)
    side.castShadow = true
    scene.add(side)
  }

  const cellPos = (c, r) => new THREE.Vector3((c - (COLS - 1) / 2) * 1.1, 0.3 + 0.2 + 0.55 + r * 1.1, 0)
  const discGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.3, 40).rotateX(Math.PI / 2)
  const colors = meta.playerColors.map(c => new THREE.MeshStandardMaterial({color: c, roughness: 0.4}))
  const discs = new Map()

  // Invisible column hit boxes for picking.
  const pickers = []
  for (let c = 0; c < COLS; c++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, H + 2, 1.4), new THREE.MeshBasicMaterial({visible: false}))
    m.position.set(cellPos(c, 0).x, H / 2 + 1, 0)
    m.userData.col = c
    scene.add(m)
    pickers.push(m)
  }
  const ghost = new THREE.Mesh(discGeo, new THREE.MeshStandardMaterial({color: '#fff', transparent: true, opacity: 0.55}))
  ghost.visible = false
  scene.add(ghost)

  const hud = document.createElement('div')
  hud.style.cssText = 'position:absolute;left:50%;top:72px;transform:translateX(-50%);padding:10px 18px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font:600 16px system-ui;white-space:nowrap'
  uiHost.appendChild(hud)
  const toast = document.createElement('div')
  toast.style.cssText = 'position:absolute;left:50%;bottom:24px;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:#b3261e;color:#fff;font:14px system-ui;opacity:0;transition:opacity .3s'
  uiHost.appendChild(toast)

  let current = null
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const pick = e => {
    const rect = renderer.domElement.getBoundingClientRect()
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    return ray.intersectObjects(pickers)[0]?.object.userData.col
  }
  const myTurn = () => current && current.me !== null && current.active.includes(current.me)
  renderer.domElement.addEventListener('pointermove', e => {
    const c = pick(e)
    ghost.visible = myTurn() && c !== undefined
    if (ghost.visible) {
      ghost.position.copy(cellPos(c, ROWS)).add(new THREE.Vector3(0, 0.4, 0))
      ghost.material.color.set(meta.playerColors[current.me])
    }
  })
  let down = null
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY] })
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 8) return
    const c = pick(e)
    if (myTurn() && c !== undefined) sendAction({type: 'drop', col: c})
  })

  const falling = []
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  }
  addEventListener('resize', resize)
  resize()

  let raf = 0
  const loop = () => {
    raf = requestAnimationFrame(loop)
    for (let i = falling.length - 1; i >= 0; i--) {
      const f = falling[i]
      f.v += 0.025
      f.mesh.position.y = Math.max(f.target, f.mesh.position.y - f.v)
      if (f.mesh.position.y === f.target) falling.splice(i, 1)
    }
    controls.update()
    renderer.render(scene, camera)
  }
  loop()

  return {
    update(u) {
      current = u
      const s = u.view
      s.grid.forEach((p, i) => {
        if (p === -1 || discs.has(i)) return
        const c = i % COLS, r = Math.floor(i / COLS)
        const mesh = new THREE.Mesh(discGeo, colors[p])
        mesh.castShadow = true
        const target = cellPos(c, r)
        mesh.position.set(target.x, cellPos(c, ROWS).y + 0.5, 0)
        falling.push({mesh, target: target.y, v: 0})
        scene.add(mesh)
        discs.set(i, mesh)
      })
      // Reset (new game) removes discs that are gone.
      for (const [i, mesh] of discs) if (s.grid[i] === -1) { scene.remove(mesh); discs.delete(i) }
      if (s.line) for (const [c, r] of s.line) discs.get(r * COLS + c)?.scale.setScalar(1.15)

      const name = i => u.players[i]?.name || `Player ${i + 1}`
      if (u.result) hud.textContent = `🏁 ${u.result.message}`
      else if (myTurn()) hud.textContent = u.hotseat ? `${name(u.me)}: drop a disc` : 'Your turn — tap a column'
      else hud.textContent = `Waiting for ${name(u.active[0])}…`
      hud.style.boxShadow = `inset 0 -3px 0 ${meta.playerColors[u.active[0] ?? s.winner ?? 0]}`
      if (u.error) {
        toast.textContent = u.error
        toast.style.opacity = 1
        setTimeout(() => { toast.style.opacity = 0 }, 1800)
      }
      if (!myTurn()) ghost.visible = false
    },
    dispose() {
      cancelAnimationFrame(raf)
      removeEventListener('resize', resize)
      renderer.dispose()
    }
  }
}
