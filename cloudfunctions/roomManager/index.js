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
      case 'initDB':      return await initDB()
      case 'startGame':   return await startGame(event, OPENID)
      case 'addBot':      return await addBot(event, OPENID)
      case 'botRoll':     return await botRoll(event, OPENID)
      case 'abortGame':    return await abortGame(event, OPENID)
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
  if (room.status === 'finished' || room.phase === 'finished') return { success: false, error: '该局游戏已结束' }
  if (room.status === 'playing') return { success: false, error: '游戏已开始，无法加入' }
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
  if (currentPlayer.openid !== openid) return { success: false, error: '还没到你的回合' }
  if (room.phase !== 'waiting' && room.phase !== 'settled') return { success: false, error: '请等待当前操作完成' }
  const diceValues = Array.from({ length: 5 }, () => Math.ceil(Math.random() * 6))
  return rollDiceForPlayer(room, roomId, openid, diceValues)
}

async function rollDiceForPlayer(room, roomId, openid, diceValues) {
  const currentPlayer = room.players[room.currentPlayerIndex]
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

  // 实时更新赢家余额（机器人没有真实余额，跳过）
  const winnerPlayer = newPlayers[room.currentPlayerIndex]
  if (payout > 0 && winnerPlayer && !winnerPlayer.isBot) {
    await players.doc(winnerPlayer.openid).update({
      data: { balance: winnerPlayer.chips }
    }).catch(() => {})
  }

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

    if (p.isBot) continue  // 机器人不写余额

    await players.doc(p.openid).update({
      data: {
        balance: p.chips,
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
// ── 房主开始游戏 ──────────────────────────────────────────────────
async function abortGame(event, openid) {
  const { roomId } = event

  const roomRes = await rooms.doc(roomId).get().catch(() => null)
  if (!roomRes) return { success: false, error: '房间不存在' }
  const room = roomRes.data

  if (room.hostOpenid !== openid) return { success: false, error: '只有房主可以结束游戏' }
  if (room.status === 'finished') return { success: false, error: '游戏已结束' }

  const now = db.serverDate()
  const activePlayers = room.players.filter(p => p.active && !p.isBot)
  const pool = room.pool || 0

  // 底池平分（只退给真人玩家，机器人不参与）
  const share = activePlayers.length > 0 ? Math.floor(pool / activePlayers.length) : 0
  const remainder = pool - share * activePlayers.length  // 余数给房主

  const refundMap = {}
  for (const p of room.players) {
    // chips 当前值就是已结算状态，再加上底池分成
    let refund = 0
    if (!p.isBot) {
      const isHost = p.openid === room.hostOpenid
      refund = share + (isHost ? remainder : 0)
    }
    refundMap[p.openid] = refund

    // 用绝对值 set（因为 rollDiceForPlayer 已实时 set 过 chips，不能再 inc）
    if (!p.isBot) {
      const finalBalance = p.chips + refund  // chips 是当前已结算值，加上底池退还
      await players.doc(p.openid).update({
        data: { balance: finalBalance }
      }).catch(() => {})

      await ledger.add({
        data: {
          openid: p.openid,
          nickname: p.nickname,
          refund,
          chipsAtAbort: p.chips,
          finalBalance,
          roomId,
          roomCode: room.roomCode,
          reason: '房主中途结束，底池平分退还',
          isAbort: true,
          createdAt: now,
        }
      }).catch(() => {})
    }
  }

  // 房间标记废弃
  await rooms.doc(roomId).update({
    data: {
      status: 'finished',
      phase: 'aborted',
      abortedBy: openid,
      abortedAt: now,
      updatedAt: now,
    }
  })

  await logs.doc(roomId).update({
    data: { finishedAt: now, aborted: true }
  }).catch(() => {})

  return { success: true, refundMap, share }
}

async function botRoll(event, openid) {
  const { roomId, botOpenid, hostOpenid } = event
  // 验证调用者是房主
  if (openid !== hostOpenid) return { success: false, error: '非法操作' }

  const roomRes = await rooms.doc(roomId).get().catch(() => null)
  if (!roomRes) return { success: false, error: '房间不存在' }
  const room = roomRes.data

  // 验证当前回合确实是该机器人
  const cur = room.players[room.currentPlayerIndex]
  if (!cur || cur.openid !== botOpenid || !cur.isBot) {
    return { success: false, error: '当前不是该机器人的回合' }
  }

  // 用云端随机生成骰子（防作弊逻辑与真人一致）
  const diceValues = Array.from({ length: 5 }, () => Math.floor(Math.random() * 6) + 1)

  // 复用 rollDice 的结算逻辑，传入机器人 openid
  return await rollDiceForPlayer(room, roomId, botOpenid, diceValues)
}

async function addBot(event, openid) {
  const { roomId, hostOpenid } = event

  // 只有房主可以添加机器人
  const roomRes = await rooms.doc(roomId).get().catch(() => null)
  if (!roomRes) return { success: false, error: '房间不存在' }
  const room = roomRes.data
  if (room.hostOpenid !== openid) return { success: false, error: '只有房主可以添加机器人' }
  if (room.phase === 'playing') return { success: false, error: '游戏已开始' }

  // 计算机器人编号：001 002 003
  const existingBots = room.players.filter(p => p.isBot)
  if (existingBots.length >= 3) return { success: false, error: '最多添加3个机器人' }
  const botNum = String(existingBots.length + 1).padStart(3, '0')
  const botOpenid = openid + '_' + botNum
  const botNickname = '机器人' + botNum

  // 检查是否已存在该机器人
  const alreadyIn = room.players.find(p => p.openid === botOpenid)
  if (alreadyIn) return { success: false, error: '机器人已在房间内' }

  // 创建或更新机器人账号（用 set 确保 _id 固定）
  const now = db.serverDate()
  await players.doc(botOpenid).set({
    data: {
      openid: botOpenid,
      nickname: botNickname,
      avatarUrl: '',
      balance: 100,
      isBot: true,
      gamesPlayed: 0,
      createdAt: now,
      lastSeen: now,
    }
  })

  // 加入房间玩家列表
  await rooms.doc(roomId).update({
    data: {
      players: _.push({
        openid: botOpenid,
        nickname: botNickname,
        avatarUrl: '',
        chips: 100,
        initialChips: 100,
        isBot: true,
        active: true,
        isReady: true,
      }),
      updatedAt: now,
    }
  })

  const updated = await rooms.doc(roomId).get()
  return { success: true, roomData: updated.data }
}

async function startGame(event, openid) {
  const { roomId } = event
  const roomRes = await rooms.doc(roomId).get()
  if (!roomRes.data) return { success: false, error: '房间不存在' }
  const room = roomRes.data
  if (room.hostOpenid !== openid) return { success: false, error: '只有房主可以开始' }
  if (room.players.length < 2) return { success: false, error: '至少需要2名玩家才能开始' }
  if (room.phase === 'playing') return { success: false, error: '游戏已经开始' }

  const stake = room.stake || 32
  const playerCount = room.players.length
  const totalPool = stake * playerCount

  // 从每位玩家余额扣底注
  const deductPromises = room.players.map(p =>
    players.doc(p.openid).update({
      data: { balance: _.inc(-stake) }
    }).catch(() => {})
  )
  await Promise.all(deductPromises)

  // 更新房间：底池注入，状态改为 playing，玩家 chips 同步扣减
  const updatedPlayers = room.players.map(p => ({
    ...p,
    chips: p.chips - stake,
    initialChips: p.chips - stake,
  }))

  await rooms.doc(roomId).update({
    data: {
      status: 'playing',   // status 標記遊戲已開始（防止再加入）
      phase: 'waiting',    // phase 重置為 waiting，讓第一個玩家可以搖
      pool: totalPool,
      players: updatedPlayers,
      startedAt: db.serverDate(),
    }
  })
  const updated = await rooms.doc(roomId).get()
  return { success: true, roomData: updated.data }
}


// ── 初始化数据库（第一次部署后在控制台调用一次）─────────────────
async function initDB() {
  const collections = [
    'rooms',           // 房间状态
    'players',         // 玩家信息与余额
    'game_logs',       // 对局记录
    'balance_ledger',  // 余额流水审计
    'security_logs',   // 违规记录
    'admin_logs',      // 管理员操作日志
  ]
  const results = []

  for (const name of collections) {
    try {
      await db.createCollection(name)
      results.push({ collection: name, status: '创建成功' })
    } catch (e) {
      if (e.errCode === -502003 || (e.message && e.message.includes('exist'))) {
        results.push({ collection: name, status: '已存在，跳过' })
      } else {
        results.push({ collection: name, status: '失败: ' + e.message })
      }
    }
  }

  return { success: true, results }
}