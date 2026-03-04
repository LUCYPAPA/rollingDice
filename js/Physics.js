// js/Physics.js

class PhysicsDie {
  constructor(value) {
    this.x = 0
    this.y = 0
    this.vx = 0
    this.vy = 0
    this.angle = Math.random() * Math.PI * 2
    this.angularVel = (Math.random() - 0.5) * 1.2
    this.size = 46
    this.value = value
    this.displayValue = Math.ceil(Math.random() * 6)
    this.displayTimer = 0
    this.settled = false
    this.settleTimer = 0
  }
}

class PhysicsWorld {
  constructor(bowlX, bowlY, bowlRX, bowlRY) {
    this.bowlX = bowlX
    this.bowlY = bowlY
    this.bowlRX = bowlRX
    this.bowlRY = bowlRY
    this.dice = []
    this.settled = false
    this.tickCount = 0
  }

  spawnAll(values) {
    this.dice = []
    const count = values.length
    for (let i = 0; i < count; i++) {
      const die = new PhysicsDie(values[i])
      die.x = this.bowlX + (Math.random() - 0.5) * 10
      die.y = this.bowlY + (Math.random() - 0.5) * 10
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 1.1
      const speed = 16 + Math.random() * 10
      die.vx = Math.cos(angle) * speed
      die.vy = Math.sin(angle) * speed * 0.6
      die.angularVel = (Math.random() - 0.5) * 1.2
      this.dice.push(die)
    }
  }

  tick() {
    this.tickCount++
    const t = this.tickCount
    const progress = Math.min(t / 180, 1.0)

    // 线速度和旋转同步衰减，避免骰子"原地转"
    const friction    = 0.905 + progress * 0.040
    const angFriction = 0.905 + progress * 0.040  // 和线速度一致
    const restitution = 0.58  - progress * 0.38
    const gravityStr  = 0.002 + progress * progress * 0.020

    let allSettled = true

    for (let die of this.dice) {
      if (die.settled) continue
      allSettled = false

      // 软引力向碗心（后期才收拢）
      const dx = this.bowlX - die.x
      const dy = this.bowlY - die.y
      die.vx += dx * gravityStr
      die.vy += dy * gravityStr * 0.65

      // 骰子间软斥力（前期强，防止聚堆）
      for (let other of this.dice) {
        if (other === die) continue
        const rx = die.x - other.x
        const ry = die.y - other.y
        const dist = Math.sqrt(rx * rx + ry * ry)
        const repelRange = die.size * 0.9
        if (dist < repelRange && dist > 1) {
          const repelStr = (1 - dist / repelRange) * 0.10 * (1 - progress * 0.8)
          die.vx += (rx / dist) * repelStr
          die.vy += (ry / dist) * repelStr
        }
      }

      die.vx *= friction
      die.vy *= friction
      die.angularVel *= angFriction

      // 前期随机扰动，中期偶尔脉冲，保持运动感
      if (t < 100) {
        die.vx += (Math.random() - 0.5) * 0.20
        die.vy += (Math.random() - 0.5) * 0.14
      } else if (t < 150) {
        // 中期：速度过低时补一脚，防止原地转
        const spd = Math.sqrt(die.vx * die.vx + die.vy * die.vy)
        if (spd < 1.5 && Math.random() < 0.06) {
          const kickAngle = Math.random() * Math.PI * 2
          die.vx += Math.cos(kickAngle) * 1.8
          die.vy += Math.sin(kickAngle) * 1.2
        }
      }

      die.x += die.vx
      die.y += die.vy
      die.angle += die.angularVel

      // 碗壁碰撞
      const margin = die.size * 0.52
      const eRX = this.bowlRX - margin
      const eRY = this.bowlRY - margin * 0.68
      const enx = (die.x - this.bowlX) / eRX
      const eny = (die.y - this.bowlY) / eRY
      const eDist = Math.sqrt(enx * enx + eny * eny)

      if (eDist > 1.0) {
        const normalX = enx / eDist
        const normalY = eny / eDist
        die.x = this.bowlX + normalX * eRX * 0.97
        die.y = this.bowlY + normalY * eRY * 0.97
        const dot = die.vx * normalX + die.vy * normalY
        die.vx = (die.vx - 2 * dot * normalX) * restitution
        die.vy = (die.vy - 2 * dot * normalY) * restitution
        die.angularVel += (Math.random() - 0.5) * 0.4
        die.displayValue = Math.ceil(Math.random() * 6)
      }

      // 骰子间刚体碰撞
      for (let other of this.dice) {
        if (other === die || other.settled) continue
        const ddx = die.x - other.x
        const ddy = die.y - other.y
        const dist = Math.sqrt(ddx * ddx + ddy * ddy)
        const minDist = die.size * 0.92

        if (dist < minDist && dist > 0.5) {
          const nx = ddx / dist
          const ny = ddy / dist
          const overlap = (minDist - dist)
          // 完全分离，各推一半
          die.x += nx * overlap * 0.52;   die.y += ny * overlap * 0.52
          other.x -= nx * overlap * 0.52; other.y -= ny * overlap * 0.52
          const relVx = die.vx - other.vx
          const relVy = die.vy - other.vy
          const relDot = relVx * nx + relVy * ny
          if (relDot < 0) {
            const imp = relDot * (0.85 + restitution * 0.2)
            die.vx -= imp * nx;   die.vy -= imp * ny
            other.vx += imp * nx; other.vy += imp * ny
            die.angularVel   += (Math.random() - 0.5) * 0.3
            other.angularVel += (Math.random() - 0.5) * 0.3
            die.displayValue   = Math.ceil(Math.random() * 6)
            other.displayValue = Math.ceil(Math.random() * 6)
          }
        }
      }

      // 显示值跳动
      const speed = Math.sqrt(die.vx * die.vx + die.vy * die.vy)
      die.displayTimer++
      const changeInterval = Math.max(2, Math.floor(8 - speed * 0.4))
      if (die.displayTimer >= changeInterval) {
        die.displayTimer = 0
        die.displayValue = Math.ceil(Math.random() * 6)
      }

      // 静止判定：前75%时间禁止提前settle，最后25%才收拢
      if (progress < 0.75) {
        die.settleTimer = 0  // 前期强制不settle
      } else {
        if (speed < 0.9 && Math.abs(die.angularVel) < 0.05) {
          die.settleTimer++
          if (die.settleTimer > 10) {
            die.settled = true
            die.vx = 0; die.vy = 0; die.angularVel = 0
            die.displayValue = die.value
            die.angle = Math.round(die.angle / (Math.PI / 2)) * (Math.PI / 2)
          }
        } else {
          die.settleTimer = 0
        }
      }
    }

    if (allSettled)           { this._separateSettled(); this.settled = true }
    if (this.tickCount > 180) { this._forceSettle();     this.settled = true }

    // 每帧末尾做2轮位置修正，消除多体同时重叠
    if (!this.settled) {
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < this.dice.length; i++) {
          for (let j = i + 1; j < this.dice.length; j++) {
            const a = this.dice[i], b = this.dice[j]
            if (a.settled && b.settled) continue
            const dx = a.x - b.x, dy = a.y - b.y
            const dist = Math.sqrt(dx * dx + dy * dy)
            const minDist = a.size * 0.92
            if (dist < minDist && dist > 0.5) {
              const nx = dx / dist, ny = dy / dist
              const push = (minDist - dist) * 0.5
              if (!a.settled) { a.x += nx * push; a.y += ny * push }
              if (!b.settled) { b.x -= nx * push; b.y -= ny * push }
            }
          }
        }
      }
    }

    return this.settled
  }

  _separateSettled() {
    for (let pass = 0; pass < 12; pass++) {
      for (let i = 0; i < this.dice.length; i++) {
        for (let j = i + 1; j < this.dice.length; j++) {
          const a = this.dice[i], b = this.dice[j]
          const dx = a.x - b.x, dy = a.y - b.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          const minDist = a.size * 0.98
          if (dist < minDist && dist > 0.5) {
            const nx = dx / dist, ny = dy / dist
            const push = (minDist - dist) * 0.55
            a.x += nx * push; a.y += ny * push
            b.x -= nx * push; b.y -= ny * push
            this._clampToBowl(a)
            this._clampToBowl(b)
          }
        }
      }
    }
  }

  _clampToBowl(die) {
    const margin = die.size * 0.52
    const eRX = this.bowlRX - margin
    const eRY = this.bowlRY - margin * 0.68
    const nx = (die.x - this.bowlX) / eRX
    const ny = (die.y - this.bowlY) / eRY
    const d = Math.sqrt(nx * nx + ny * ny)
    if (d > 1.0) {
      die.x = this.bowlX + (nx / d) * eRX * 0.95
      die.y = this.bowlY + (ny / d) * eRY * 0.95
    }
  }

  _forceSettle() {
    for (let die of this.dice) {
      die.settled = true
      die.vx = 0; die.vy = 0; die.angularVel = 0
      die.displayValue = die.value
      die.angle = Math.round(die.angle / (Math.PI / 2)) * (Math.PI / 2)
      this._clampToBowl(die)
    }
    this._separateSettled()
  }
}
module.exports = { PhysicsWorld, PhysicsDie }
