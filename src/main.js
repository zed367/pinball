import Matter from 'matter-js'
import './style.css'
import {
  createPhysicsWorld,
  BOARD_WIDTH,
  BOARD_HEIGHT,
  LANE_LEFT,
  LANE_RIGHT,
  LAUNCH_X,
  LAUNCH_Y,
  SLOT_TOP,
  SLOT_FLOOR,
  BALL_RADIUS,
  getLaneTubePoints,
  getLaneInnerWallLine,
  getSlotBounds,
} from './physicsWorld.js'
import { createDemoPrizes, buildSlotSequence, buildSlotLayout, resolveLanding, status } from './pinballEngine.js'

// 공은 항상 LAUNCH_Y의 고정된 자리(위쪽 평평한 턱)에 놓여있다. 그 바로 아래엔
// 스프링을 담은 통(고정, TUBE_TOP)이 있고, 코일 모양은 고정된 채로만 그린다 -
// 코일 자체가 압축 애니메이션으로 움직이면 아래쪽 끝이 위로 올라가는 것처럼
// 보여서 헷갈렸다. 대신 손잡이(원)만 평소 레인 아래쪽에서 쉬다가 당기면 더
// 아래로 내려가는 걸로 "당기는 느낌"을 낸다 - 코일 밑에서 손잡이까지는 곧은
// 막대로 이어서, 당긴 만큼 늘어나는 거리를 그 막대가 채운다.
const TUBE_TOP = LAUNCH_Y + 20
const TUBE_HEIGHT = 14
const MAX_COIL_LEN = 14
const KNOB_REST_Y = BOARD_HEIGHT - 24
const MAX_PULL_PX = 20
const MIN_PULL_RATIO_TO_FIRE = 0.15
// 발사 후 이 시간(ms) 안에 어느 칸에도 착지하지 못하면(공이 어딘가 끼는 등)
// 강제로 정리하고 다시 발사할 수 있게 풀어준다.
const STUCK_BALL_TIMEOUT_MS = 4500

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
  <div class="pinball-layout">
    <div class="board-panel">
      <canvas id="board" width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}"></canvas>
    </div>
    <div class="side-panel">
      <h1>핀볼 쿠지 <span class="tag">NEON ARCADE · 1연</span></h1>
      <p class="hint">플런저 레인(오른쪽)을 아래로 당겼다 놓으면 공이 발사돼요.<br />세게 당길수록 힘차게 나가지만, 어느 칸에 들어갈지는 못을 튕기며 정해져서 세기로 결과를 고를 순 없어요.</p>
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

const prizes = createDemoPrizes()
// 10칸(4등4+3등3+2등2+1등1) 배치를 한 번 뽑아서 세션 내내 고정한다. 1등은 항상
// 맨 왼쪽(발사 경로상 가장 도달하기 어려운 자리)에 박아두고, 나머지는 매번 새로고침할
// 때마다 무작위로 섞인다.
const slotSequence = buildSlotSequence(prizes)
const slotBounds = getSlotBounds(slotSequence.length)
let slotLayout = buildSlotLayout(prizes, slotSequence)
let ballInPlay = false
let soldOut = false

const world = createPhysicsWorld({
  slotCount: slotSequence.length,
  onLanding: handleLanding,
})
world.applySlotLayout(slotLayout)
renderPrizePanel()

// ---- 플런저 드래그(포인터 이벤트) ----
let dragPointerId = null
let dragStartY = 0
let pullRatio = 0

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
  if (ballInPlay || soldOut) return
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

function endDrag(evt) {
  if (dragPointerId !== evt.pointerId) return
  dragPointerId = null
  if (pullRatio >= MIN_PULL_RATIO_TO_FIRE) {
    fireBall(pullRatio)
  }
  pullRatio = 0
}

canvas.addEventListener('pointerup', endDrag)
canvas.addEventListener('pointercancel', endDrag)

let activeBall = null
let stuckBallTimer = null

function fireBall(pull) {
  ballInPlay = true
  resultEl.textContent = '공이 굴러가는 중...'
  resultEl.className = 'result-banner rolling'
  activeBall = world.launchBall(pull)

  clearTimeout(stuckBallTimer)
  stuckBallTimer = setTimeout(() => {
    world.removeBall(activeBall)
    activeBall = null
    ballInPlay = false
    resultEl.textContent = '공이 자리를 못 잡았어요 - 다시 발사해주세요'
    resultEl.className = 'result-banner idle'
  }, STUCK_BALL_TIMEOUT_MS)
}

function handleLanding(slotIndex) {
  clearTimeout(stuckBallTimer)
  activeBall = null
  const prize = resolveLanding(slotLayout, prizes, slotIndex)
  if (!prize) {
    // 방어적 처리: 닫힌 칸으로 들어간 경우(발생하면 안 되지만) 재발사 기회를 준다.
    resultEl.textContent = '판정 불가 - 다시 발사해주세요'
    resultEl.className = 'result-banner idle'
    ballInPlay = false
    return
  }

  resultEl.textContent = `${prize.name} 당첨!`
  resultEl.style.setProperty('--glow', prize.glow)
  resultEl.className = 'result-banner win'

  slotLayout = buildSlotLayout(prizes, slotSequence)
  world.applySlotLayout(slotLayout)
  renderPrizePanel()

  const totalRemaining = prizes.reduce((sum, p) => sum + p.remaining, 0)
  if (totalRemaining <= 0) {
    soldOut = true
    resultEl.textContent = '모든 재고가 소진되었습니다'
    resultEl.className = 'result-banner idle'
  }

  setTimeout(() => {
    ballInPlay = false
  }, 500)
}

function renderPrizePanel() {
  prizeListEl.innerHTML = status(prizes)
    .map(
      (s) => `
        <li class="${s.remaining === 0 ? 'depleted' : ''}">
          <span class="dot" style="background:${s.glow}"></span>
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
  } else if (body.label.startsWith('slot-sensor-') || body.label === 'lane-rail') {
    // 감지용 센서, 그리고 레인 벽(콜라이더는 필요하지만 화면엔 drawLaneTube()가
    // 곡선까지 이어서 파이프 모양으로 대신 그린다) - 여기선 그리지 않는다.
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
  // 손잡이(원)는 평소 아래쪽에 있다가, 당기면 더 아래로(캔버스 바닥 쪽으로) 내려간다.
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

  // 대기 중인 공 - 스프링을 당겨도 움직이지 않고, 발사 지점(LAUNCH_Y)의 평평한
  // 턱 위에 항상 고정으로 놓여있다. 놓으면 스프링이 튀어올라 이 공을 때려서 쏜다.
  if (!ballInPlay) {
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(laneX - 16, LAUNCH_Y + BALL_RADIUS + 2)
    ctx.lineTo(laneX + 16, LAUNCH_Y + BALL_RADIUS + 2)
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(laneX, LAUNCH_Y, BALL_RADIUS, 0, Math.PI * 2)
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

function loop() {
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
