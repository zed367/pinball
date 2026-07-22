// Matter.js 물리 월드 구성 - 가로형(컴팩트) 변형, 1연(공 1개) 발사용.
// 벽 두께를 넉넉히 두고 iteration을 기본보다 높이고 고정 타임스텝 러너를 써서
// "콜라이더 미적용/터널링"(문서 9장 이슈)을 구조적으로 막는 데 초점을 둔다.
//
// 아래 좌표 상수들은 못밭 배치를 눈으로 보며 조정하기 위한 1차 placeholder다
// (문서 7장: "못밭 세부 배치는 정답이 없으므로 자유롭게 그리며 구현하며 조정").

import Matter from 'matter-js'

export const BOARD_WIDTH = 960
export const BOARD_HEIGHT = 540

const WALL = 20
// 좌·상단의 굵은 내부 벽을 없앤 만큼, 필드는 보드 외곽선 바로 안쪽까지 넓힌다.
// 20px는 캔버스 테두리와 슬롯 사이에 남기는 최소 여백이다.
export const FIELD_LEFT = 20
// 필드-레인 사이 틈이 WALL 두께와 똑같아지도록 LANE_LEFT에 딱 붙여뒀다.
// (전에는 틈이 40px라 그걸 메우는 벽이 다른 벽(20px)보다 두 배 두꺼워 보였음)
export const FIELD_RIGHT = 840
export const LANE_LEFT = 860
export const LANE_RIGHT = 920

export const PEG_RADIUS = 7
export const BALL_RADIUS = 9

export const SLOT_TOP = 420
export const SLOT_FLOOR = 520
const SLOT_SENSOR_Y = 502

// 이 높이(y) 위로는 레인이 곡선으로 꺾여 필드 쪽으로 이어진다.
export const LANE_CURVE_Y = 170

// 발사 속도: 당김 비율(0~1)에 비례해서 정해진다 - 살짝 당기면 약하게, 최대로
// 당기면 세게 나가서 "당기는 느낌"이 눈에 보이게 했다. 다만 어느 칸에 들어가는지는
// 이 속도 하나로 정해지지 않는다 - 못밭 6줄을 지나며 아주 작은 차이도 크게
// 갈리는 카오스적 튕김이 실제 결과를 결정하므로(문서 3장 원칙 2), 같은 세기로
// 쏴도 매번 다른 칸에 들어간다.
const MIN_LAUNCH_SPEED = 20
const MAX_LAUNCH_SPEED = 27

export const LAUNCH_X = (LANE_LEFT + LANE_RIGHT) / 2
export const LAUNCH_Y = BOARD_HEIGHT - 60

function makeWalls() {
  const opts = { isStatic: true, label: 'wall', friction: 0.05, restitution: 0.2 }
  // 화면의 CSS 테두리 바깥에만 존재하는 안전 경계. 공이 화면 밖으로 빠지는 것은
  // 막되, 이전처럼 좌측·상단에 굵은 내부 벽으로 보이지 않게 렌더링에서 숨긴다.
  const outerBoundaryOpts = { isStatic: true, label: 'outer-boundary', friction: 0.05, restitution: 0.2 }
  // 레인의 곧은 구간(바닥~LANE_CURVE_Y) 좌우 벽 - 콜라이더는 필요하지만 화면엔
  // main.js가 getLaneTubePoints()로 곡선까지 이어서 파이프처럼 그리므로,
  // 여기 박스 렌더는 건너뛰도록 'lane-rail' 라벨을 단다(기본 렌더러가 스킵함).
  const laneOpts = { isStatic: true, label: 'lane-rail', friction: 0.05, restitution: 0.2 }
  return [
    // 보드 외곽선에 맞춘 좌·상단 안전 경계. 내부 필드에는 별도 벽을 두지 않는다.
    Matter.Bodies.rectangle(-WALL / 2, BOARD_HEIGHT / 2, WALL, BOARD_HEIGHT, outerBoundaryOpts),
    Matter.Bodies.rectangle(BOARD_WIDTH / 2, -WALL / 2, BOARD_WIDTH, WALL, outerBoundaryOpts),
    // 레인 우측 벽 (바깥 테두리) - 곡선이 시작되는 LANE_CURVE_Y까지만 있어야
    // 그 위에서 시작되는 곡선 레일과 이어진다. 끝까지(캔버스 맨 위까지) 쭉 그리면
    // 곡선과 상관없는 직선 조각이 위쪽에 따로 튀어나와 어긋나 보인다.
    Matter.Bodies.rectangle(
      LANE_RIGHT + WALL / 2,
      (LANE_CURVE_Y + BOARD_HEIGHT) / 2,
      WALL,
      BOARD_HEIGHT - LANE_CURVE_Y,
      laneOpts
    ),
    // 필드(x<=FIELD_RIGHT)와 레인(x>=LANE_LEFT) 사이를 완전히 막는 벽 - 레인의
    // 안쪽(왼쪽) 벽 역할도 겸한다. 화면엔 기본 박스 렌더 대신 main.js가 오른쪽
    // 레일과 똑같은 금속 스타일로 그린다(getLaneInnerWallLine) - 그래서 여기선
    // 'lane-rail' 라벨을 달아 기본 렌더러가 건너뛰게 한다. FIELD_RIGHT~LANE_LEFT
    // 사이 틈을 그대로 두면 마지막 칸(4등) 옆으로 공이 새서 슬롯 센서를 못 만나고
    // 영영 안착 판정이 안 나는 버그가 생긴다 - 그 틈도 이 벽이 같이 막는다.
    Matter.Bodies.rectangle(
      (FIELD_RIGHT + LANE_LEFT) / 2,
      (LANE_CURVE_Y + BOARD_HEIGHT) / 2,
      LANE_LEFT - FIELD_RIGHT,
      BOARD_HEIGHT - LANE_CURVE_Y,
      laneOpts
    ),
    // 필드와 슬롯 영역 바닥 아래 안전망 (혹시 공이 새면 여기 걸림)
    Matter.Bodies.rectangle((FIELD_LEFT + LANE_RIGHT) / 2, BOARD_HEIGHT + WALL / 2, LANE_RIGHT - FIELD_LEFT, WALL, opts),
  ]
}

// 점 목록을 따라 이어지는 곡선형 레일(콜라이더 여러 개 이어붙임)을 만든다.
// 꺾이는 지점(조인트)마다 작은 원을 덧대서 사각형 사이 이음매 틈으로 공이
// 새는 것(터널링의 변종)을 막는다.
function makeRail(points, thickness = 16, label = 'wall') {
  const opts = { isStatic: true, label, friction: 0.05, restitution: 0.35 }
  const bodies = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const p1 = points[i]
    const p2 = points[i + 1]
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const length = Math.hypot(dx, dy)
    const angle = Math.atan2(dy, dx)
    bodies.push(Matter.Bodies.rectangle((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, length, thickness, { ...opts, angle }))
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    bodies.push(Matter.Bodies.circle(points[i].x, points[i].y, thickness / 2, opts))
  }
  return bodies
}

// 2차 베지어 곡선을 잘게 쪼갠 점들로 샘플링한다. 점 3~4개를 손으로 찍어 이으면
// 꺾이는 각이 커서 눈에 띄게 각져 보이는데, 이렇게 한 번에 15개 안팎으로 잘게
// 나누면 각 조각 사이 각도 차이가 거의 없어져 실제로 매끈한 곡선처럼 보인다.
function quadraticBezierPoints(p0, control, p1, steps = 16) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const mt = 1 - t
    points.push({
      x: mt * mt * p0.x + 2 * mt * t * control.x + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * control.y + t * t * p1.y,
    })
  }
  return points
}

// 레인 전체(바닥~곡선 끝)의 바깥쪽 경계선 좌표. 콜라이더 생성과 화면에 그리는
// 금속 레일 렌더링이 항상 같은 모양을 쓰도록 여기 한 곳에만 정의한다.
// 안쪽 레일은 없앴다 - 실물 플런저 레인도 보통 바깥쪽 가이드 하나만 있고,
// 공은 발사 시 붙는 관성으로 그 바깥쪽 벽에 자연스럽게 붙어서 돈다.
export function getLaneTubePoints() {
  const outer = [
    { x: LANE_RIGHT, y: BOARD_HEIGHT },
    ...quadraticBezierPoints({ x: LANE_RIGHT, y: LANE_CURVE_Y }, { x: LANE_RIGHT, y: 34 }, { x: 700, y: 34 }),
  ]
  return { outer }
}

// 레인의 안쪽(왼쪽) 벽 - 곡선 없이 곧은 구간(바닥~LANE_CURVE_Y)만 있다. 오른쪽
// 레일(getLaneTubePoints)과 같은 금속 스타일로 그려서 좌우 벽 모양을 맞춘다.
export function getLaneInnerWallLine() {
  return [
    { x: LANE_LEFT, y: BOARD_HEIGHT },
    { x: LANE_LEFT, y: LANE_CURVE_Y },
  ]
}

// 레인 위로 쏘아 올려진 공을 왼쪽 필드로 부드럽게 꺾어 보내는 곡선 통로 콜라이더
// (바깥쪽 레일 하나뿐). 화면엔 이 각진 조각들을 그대로 그리지 않고(그러면 각져 보임),
// main.js가 getLaneTubePoints()의 매끈한 경로를 따라 금속 레일처럼 별도로 그린다.
// label을 'lane-rail'로 달아둬서 기본 렌더러가 이 조각들을 건너뛰게 한다.
function makeLaneCurve() {
  const { outer } = getLaneTubePoints()
  return makeRail(outer, 16, 'lane-rail')
}

function makePegs() {
  const pegs = []
  const rows = 6
  const rowGap = 38
  const colGap = 54
  const startY = 165
  for (let row = 0; row < rows; row += 1) {
    const y = startY + row * rowGap
    const offset = row % 2 === 0 ? 0 : colGap / 2
    for (let x = FIELD_LEFT + 40 + offset; x < FIELD_RIGHT - 20; x += colGap) {
      pegs.push(
        Matter.Bodies.circle(x, y, PEG_RADIUS, {
          isStatic: true,
          label: 'peg',
          restitution: 0.55,
          friction: 0.05,
        })
      )
    }
  }
  return pegs
}

// 칸을 등급 수(slotCount)만큼 똑같은 너비로 나눈다. 이제 등급별 희귀도는 너비가
// 아니라 "그 등급이 몇 칸을 차지하는지"(pinballEngine.js의 SLOT_COUNTS_BY_PRIZE_INDEX)와
// "어디에 배치되는지"(1등은 항상 가장 도달하기 어려운 칸)로 표현한다.
export function getSlotBounds(slotCount) {
  const width = (FIELD_RIGHT - FIELD_LEFT) / slotCount
  const bounds = []
  for (let i = 0; i < slotCount; i += 1) {
    const x = FIELD_LEFT + width * i
    bounds.push({ x, width, center: x + width / 2 })
  }
  return bounds
}

function makeSlotDividers(bounds) {
  const dividers = []
  const xs = [...bounds.map((b) => b.x), FIELD_RIGHT]
  for (const x of xs) {
    dividers.push(
      Matter.Bodies.rectangle(x, (SLOT_TOP + SLOT_FLOOR) / 2, 6, SLOT_FLOOR - SLOT_TOP, {
        isStatic: true,
        label: 'wall',
        friction: 0.05,
        restitution: 0.2,
      })
    )
  }
  return dividers
}

function makeSlotSensors(bounds) {
  return bounds.map((b, i) =>
    Matter.Bodies.rectangle(b.center, SLOT_SENSOR_Y, b.width - 8, 12, {
      isStatic: true,
      isSensor: true,
      label: `slot-sensor-${i}`,
    })
  )
}

// 재고 소진 칸을 막는 뚜껑 - 해당 칸 입구(SLOT_TOP)를 완전히 덮는 실체 콜라이더.
function makeSlotLid(slotIndex, bounds) {
  const b = bounds[slotIndex]
  return Matter.Bodies.rectangle(b.center, SLOT_TOP + 8, b.width - 4, 16, {
    isStatic: true,
    label: `slot-lid-${slotIndex}`,
  })
}

export function createPhysicsWorld({ slotCount, onLanding }) {
  const engine = Matter.Engine.create()
  // 1보다 살짝 낮춰서 발사된 공이 좀 더 오래 떠 있게(체공 시간 확보) 했다 -
  // 안 그러면 속도를 아무리 올려도 금방 떨어져서 멀리 못 간다.
  engine.gravity.y = 0.92
  // 기본값보다 높여서 얇은 벽 뚫림(터널링)을 줄인다.
  engine.positionIterations = 12
  engine.velocityIterations = 10

  const world = engine.world
  const bounds = getSlotBounds(slotCount)
  const staticBodies = [
    ...makeWalls(),
    ...makeLaneCurve(),
    ...makePegs(),
    ...makeSlotDividers(bounds),
    ...makeSlotSensors(bounds),
  ]
  Matter.Composite.add(world, staticBodies)

  const lids = new Map() // slotIndex -> lid body
  const handledBalls = new WeakSet()

  Matter.Events.on(engine, 'collisionStart', (evt) => {
    for (const pair of evt.pairs) {
      const a = pair.bodyA
      const b = pair.bodyB
      const sensor = a.label.startsWith('slot-sensor-') ? a : b.label.startsWith('slot-sensor-') ? b : null
      const ball = a.label === 'ball' ? a : b.label === 'ball' ? b : null
      if (sensor && ball && !handledBalls.has(ball)) {
        handledBalls.add(ball)
        const slotIndex = Number(sensor.label.split('-').pop())
        onLanding(slotIndex, ball)
        setTimeout(() => Matter.Composite.remove(world, ball), 350)
      }
    }
  })

  function applySlotLayout(slotLayout) {
    for (const lid of lids.values()) Matter.Composite.remove(world, lid)
    lids.clear()
    for (const slot of slotLayout) {
      if (!slot.open) {
        const lid = makeSlotLid(slot.index, bounds)
        Matter.Composite.add(world, lid)
        lids.set(slot.index, lid)
      }
    }
  }

  // pullRatio(0~1)만큼 발사 속도가 커진다 - 살짝 당기면 약하게, 최대로 당기면
  // 세게 나가서 당기는 느낌과 실제 발사가 일치한다. 그래도 어느 칸에 들어갈지는
  // 못밭을 지나며 생기는 카오스적 튕김이 정하므로(문서 3장 원칙 2), 같은 세기로
  // 쏴도 결과 칸은 매번 달라진다 - 그 무작위성은 x축 미세 편차에서 나온다.
  function launchBall(pullRatio = 1) {
    const ball = Matter.Bodies.circle(LAUNCH_X, LAUNCH_Y, BALL_RADIUS, {
      restitution: 0.45,
      friction: 0.02,
      frictionAir: 0.0006,
      label: 'ball',
    })
    Matter.Composite.add(world, ball)
    const clampedPull = Math.max(0, Math.min(1, pullRatio))
    const speed = MIN_LAUNCH_SPEED + clampedPull * (MAX_LAUNCH_SPEED - MIN_LAUNCH_SPEED)
    Matter.Body.setVelocity(ball, { x: (Math.random() - 0.5) * 1.6, y: -speed })
    return ball
  }

  const runner = Matter.Runner.create({ delta: 1000 / 120 })
  Matter.Runner.run(runner, engine)

  function destroy() {
    Matter.Runner.stop(runner)
    Matter.World.clear(world, false)
    Matter.Engine.clear(engine)
  }

  function removeBall(ball) {
    if (ball) Matter.Composite.remove(world, ball)
  }

  return {
    engine,
    launchBall,
    applySlotLayout,
    removeBall,
    destroy,
  }
}
