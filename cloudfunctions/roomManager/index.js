// cloudfunctions/roomManager/index.js
// v1.1.0 — 骰子在云端生成（防作弊）+ 余额流水审计

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const rooms   = db.collection('rooms')
const players = db.collection('players')
const logs    = db.collection('game_logs')
const ledger  = db.collection('balance_ledger')

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()
  try {
    switch (action) {
      case 'createRoom':  return await createRoom(event, OPENID)
      case 'joinRoom':    return await joinRoom(event, OPENID)
      case 'rollDice':    return await rollDice(event, OPENID)
      case 'nextTurn':    return await nextTurn(event, OPENID)
      case 'leaveRoom':   return await leaveRoom(event, OPENID)
      case 'getRoomInfo': return await getRoomInfo(event)
      default: return { success: false, error: 'unknown action' }
    }
  } catch (e) {
    console.error('[roomManager]', action, e)
    return { success: false, error: e.message }
  }
}

async function createRoom(event, openid) {
  const { roomCode, roomId, stake = 10, maxPlayers = 6, nickname, avatarUrl } = event

  const existing = await rooms.doc(roomId).get().catch(() => null)
  if (existing) return { success: false, error: '房间号已存在，请重试' }

  const playerDoc = await players.doc(openid).get().catch(() => null)
  if (!playerDoc) return { success: false, error: '玩家账号不存在，请重新登录' }
  const balance = playerDoc.data.balance
  if (balance < stake) return { success: false, error: '余额不足' }

  const now = db.serverDate()
  await rooms.add({
    data: {
      _id: roomId,
      roomId,
      roomCode,
      status: 'waiting',
      hostOpenid: openid,
      players: [{
        openid,
        nickname: nickname || ('玩家' + openid.slice(-6)),
        avatarUrl: avatarUrl || '',
        chips: balance,
        initialChips: balance,
        active: true,
        isReady: true,
      }],
      maxPlayers,
      currentPlayerIndex: 0,
      phase: 'waiting',
      diceValues: [1, 1, 1, 1, 1],
      lastResult: null,
      lastPayout: 0,
      pool: 0,
      stake,
      round: 1,
      createdAt: now,
      updatedAt: now,
    }
  })

  await logs.add({
    data: {
      _id: roomId,
      roomId,
      roomCode,
      players: [openid],
      events: [],
      winner: null,
      finalBalances: {},
      createdAt: now,
      finishedAt: null,
    }
  })

  return { success: true, roomCode, roomId }
}

async function joinRoom(event, openid) {
  const { roomCode, roomId, nickname, avatarUrl } = event

  const roomRes = await rooms.doc(roomId).get().catch(() => null)
  if (!roomRes) return { success: false, error: ('找不到今日房间号 ' + roomCode) }

  const room = roomRes.data
  if (room.status === 'finished') return { success: false, error: '该局游戏已结束' }
  if (room.players.length >= room.maxPlayers) return { success: false, error: '房间已满' }

  const alreadyIn = room.players.find(p => p.openid === openid)
  if (alreadyIn) return { success: true, roomCode, roomId, roomData: room }

  const playerDoc = await players.doc(openid).get()
  const balance = playerDoc.data.balance

  await rooms.doc(roomId).update({
    data: {
      players: _.push({
        openid,
        nickname: nickname || ('玩家' + openid.slice(-6)),
        avatarUrl: avatarUrl || '',
        chips: balance,
        initialChips: balance,
        active: true,
        isReady: false,
      }),
      updatedAt: db.serverDate(),
    }
  })

  await logs.doc(roomId).update({
    data: { players: _.push(openid) }
  }).catch(() => {})

  const updated = await rooms.doc(roomId).get()
  return { success: true, roomCode, roomId, roomData: updated.data }
}

async function rollDice(event, openid) {
  const { roomId } = event

  const roomRes = await rooms.doc(roomId).get()
  const room = roomRes.data

  const currentPlayer = room.players[room.currentPlayerIndex]
  if (currentPlayer.openid !== openid) {
    return { success: false, error: '还没到你的回合' }
  }
  if (room.phase !== 'waiting' && room.phase !== 'settled') {
    return { success: false, error: '请等待当前操作完成' }
  }

  // 骰子由云端生成，客户端无法篡改
  const diceValues = Array.from({ length: 6 }, () => Math.ceil(Math.random() * 6))

  const result = _evaluateDice(diceValues)
  const pool = room.pool
  let payout = 0
  let newPool = pool

  if (result.type !== 'none') {
    payout = result.amount === Infinity ? pool : Math.min(result.amount, pool)
    newPool = Math.max(0, pool - payout)
  }

  const newPlayers = room.players.map((p, i) => {
    if (i === room.currentPlayerIndex && payout > 0) {
      return Object.assign({}, p, { chips: p.chips + payout })
    }
    return p
  })

  await rooms.doc(roomId).update({
    data: {
      diceValues,
      phase: 'settled',
      lastResult: result,
      lastPayout: payout,
      pool: newPool,
      players: newPlayers,
      updatedAt: db.serverDate(),
    }
  })

  await logs.doc(roomId).update({
    data: {
      events: _.push({
        round: room.round,
        playerOpenid: openid,
        playerNickname: currentPlayer.nickname,
        diceValues,
        resultType: result.type,
        resultLabel: result.label || '',
        payout,
        poolBefore: pool,
        poolAfter: newPool,
        timestamp: db.serverDate(),
      })
    }
  }).catch(() => {})

  return { success: true, diceValues, result, payout, newPool }
}

async function nextTurn(event, openid) {
  const { roomId } = event
  const roomRes = await rooms.doc(roomId).get()
  const room = roomRes.data

  const currentPlayer = room.players[room.currentPlayerIndex]
  if (currentPlayer.openid !== openid && room.hostOpenid !== openid) {
    return { success: false, error: '无权限操作' }
  }

  const total = room.players.length
  let nextIdx = room.currentPlayerIndex
  for (let i = 1; i <= total; i++) {
    const candidate = (room.currentPlayerIndex + i) % total
    if (room.players[candidate].active) { nextIdx = candidate; break }
  }

  const activePlayers = room.players.filter(p => p.active)
  if (activePlayers.length <= 1) {
    await _finishGame(roomId, room, activePlayers[0] ? activePlayers[0].openid : null)
    return { success: true, finished: true }
  }

  await rooms.doc(roomId).update({
    data: {
      currentPlayerIndex: nextIdx,
      phase: 'waiting',
      round: nextIdx === 0 ? _.inc(1) : room.round,
      updatedAt: db.serverDate(),
    }
  })

  return { success: true, nextPlayerIndex: nextIdx }
}

async function leaveRoom(event, openid) {
  const { roomId } = event
  const roomRes = await rooms.doc(roomId).get().catch(() => null)
  if (!roomRes) return { success: true }

  const newPlayers = roomRes.data.players.map(p =>
    p.openid === openid ? Object.assign({}, p, { active: false }) : p
  )
  await rooms.doc(roomId).update({
    data: { players: newPlayers, updatedAt: db.serverDate() }
  })
  return { success: true }
}

async function getRoomInfo(event) {
  const res = await rooms.doc(event.roomId).get()
  return { success: true, roomData: res.data }
}

async function _finishGame(roomId, room, winnerOpenid) {
  const now = db.serverDate()
  const finalBalances = {}

  for (const p of room.players) {
    const delta = p.chips - p.initialChips
    finalBalances[p.openid] = p.chips

    await players.doc(p.openid).update({
      data: {
        balance: _.inc(delta),
        gamesPlayed: _.inc(1),
      }
    })

    // 余额流水：每一笔永久留存，可审计
    await ledger.add({
      data: {
        openid: p.openid,
        nickname: p.nickname,
        delta,
        balanceBefore: p.initialChips,
        balanceAfter: p.chips,
        roomId,
        roomCode: room.roomCode,
        reason: delta >= 0 ? '游戏获胜' : '游戏亏损',
        isWinner: p.openid === winnerOpenid,
        createdAt: now,
      }
    })
  }

  await rooms.doc(roomId).update({
    data: { status: 'finished', winner: winnerOpenid, phase: 'finished', updatedAt: now }
  })

  await logs.doc(roomId).update({
    data: { winner: winnerOpenid, finalBalances, finishedAt: now }
  }).catch(() => {})
}

// 骰子规则（云端版，与前端 Rules.js 保持同步）
function _evaluateDice(dice) {
  const counts = {}
  dice.forEach(v => { counts[v] = (counts[v] || 0) + 1 })
  const vals = Object.values(counts).sort((a, b) => b - a)
  const keys = Object.keys(counts).map(Number)

  if (vals[0] === 5) {
    const n = keys[0]
    return { type: 'wuzi', label: '五子' + n, call: '五子' + n + '！', emoji: '🎰', amount: Infinity }
  }
  if (dice.filter(v => v === 1).length >= 1 && [1,2,3,4,5].every(v => dice.includes(v))) {
    return { type: 'zhuangyuan', label: '状元插金花', call: '状元！', emoji: '🏅', amount: Infinity }
  }
  if (vals[0] === 4) {
    const n = keys.find(k => counts[k] === 4)
    const amounts = { 1:80, 2:40, 3:30, 4:20, 5:30, 6:40 }
    return { type: 'sizi', label: '四子' + n, call: '四子' + n + '！', emoji: '🎯', amount: amounts[n] || 20 }
  }
  if (counts[1] >= 3) {
    return { type: 'sanhong', label: '三红', call: '三红！', emoji: '🔴', amount: 60 }
  }
  if (keys.length === 6) {
    return { type: 'duitang', label: '对堂', call: '对堂！', emoji: '🌈', amount: 60 }
  }
  if (vals[0] === 3 && keys.find(k => counts[k] === 3) !== 1) {
    const n = keys.find(k => counts[k] === 3)
    const amounts = { 2:10, 3:10, 4:10, 5:20, 6:20 }
    return { type: 'sanzi', label: '三子' + n, call: '三' + n + '！', emoji: '✨', amount: amounts[n] || 10 }
  }
  return { type: 'none', label: '轮空', call: '', emoji: '', amount: 0 }
}