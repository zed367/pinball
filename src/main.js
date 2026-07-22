import Matter from 'matter-js'
import './style.css'
import {
  createPhysicsWorld,
  BOARD_WIDTH,
  BOARD_HEIGHT,
  LANE_LEFT,
  LANE_RIGHT,
  LAUNCH_Y,
  SLOT_TOP,
  SLOT_FLOOR,
  BALL_RADIUS,
  getLaneTubePoints,
  getLaneInnerWallLine,
  getSlotBounds,
} from './physicsWorld.js'
import {
  createDemoPrizes,
  buildSlotSequence,
  buildSlotLayout,
  resolveLanding,
  status,
  SLOT_COUNTS_BY_PRIZE_INDEX,
} from './pinballEngine.js'

// 스프링 모양은 고정하고, 사용자가 플런저를 당기는 동안 손잡이만 아래로 움직인다.
// 대기 공은 레인 안에 지름보다 넓은 간격으로 쌓아, 5연/10연도 서로 겹쳐 보이지
// 않게 한다. 플런저를 놓으면 이 공들을 같은 프레임에 모두 쏜다.
const TUBE_TOP = LAUNCH_Y + 20
const TUBE_HEIGHT = 14
const MAX_COIL_LEN = 14
const KNOB_REST_Y = BOARD_HEIGHT - 24
const MAX_PULL_PX = 20
const MIN_PULL_RATIO_TO_FIRE = 0.15
const QUEUE_BALL_GAP = BALL_RADIUS * 2 + 4
// 발사 시간과 무관하게, 실제 속도가 이 값 아래인 상태가 2초 이어질 때만
// 공이 끼었거나 멈춘 것으로 보고 회차를 정리한다.
const STUCK_SPEED_THRESHOLD = 0.08
const STUCK_SETTLE_TIME_MS = 2000

const NEON = Object.freeze({
  ballCore: '#e0f7ff',
  ballEdge: '#0ea5e9',
  cyan: '#38bdf8',
  bright: '#7dd3fc',
  railDark: '#0a4266',
  panel: '#071426',
  panelMuted: '#0a1d33',
  line: '#164e72',
  closed: '#0a1424',
})

const app = document.querySelector('#app')
app.innerHTML = `
  <section class="hero-banner hero-banner--image" aria-label="핀볼 쿠지 배너">
    <img id="banner-image" class="hero-banner__image" src="/banner.webp" alt="주술회전 캐릭터 배너" />
    <div class="hero-banner__art" aria-hidden="true">
      <span class="hero-banner__orb hero-banner__orb--large"></span>
      <span class="hero-banner__orb hero-banner__orb--small"></span>
      <span class="hero-banner__grid"></span>
    </div>
    <div class="hero-banner__content">
      <p class="hero-banner__eyebrow">PINBALL KUJI · NEON EDITION</p>
      <h1>NEON PRIZE DROP</h1>
      <p>플런저를 당겨 오늘의 경품 슬롯을 노려보세요.</p>
      <span class="hero-banner__image-note">BANNER IMAGE READY</span>
    </div>
  </section>
  <div class="pinball-layout">
    <div class="board-panel">
      <canvas id="board" width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}"></canvas>
    </div>
    <div class="side-panel">
      <h1>핀볼 쿠지 <span class="tag">NEON ARCADE · PULL &amp; RELEASE</span></h1>
      <button id="board-refresh" class="board-refresh" type="button">
        <span aria-hidden="true">↻</span>
        <span>판 새로고침 <small>1등 슬롯 다시 섞기</small></span>
      </button>
      <div class="draw-control" aria-label="연차 선택">
        <div class="draw-counts" role="group" aria-label="연차 선택">
          <button class="draw-count is-selected" type="button" data-draw-count="1" aria-pressed="true">1연</button>
          <button class="draw-count" type="button" data-draw-count="5" aria-pressed="false">5연</button>
          <button class="draw-count" type="button" data-draw-count="10" aria-pressed="false">10연</button>
        </div>
      </div>
      <p class="hint">연차를 고른 뒤 오른쪽 플런저를 아래로 당겼다 놓으세요.<br />5연·10연은 레인에 쌓인 공이 한 번에 모두 발사됩니다.</p>
      <div id="result" class="result-banner idle">공을 발사해보세요</div>
      <div class="prize-panel">
        <h2>재고 현황</h2>
        <ul id="prize-list"></ul>
      </div>
    </div>
  </div>
`

const canvas = document.querySelector('#board')
const ctx = canvas.getContext('2d')
const resultEl = document.querySelector('#result')
const prizeListEl = document.querySelector('#prize-list')
const boardRefreshEl = document.querySelector('#board-refresh')
const drawCountButtons = [...document.querySelectorAll('[data-draw-count]')]

const SLOT_COUNT = SLOT_COUNTS_BY_PRIZE_INDEX.reduce((total, count) => total + count, 0)
const DRAW_COUNTS = [1, 5, 10]
let prizes = createDemoPrizes()
// 1등 칸을 포함해 새 판마다 전체 배치를 다시 섞는다. 공이 이미 발사된 뒤에는
// 그 회차의 판정이 끝날 때까지 현재 배치를 유지한다.
function createRandomSlotSequence() {
  return buildSlotSequence(prizes, undefined, 0, Math.floor(Math.random() * SLOT_COUNT))
}

let slotSequence = createRandomSlotSequence()
let slotBounds = getSlotBounds(slotSequence)
let slotLayout = buildSlotLayout(prizes, slotSequence)
let ballInPlay = false
let soldOut = false
let selectedDrawCount = 1
let queuedBallCount = selectedDrawCount
let remainingLaunches = 0
let batchResults = []
let pullRatio = 0
let batchFinishTimer = null
const activeBalls = new Map()

const world = createPhysicsWorld({
  slotSequence,
  onLanding: handleLanding,
})
world.applySlotLayout(slotLayout)
renderPrizePanel()
updateDrawControls()

function setBoardRefreshEnabled(enabled) {
  boardRefreshEl.disabled = !enabled
}

function getRemainingInventory() {
  return prizes.reduce((sum, prize) => sum + prize.remaining, 0)
}

function selectAvailableDrawCount() {
  const remaining = getRemainingInventory()
  if (remaining === 0) {
    selectedDrawCount = 1
    queuedBallCount = 0
    return
  }

  if (selectedDrawCount <= remaining) {
    queuedBallCount = selectedDrawCount
    return
  }

  selectedDrawCount = DRAW_COUNTS.filter((count) => count <= remaining).at(-1) ?? 1
  queuedBallCount = selectedDrawCount
}

function updateDrawControls() {
  const remaining = getRemainingInventory()
  if (!ballInPlay) selectAvailableDrawCount()

  drawCountButtons.forEach((button) => {
    const count = Number(button.dataset.drawCount)
    const selected = count === selectedDrawCount
    button.disabled = ballInPlay || count > remaining
    button.classList.toggle('is-selected', selected)
    button.setAttribute('aria-pressed', String(selected))
  })

}

function refreshBoard() {
  if (ballInPlay) return
  clearTimeout(batchFinishTimer)
  activeBalls.clear()
  prizes = createDemoPrizes()
  slotSequence = createRandomSlotSequence()
  slotLayout = buildSlotLayout(prizes, slotSequence)
  soldOut = false
  pullRatio = 0
  batchResults = []
  remainingLaunches = 0
  slotBounds = world.updateSlotSequence(slotSequence, slotLayout)
  renderPrizePanel()
  updateDrawControls()
  resultEl.textContent = '새 판을 준비했어요 · 1등 슬롯 위치가 바뀌었습니다'
  resultEl.className = 'result-banner idle'
}

boardRefreshEl.addEventListener('click', refreshBoard)

drawCountButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (ballInPlay || button.disabled) return
    selectedDrawCount = Number(button.dataset.drawCount)
    queuedBallCount = selectedDrawCount
    updateDrawControls()
  })
})

let dragPointerId = null
let dragStartY = 0

function laneHit(x, y) {
  return x >= LANE_LEFT && x <= LANE_RIGHT && y >= BOARD_HEIGHT - 220
}

function canvasPoint(evt) {
  const rect = canvas.getBoundingClientRect()
  const scaleX = BOARD_WIDTH / rect.width
  const scaleY = BOARD_HEIGHT / rect.height
  return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY }
}

canvas.addEventListener('pointerdown', (evt) => {
  if (ballInPlay || soldOut || selectedDrawCount > getRemainingInventory()) return
  const { x, y } = canvasPoint(evt)
  if (!laneHit(x, y)) return
  dragPointerId = evt.pointerId
  dragStartY = y
  canvas.setPointerCapture(evt.pointerId)
})

canvas.addEventListener('pointermove', (evt) => {
  if (dragPointerId !== evt.pointerId) return
  const { y } = canvasPoint(evt)
  const pulled = Math.max(0, Math.min(MAX_PULL_PX, y - dragStartY))
  pullRatio = pulled / MAX_PULL_PX
})

function releasePlunger(evt) {
  if (dragPointerId !== evt.pointerId) return
  dragPointerId = null
  if (pullRatio >= MIN_PULL_RATIO_TO_FIRE) startDraw()
  pullRatio = 0
}

canvas.addEventListener('pointerup', releasePlunger)
canvas.addEventListener('pointercancel', releasePlunger)

function startDraw() {
  if (ballInPlay || soldOut || selectedDrawCount > getRemainingInventory()) return

  ballInPlay = true
  remainingLaunches = selectedDrawCount
  batchResults = []
  setBoardRefreshEnabled(false)
  resultEl.textContent = `${selectedDrawCount}개 공이 동시에 굴러가는 중...`
  resultEl.className = 'result-banner rolling'

  // 하나씩 시간차로 쏘지 않고, 플런저를 놓는 순간 쌓여 있던 모든 공을 같은 프레임에 올려보낸다.
  // 시작 y만 다르게 둬서 공끼리 겹치지 않으며, 모두 같은 순간에 속도를 받는다.
  for (let index = 0; index < remainingLaunches; index += 1) {
    const ball = world.launchBall(1, { startY: LAUNCH_Y - index * QUEUE_BALL_GAP })
    activeBalls.set(ball, { stationarySince: null })
  }
  queuedBallCount = 0
  remainingLaunches = 0
  updateDrawControls()
}

function handleLanding(slotIndex, ball) {
  activeBalls.delete(ball)
  const prize = resolveLanding(slotLayout, prizes, slotIndex)
  if (!prize) {
    batchResults.push('판정 불가')
    resultEl.textContent = `${batchResults.length}개 공 판정 완료 · 마감 칸에 도착한 공이 있어요`
    resultEl.className = 'result-banner rolling'
    finishBatchIfReady()
    return
  }

  batchResults.push(prize.name)
  resultEl.textContent = `${batchResults.length}개 공 판정 완료 · ${prize.name} 당첨!`
  resultEl.style.setProperty('--glow', prize.glow)
  resultEl.className = 'result-banner win'

  slotLayout = buildSlotLayout(prizes, slotSequence)
  world.applySlotLayout(slotLayout)
  renderPrizePanel()

  finishBatchIfReady()
}

function formatBatchResults() {
  const counts = new Map()
  batchResults.forEach((name) => counts.set(name, (counts.get(name) ?? 0) + 1))
  return [...counts.entries()]
    .map(([name, count]) => `${name} ×${count}`)
    .join(' · ')
}

function finishBatchIfReady() {
  if (!ballInPlay || remainingLaunches > 0 || activeBalls.size > 0 || batchFinishTimer) return

  // 센서에 닿은 공은 physicsWorld에서 350ms 뒤 화면에서 제거된다. 그 짧은
  // 마무리 시간을 지켜야 다음 연차가 직전 회차의 공과 겹쳐 시작되지 않는다.
  batchFinishTimer = setTimeout(() => {
    batchFinishTimer = null
    if (!ballInPlay || remainingLaunches > 0 || activeBalls.size > 0) return

    completeBatch()
  }, 360)
}

function completeBatch() {
  ballInPlay = false
  soldOut = getRemainingInventory() <= 0
  setBoardRefreshEnabled(true)
  updateDrawControls()

  if (soldOut) {
    resultEl.textContent = '모든 재고가 소진되었습니다'
    resultEl.className = 'result-banner idle'
    return
  }

  resultEl.textContent = `${batchResults.length}연 완료 · ${formatBatchResults() || '판정 불가'}`
  resultEl.className = 'result-banner win'
}

function monitorStuckBalls(now) {
  if (!ballInPlay) return

  for (const [ball, tracking] of activeBalls) {
    if (ball.speed > STUCK_SPEED_THRESHOLD) {
      tracking.stationarySince = null
      continue
    }

    if (tracking.stationarySince === null) {
      tracking.stationarySince = now
      continue
    }

    if (now - tracking.stationarySince < STUCK_SETTLE_TIME_MS) continue

    world.removeBall(ball)
    activeBalls.delete(ball)
    batchResults.push('끼임')
    resultEl.textContent = `${batchResults.length}개 공 판정 완료 · 2초 이상 멈춘 공을 정리했어요`
    resultEl.className = 'result-banner rolling'
  }

  finishBatchIfReady()
}

function renderPrizePanel() {
  prizeListEl.innerHTML = status(prizes)
    .map(
      (s) => `
        <li class="${s.remaining === 0 ? 'depleted' : ''}" style="--prize-glow:${s.glow}">
          <span class="dot"></span>
          <span class="name">${s.name}</span>
          <span class="count">${s.remaining} / ${s.total}</span>
          <span class="prob">${s.probability}%</span>
        </li>`
    )
    .join('')
}

// ---- 렌더 루프 ----
function drawBody(body) {
  ctx.beginPath()
  if (body.circleRadius) {
    ctx.arc(body.position.x, body.position.y, body.circleRadius, 0, Math.PI * 2)
  } else {
    const verts = body.vertices
    ctx.moveTo(verts[0].x, verts[0].y)
    for (let i = 1; i < verts.length; i += 1) ctx.lineTo(verts[i].x, verts[i].y)
    ctx.closePath()
  }

  if (body.label === 'ball') {
    ctx.save()
    ctx.fillStyle = NEON.ballCore
    ctx.shadowColor = NEON.cyan
    ctx.shadowBlur = 18
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = NEON.ballEdge
    ctx.stroke()
    ctx.restore()
  } else if (body.label === 'peg') {
    ctx.save()
    ctx.fillStyle = '#0d3150'
    ctx.shadowColor = '#0ea5e9'
    ctx.shadowBlur = 10
    ctx.fill()
    ctx.strokeStyle = NEON.bright
    ctx.stroke()
    ctx.restore()
  } else if (body.label.startsWith('slot-lid-')) {
    ctx.fillStyle = NEON.closed
    ctx.fill()
  } else if (body.label.startsWith('slot-sensor-') || body.label === 'lane-rail' || body.label === 'outer-boundary') {
    // 감지용 센서, 보드 외곽 안전 경계, 그리고 레인 벽(콜라이더는 필요하지만 화면엔
    // drawLaneTube()가 곡선까지 이어서 파이프 모양으로 대신 그린다) - 여기선 그리지 않는다.
  } else {
    ctx.fillStyle = NEON.line
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = '#1d668f'
    ctx.stroke()
  }
}

// 레인 콜라이더(사각형 조각들)를 그대로 그리면 각져 보여서, 대신 콜라이더와
// 같은 좌표(getLaneTubePoints)를 곡선 하나로 이어그려 매끈한 금속 레일처럼 낸다.
// 안쪽 레일은 없앴다 - 바깥쪽 가이드 하나만 있는 실물 플런저 레인에 더 가깝다.
function drawLaneTube() {
  const { outer } = getLaneTubePoints()

  function strokePath(points, width, color) {
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y)
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color
    ctx.stroke()
  }

  strokePath(outer, 16, '#082b47')
  ctx.save()
  ctx.shadowColor = '#0ea5e9'
  ctx.shadowBlur = 12
  strokePath(outer, 5, NEON.cyan)
  ctx.restore()
  strokePath(getLaneInnerWallLine(), 16, '#082b47')
  ctx.save()
  ctx.shadowColor = '#0ea5e9'
  ctx.shadowBlur = 12
  strokePath(getLaneInnerWallLine(), 5, NEON.cyan)
  ctx.restore()
}

function drawSlots() {
  const boxH = SLOT_FLOOR - SLOT_TOP - 8
  slotLayout.forEach((slot, i) => {
    const b = slotBounds[i]
    const x = b.x + 4
    const y = SLOT_TOP + 4
    const boxW = b.width - 8
    ctx.beginPath()
    ctx.roundRect(x, y, boxW, boxH, 10)
    const fill = ctx.createLinearGradient(x, y, x, y + boxH)
    fill.addColorStop(0, slot.open ? '#0b2540' : '#09111e')
    fill.addColorStop(1, slot.open ? '#061323' : '#050a12')
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 3
    ctx.save()
    if (slot.open) {
      ctx.shadowColor = slot.glow
      ctx.shadowBlur = 12
    }
    ctx.strokeStyle = slot.open ? slot.glow : '#172a3e'
    ctx.stroke()
    ctx.restore()

    ctx.fillStyle = slot.open ? slot.glow : '#577084'
    ctx.font = 'bold 14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(slot.open ? slot.name : '마감', x + boxW / 2, y + boxH / 2 + 5)
  })
}

function drawPlunger() {
  const laneX = (LANE_LEFT + LANE_RIGHT) / 2
  // 사용자가 당기는 동안만 손잡이가 아래로 내려간다.
  const pistonY = KNOB_REST_Y + pullRatio * MAX_PULL_PX

  // 스프링을 담은 통(고정, 안 움직임)
  ctx.fillStyle = '#0b2d49'
  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.rect(laneX - 10, TUBE_TOP, 20, TUBE_HEIGHT)
  ctx.fill()
  ctx.stroke()

  // 스프링(코일) 모양 자체는 고정 - 압축 애니메이션을 넣으면 코일 아래쪽 끝이
  // 위로 움직이는 걸로 보여서("당기는데 왜 위로 올라가?") 오히려 헷갈렸다.
  // 대신 손잡이+막대만 아래로 움직이는 걸로 "당기는 느낌"을 낸다.
  const coilLen = MAX_COIL_LEN
  const coilTop = TUBE_TOP + 2
  const coilBottom = coilTop + coilLen
  const coilSegments = 4
  const coilGap = coilLen / coilSegments
  ctx.strokeStyle = '#7dd3fc'
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(laneX, coilTop)
  for (let i = 1; i < coilSegments; i += 1) {
    const y = coilTop + coilGap * i
    const x = laneX + (i % 2 === 0 ? -7 : 7)
    ctx.lineTo(x, y)
  }
  ctx.lineTo(laneX, coilBottom)
  ctx.stroke()

  // 압축된 스프링 아래에서 손잡이까지는 곧은 막대 - 당긴 만큼 늘어나는 나머지
  // 거리를 이 막대가 채운다(스프링 자체는 항상 짧게 압축된 상태만 보여준다).
  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(laneX, coilBottom)
  ctx.lineTo(laneX, pistonY)
  ctx.stroke()

  ctx.save()
  ctx.fillStyle = '#0ea5e9'
  ctx.shadowColor = '#38bdf8'
  ctx.shadowBlur = 18
  ctx.beginPath()
  ctx.arc(laneX, pistonY, 14, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = '#e0f7ff'
  ctx.stroke()
  ctx.restore()

  // 연차에 맞춰 공을 레인 안에 쌓아 보인다. 실제 발사도 이와 같은 간격의 위치에서
  // 한 프레임에 이루어져, 5개·10개가 서로 겹치거나 순차 발사로 보이지 않는다.
  if (queuedBallCount > 0) {
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(laneX - 16, LAUNCH_Y + BALL_RADIUS + 2)
    ctx.lineTo(laneX + 16, LAUNCH_Y + BALL_RADIUS + 2)
    ctx.stroke()

    for (let index = queuedBallCount - 1; index >= 0; index -= 1) {
      const y = LAUNCH_Y - index * QUEUE_BALL_GAP
      ctx.beginPath()
      ctx.arc(laneX, y, BALL_RADIUS, 0, Math.PI * 2)
      ctx.save()
      ctx.fillStyle = NEON.ballCore
      ctx.shadowColor = NEON.cyan
      ctx.shadowBlur = 18
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = NEON.ballEdge
      ctx.stroke()
      ctx.restore()
    }
  }
}

function loop(now) {
  monitorStuckBalls(now)

  const bg = ctx.createLinearGradient(0, 0, 0, BOARD_HEIGHT)
  bg.addColorStop(0, '#020713')
  bg.addColorStop(0.55, '#06172b')
  bg.addColorStop(1, '#020711')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT)

  ctx.save()
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.075)'
  ctx.lineWidth = 1
  for (let x = 0; x <= BOARD_WIDTH; x += 48) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, BOARD_HEIGHT)
    ctx.stroke()
  }
  for (let y = 0; y <= BOARD_HEIGHT; y += 48) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(BOARD_WIDTH, y)
    ctx.stroke()
  }
  ctx.restore()

  drawLaneTube()

  for (const body of Matter.Composite.allBodies(world.engine.world)) {
    drawBody(body)
  }

  drawSlots()
  drawPlunger()

  requestAnimationFrame(loop)
}

loop()
