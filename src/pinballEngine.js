// 핀볼(플린코) 재고·칸 로직 - 물리와 분리된 순수 로직.
// 카드팩 매대(kujiEngine.js)와 달리 가중치 RNG로 등급을 직접 뽑지 않는다.
// 대신 "지금 재고에 남은 등급을 칸에 배정 -> 공이 물리로 어느 칸에 들어가는지가 결과"
// 순서로 동작하므로, 이 파일은 등급 배정과 결과 확정만 담당하고 낙하 자체는 physicsWorld.js가 담당한다.

export class Prize {
  constructor({ grade, name, total, remaining = null, glow = '#ffffff' }) {
    this.grade = grade
    this.name = name
    this.total = total
    this.remaining = remaining === null ? total : remaining
    this.glow = glow
  }
}

// 등급 수는 이 배열의 길이로 정해진다 (하드코딩 금지 원칙) - 최대 6등급까지 지원.
// 1단계 검증용 placeholder 수량.
export function createDemoPrizes() {
  return [
    new Prize({ grade: 1, name: '1등', total: 1, glow: '#fde047' }),
    new Prize({ grade: 2, name: '2등', total: 3, glow: '#c084fc' }),
    new Prize({ grade: 3, name: '3등', total: 6, glow: '#38bdf8' }),
    new Prize({ grade: 4, name: '4등', total: 10, glow: '#4ade80' }),
  ]
}

// 등급별 물리 칸 개수 - 재고 수량(Prize.total, "몇 개 나오는지")과는 다른 개념이다.
// 여기는 "그 등급이 하단에 몇 칸을 차지하는지"를 정한다. 희귀한 등급일수록 칸을
// 적게 줘서 실제로 맞히기 어렵게 만든다. prizes 배열 순서([1등,2등,3등,4등])에 맞춘다.
export const SLOT_COUNTS_BY_PRIZE_INDEX = [1, 2, 3, 4]

// 칸 배치를 만든다. 가장 희귀한 등수는 `hardestSlotIndex`로 지정한 위치에 넣고,
// 나머지 등수는 무작위로 섞는다. 위치를 생략하면 기존처럼 마지막 칸에 배치한다.
export function buildSlotSequence(
  prizes,
  slotCounts = SLOT_COUNTS_BY_PRIZE_INDEX,
  hardestPrizeIndex = 0,
  hardestSlotIndex = null
) {
  const rest = []
  prizes.forEach((_, prizeIndex) => {
    if (prizeIndex === hardestPrizeIndex) return
    for (let n = 0; n < slotCounts[prizeIndex]; n += 1) rest.push(prizeIndex)
  })
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  const targetIndex =
    hardestSlotIndex === null ? rest.length : Math.max(0, Math.min(rest.length, Math.floor(hardestSlotIndex)))
  rest.splice(targetIndex, 0, hardestPrizeIndex)
  return rest
}

// 발사 직전, 지금 재고 상태에 맞춰 칸의 등급 구성을 세팅한다. slotSequence(칸 인덱스 ->
// prizes 배열 인덱스)는 세션 동안 고정, 잔여 0인 등급은 그 등급이 차지한 칸 전부를
// "닫힘" 상태로 표시 -> physicsWorld가 실제 막는 콜라이더를 추가.
export function buildSlotLayout(prizes, slotSequence) {
  return slotSequence.map((prizeIndex, index) => {
    const p = prizes[prizeIndex]
    return {
      index,
      grade: p.grade,
      name: p.name,
      glow: p.glow,
      open: p.remaining > 0,
    }
  })
}

// 공이 특정 칸(sensor)에 닿았을 때 호출. 닫힌 칸엔 물리적으로 못 들어가야 정상이므로
// 방어적으로만 체크한다.
export function resolveLanding(slotLayout, prizes, slotIndex) {
  const slot = slotLayout[slotIndex]
  if (!slot || !slot.open) return null

  const prize = prizes.find((p) => p.grade === slot.grade)
  if (!prize || prize.remaining <= 0) return null

  prize.remaining -= 1
  return { grade: prize.grade, name: prize.name, glow: prize.glow }
}

// 등급별 (남은/전체/실시간 확률) 뷰 - kujiEngine.js의 KujiBox.status()와 같은 모양.
export function status(prizes) {
  const total = prizes.reduce((sum, p) => sum + p.remaining, 0)
  return prizes.map((p) => ({
    grade: p.grade,
    name: p.name,
    remaining: p.remaining,
    total: p.total,
    glow: p.glow,
    probability: total === 0 ? 0 : Math.round((p.remaining / total) * 1000) / 10,
  }))
}
