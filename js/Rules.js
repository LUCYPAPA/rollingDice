// js/Rules.js - 完整规则引擎，优先级已修正，含葫芦规则

function evaluateDice(dice) {
  const counts = {}
  for (let d of dice) counts[d] = (counts[d] || 0) + 1
  const fours = counts[4] || 0
  const sorted = [...dice].sort((a, b) => a - b).join('')

  // ── 红4主线（4个及以上最高优先）──────────────────
  if (fours === 6) return { type: 'jackpot', call: '六红，夯特！', label: '六个4', amount: Infinity, emoji: '🎰' }
  if (fours === 5) return { type: 'win', call: '五红！！！',  label: '五个4', amount: 64, emoji: '🔥' }
  if (fours === 4) return { type: 'win', call: '四红！！',    label: '四个4', amount: 32, emoji: '💥' }

  // ── 格子（两个三条，3+3）优先于三个4 ─────────────
  const tripleEntries = Object.entries(counts).filter(([k, v]) => v === 3)
  if (tripleEntries.length === 2) {
    const hasFourTriple = counts[4] === 3
    if (hasFourTriple) {
      return { type: 'win', call: '红格二十四！', label: '红格（三个4+三条）', amount: 24, emoji: '🔴' }
    }
    return { type: 'win', call: '格子十六！', label: '格子（两个三条）', amount: 16, emoji: '🎲' }
  }

  // ── 三个4（非格子型）─────────────────────────────
  if (fours === 3) return { type: 'win', call: '三红！', label: '三个4', amount: 8, emoji: '🎯' }

  // ── 特殊牌型（优先于1-2个4）──────────────────────
  if (sorted === '123456') return { type: 'win', call: '八洞！',   label: '顺子123456',  amount: 16, emoji: '🌈' }
  if (sorted === '223366') return { type: 'win', call: '腻三靠！', label: '二三Call',     amount: 16, emoji: '📣' }
  if (sorted === '112233') return { type: 'win', call: '一两三！', label: '连对112233',   amount: 16, emoji: '🎊' }
  if (sorted === '445566') return { type: 'win', call: '四五六！', label: '连对445566',   amount: 19, emoji: '🎊' }

  // 三对
  const pairCount = Object.values(counts).filter(c => c >= 2).length
  if (pairCount === 3) {
    const hasFourPair = (counts[4] || 0) >= 2
    if (hasFourPair) return { type: 'win', call: '红三对！', label: '三对含一对4', amount: 11, emoji: '🎭' }
    return { type: 'win', call: '三对！', label: '三对', amount: 8, emoji: '🎭' }
  }

  // ── 六条（非4）────────────────────────────────────
  const sixKind = Object.entries(counts).find(([k, v]) => v === 6 && k !== '4')
  if (sixKind) return { type: 'win', call: '六十四！！！', label: `六个${sixKind[0]}`, amount: 64, emoji: '🌟' }

  // ── 五条（非4），剩余1骰可能是4加成 ───────────────
  const fiveKind = Object.entries(counts).find(([k, v]) => v === 5 && k !== '4')
  if (fiveKind) {
    const extra = fours >= 1 ? 1 : 0
    return {
      type: 'win',
      call: extra ? '三十三！！' : '三十两！',
      label: `五个${fiveKind[0]}${extra ? '+1红' : ''}`,
      amount: 32 + extra,
      emoji: '🌟'
    }
  }

  // ── 四条（非4），剩余2骰可能含4加成或升级 ─────────
  const fourKind = Object.entries(counts).find(([k, v]) => v === 4 && k !== '4')
  if (fourKind) {
    const n = parseInt(fourKind[0])
    const remaining = dice.filter(d => d !== n)
    const remSum = remaining.reduce((a, b) => a + b, 0)
    const remFours = remaining.filter(d => d === 4).length
    let base = 16, upgraded = false
    if (remaining.length === 2 && remSum === n) { base = 32; upgraded = true }
    let fourBonus = remFours === 1 ? 1 : remFours === 2 ? 3 : 0
    const total = base + fourBonus
    let call, label
    if (upgraded) {
      call = fourBonus ? '三十三！！' : `格${n}！！！`
      label = `四个${n}升级${fourBonus ? '+1红' : ''}`
    } else if (total === 19) { call = '十九～'; label = `四个${n}+2红` }
    else if (total === 17) { call = '十七～'; label = `四个${n}+1红` }
    else { call = '十六～'; label = `四个${n}` }
    return { type: 'win', call, label, amount: total, emoji: upgraded ? '⬆️' : '🎯' }
  }

  // ── 红4兜底（1-2个4，无更优牌型）─────────────────
  if (fours === 2) return { type: 'win', call: '两红', label: '两个4', amount: 3, emoji: '✨' }
  if (fours === 1) return { type: 'win', call: '一红', label: '一个4', amount: 1, emoji: '🎲' }

  return { type: 'none', call: '空屁一只', label: '轮空', amount: 0, emoji: '💨' }
}
module.exports = { evaluateDice }
