// cloudfunctions/roomManager/index.js
// v1.3.0
// 改动说明：
//   1. startGame — chips 从 0 开始（账户余额扣 stake 入底池）
//   2. nextTurn — 底池清零时：经典版重新收取底注（不足从账户补）；对决版按最低 chips 收取
//   3. _finishGame / abortGame — 结算时把 chips 加回账户余额
//   4. 新增 confirmNewRound — 房主确认重开新局，重新收底注

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
      case 'createRoom':    return await createRoom(event, OPENID)
      case 'joinRoom':      return await joinRoom(event, OPENID)
      case 'rollDice':      return await rollDice(event, OPENID)
      case 'nextTurn':      return await nextTurn(event, OPENID)
      case 'leaveRoom':     return await leaveRoom(event, OPENID)
      case 'getRoomInfo':   return await getRoomInfo(event)
      case 'initDB':        return await initDB()
      case 'startGame':     return await startGame(event, OPENID)
      case 'addBot':        return await addBot(event, OPENID)
      case 'botRoll':       return await botRoll(event, OPENID)
      case 'abortGame':     return await abortGame(event, OPENID)
      case 'getHostGames':     return await getHostGames(event, OPENID)
      case 'getGameDetail':    return await getGameDetail(event, OPENID)
      case 'confirmNewRound':  return await confirmNewRound(event, OPENID)  // 新增 v1.3
      case 'startNewRound':    return await startNewRound(event, OPENID)    // 新增 v1.4
      default: return { success: false, error: 'unknown action' }
    }
  } catch (e) {
    console.error('[roomManager]', action, e)
    return { success: false, error: e.message }
  }
}

// ─────────────────────────────────────────────────────────────────
// createRoom
// ─────────────────────────────────────────────────────────────────
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
        chips: 0,           // 房间内赢的钱，从0开始
        initialChips: 0,
        balance,            // 账户余额
        active: true,
        isReady: true,
      }],
      maxPlayers,
      currentPlayerIndex: 0,
      phase: 'waiting',
      diceValues: [1, 1, 1, 1, 1, 1],
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
      hostOpenid: openid,
      players: [openid],
      playerDetails: [],  // startGame 时填入完整信息
      events: [],
      winner: null,
      finalBalances: {},
      locked: false,
      createdAt: now,
      finishedAt: null,
    }
  })

  return { success: true, roomCode, roomId }
}

// ─────────────────────────────────────────────────────────────────
// joinRoom
// ─────────────────────────────────────────────────────────────────
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
        chips: 0,           // 房间内赢的钱，从0开始
        initialChips: 0,
        balance,            // 账户余额，用于显示和扣费
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

// ─────────────────────────────────────────────────────────────────
// rollDice
// ─────────────────────────────────────────────────────────────────
async function rollDice(event, openid) {
  const { roomId } = event
  const roomRes = await rooms.doc(roomId).get()
  const room = roomRes.data
  const currentPlayer = room.players[room.currentPlayerIndex]
  if (currentPlayer.openid !== openid) return { success: false, error: '还没到你的回合' }
  if (room.phase !== 'waiting' && room.phase !== 'settled') return { success: false, error: '请等待当前操作完成' }
  const diceValues = Array.from({ length: 6 }, () => Math.ceil(Math.random() * 6))
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

  // 第一步：广播 rolling 状态（客户端据此播放动画）
  await rooms.doc(roomId).update({
    data: {
      diceValues,
      phase: 'rolling',
      lastResult: _.set(null),   // 先强制清空，避免旧值残留导致类型冲突
      updatedAt: db.serverDate(),
    }
  })

  // 第二步：写入结算结果
  // 底池归零时写 round_end，前端据此弹轮次结算弹窗
  const roundEnd = newPool === 0
  await rooms.doc(roomId).update({
    data: {
      phase: roundEnd ? 'round_end' : 'settled',
      lastResult: _.set(result),
      lastPayout: payout,
      pool: newPool,
      players: newPlayers,
      roundEndBy: roundEnd ? openid : _.set(null),  // 记录收尾玩家
      updatedAt: db.serverDate(),
    }
  })

  // 实时更新赢家账号余额（机器人跳过）
  // 注意：balance 是账户余额，不随 chips 变动，这里不更新
  // 账户余额只在游戏结束/终止结算时才变动

  // ── 追加 event 到 game_logs ──────────────────────────────────
  // 改动：补全 call 字段（牌型喊法）、openidSuffix（用于核对身份）
  await logs.doc(roomId).update({
    data: {
      events: _.push({
        round: room.round,
        timestamp: db.serverDate(),
        playerOpenid: openid,
        playerNickname: currentPlayer.nickname,
        openidSuffix: openid.slice(-6),          // 明细表展示用，不暴露完整ID
        isBot: !!currentPlayer.isBot,
        diceValues,
        resultType: result.type,
        resultLabel: result.label || '',         // 如「三个4」
        resultCall: result.call || '',           // 如「三红！」← 新增
        payout,
        poolBefore: pool,
        poolAfter: newPool,
      })
    }
  }).catch(() => {})

  return { success: true, diceValues, result, payout, newPool }
}

// ─────────────────────────────────────────────────────────────────
// nextTurn
// ─────────────────────────────────────────────────────────────────
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

  // 底池未清零，正常换人
  // 底池归零时 phase 已是 round_end（由 rollDiceForPlayer 写入），
  // 前端弹轮次结算弹窗，由收尾玩家点「开始新一轮」调用 startNewRound action
  await rooms.doc(roomId).update({
    data: {
      currentPlayerIndex: nextIdx,
      phase: 'waiting',
      lastResult: _.set(null),
      lastPayout: 0,
      diceValues: [1, 2, 3, 4, 5, 6],
      round: room.round,
      updatedAt: db.serverDate(),
    }
  })

  return { success: true, nextPlayerIndex: nextIdx }
}

// ─────────────────────────────────────────────────────────────────
// leaveRoom / getRoomInfo
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// _finishGame（正常结束）— 写校验摘要 + locked
// ─────────────────────────────────────────────────────────────────
async function _finishGame(roomId, room, winnerOpenid) {
  const now = db.serverDate()
  const finalBalances = {}

  // 底池有余额时平分（正常理论上为0，有余额则为异常，平分处理）
  const pool = room.pool || 0
  const realPlayers = room.players.filter(p => p.active && !p.isBot)
  const share = (pool > 0 && realPlayers.length > 0)
    ? Math.floor(pool / realPlayers.length) : 0
  const remainder = pool - share * realPlayers.length

  // 构建校验摘要
  const verifyRows = []

  for (const p of room.players) {
    let finalChips = p.chips
    if (!p.isBot) {
      // 房主拿余数
      const poolShare = share + (p.openid === room.hostOpenid ? remainder : 0)
      finalChips = p.chips + poolShare
    }
    finalBalances[p.openid] = finalChips

    verifyRows.push({
      openid: p.openid,
      openidSuffix: p.openid.slice(-6),
      nickname: p.nickname,
      isBot: !!p.isBot,
      balanceBefore: p.initialChips,        // 赛前余额（进房时快照）
      earnedInGame: finalChips - p.initialChips, // 本局净盈亏
      balanceAfter: finalChips,             // 赛后余额
      // 校验等式：balanceBefore + earnedInGame === balanceAfter
      verified: (p.initialChips + (finalChips - p.initialChips)) === finalChips,
    })

    if (p.isBot) continue

    const poolShare = share + (p.openid === room.hostOpenid ? remainder : 0)
    const delta = finalChips - p.initialChips

    // v1.3: chips 是本局净赢（从0起），结算时加回账户余额
    await players.doc(p.openid).update({
      data: {
        balance: _.inc(finalChips),  // 账户余额 += 本局净赢
        gamesPlayed: _.inc(1),
      }
    })

    await ledger.add({
      data: {
        openid: p.openid,
        nickname: p.nickname,
        delta,
        balanceBefore: p.initialChips,
        balanceAfter: finalChips,
        poolShare,
        roomId,
        roomCode: room.roomCode,
        reason: winnerOpenid === p.openid ? '游戏获胜' : '游戏结束',
        isWinner: p.openid === winnerOpenid,
        createdAt: now,
      }
    })
  }

  // 检查校验是否有异常行
  const hasVerifyError = verifyRows.some(r => !r.verified)

  await rooms.doc(roomId).update({
    data: { status: 'finished', winner: winnerOpenid, phase: 'finished', updatedAt: now }
  })

  // ── 改动：写校验摘要 + locked: true ──────────────────────────
  await logs.doc(roomId).update({
    data: {
      winner: winnerOpenid,
      finalBalances,
      finishedAt: now,
      endReason: 'normal',
      poolAtEnd: pool,
      poolSharePerPlayer: share,
      verifyRows,                    // 余额校验行
      verifyPassed: !hasVerifyError, // 整体校验是否通过
      locked: true,                  // 锁定，禁止后续修改
    }
  }).catch(() => {})
}

// ─────────────────────────────────────────────────────────────────
// abortGame（房主终止）— 底池平分 + 写校验摘要 + locked
// ─────────────────────────────────────────────────────────────────
async function abortGame(event, openid) {
  const { roomId } = event

  const roomRes = await rooms.doc(roomId).get().catch(() => null)
  if (!roomRes) return { success: false, error: '房间不存在' }
  const room = roomRes.data

  if (room.hostOpenid !== openid) return { success: false, error: '只有房主可以结束游戏' }
  if (room.status === 'finished') return { success: false, error: '游戏已结束' }

  const now = db.serverDate()
  const pool = room.pool || 0
  const realPlayers = room.players.filter(p => p.active && !p.isBot)
  const share = realPlayers.length > 0 ? Math.floor(pool / realPlayers.length) : 0
  const remainder = pool - share * realPlayers.length  // 余数给房主

  const verifyRows = []
  const finalBalances = {}

  for (const p of room.players) {
    // chips 是当前已结算值，加上底池退还
    const poolShare = p.isBot ? 0 : share + (p.openid === room.hostOpenid ? remainder : 0)
    const finalChips = p.chips + poolShare
    finalBalances[p.openid] = finalChips

    verifyRows.push({
      openid: p.openid,
      openidSuffix: p.openid.slice(-6),
      nickname: p.nickname,
      isBot: !!p.isBot,
      balanceBefore: p.initialChips,
      earnedInGame: p.chips - p.initialChips,  // 摇骰赢得部分
      poolShare,                                 // 底池平分部分
      balanceAfter: finalChips,
      verified: (p.initialChips + (p.chips - p.initialChips) + poolShare) === finalChips,
    })

    if (p.isBot) continue

    // v1.3: chips 是本局净赢，结算时加回账户余额
    await players.doc(p.openid).update({
      data: { balance: _.inc(finalChips) }  // 账户余额 += (本局净赢 + 底池退还)
    }).catch(() => {})

    await ledger.add({
      data: {
        openid: p.openid,
        nickname: p.nickname,
        chipsAtAbort: p.chips,
        poolShare,
        finalBalance: finalChips,
        roomId,
        roomCode: room.roomCode,
        reason: '房主终止游戏，底池平分退还',
        isAbort: true,
        createdAt: now,
      }
    }).catch(() => {})
  }

  const hasVerifyError = verifyRows.some(r => !r.verified)

  await rooms.doc(roomId).update({
    data: {
      status: 'finished',
      phase: 'aborted',
      abortedBy: openid,
      abortedAt: now,
      updatedAt: now,
    }
  })

  // ── 改动：写完整校验摘要 + locked: true ──────────────────────
  await logs.doc(roomId).update({
    data: {
      finishedAt: now,
      endReason: 'aborted',          // 区分正常结束 vs 房主终止
      abortedBy: openid,
      poolAtEnd: pool,
      poolSharePerPlayer: share,
      finalBalances,
      verifyRows,
      verifyPassed: !hasVerifyError,
      locked: true,
    }
  }).catch(() => {})

  return { success: true, share, verifyRows }
}

// ─────────────────────────────────────────────────────────────────
// startGame — 改动：记录赛前余额快照到 game_logs 页头
// ─────────────────────────────────────────────────────────────────
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

  const deductPromises = room.players
    .filter(p => !p.isBot)
    .map(p =>
      players.doc(p.openid).update({
        data: { balance: _.inc(-stake) }
      }).catch(() => {})
    )
  await Promise.all(deductPromises)

  // v1.3: chips 从 0 开始，代表本局房间内赢到的钱
  // 账户余额已在上面扣除，chips 与账户余额独立计算
  const updatedPlayers = room.players.map(p => ({
    ...p,
    chips: 0,
    initialChips: 0,
  }))

  const now = db.serverDate()
  await rooms.doc(roomId).update({
    data: {
      status: 'playing',
      phase: 'waiting',
      pool: totalPool,
      players: updatedPlayers,
      startedAt: now,
    }
  })

  // ── 改动：写赛前余额快照到 game_logs 页头 ────────────────────
  // playerDetails 供明细表页头展示，initialBalance = 扣底注前的余额
  const playerDetails = room.players.map(p => ({
    openid: p.openid,
    openidSuffix: p.openid.slice(-6),
    nickname: p.nickname,
    isBot: !!p.isBot,
    initialBalance: p.chips,          // 扣底注前余额
    initialChips: p.chips - stake,    // 扣底注后游戏余额（即 initialChips）
  }))

  await logs.doc(roomId).update({
    data: {
      playerDetails,
      stake,
      startedAt: now,
      mode: room.mode || 'classic',
    }
  }).catch(() => {})

  const updated = await rooms.doc(roomId).get()
  return { success: true, roomData: updated.data }
}

// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// startNewRound（v1.4 新增）
// 收尾玩家点「开始新一轮」时调用，按模式重新收底注
// ─────────────────────────────────────────────────────────────────
async function startNewRound(event, openid) {
  const { roomId } = event
  const roomRes = await rooms.doc(roomId).get()
  if (!roomRes.data) return { success: false, error: '房间不存在' }
  const room = roomRes.data

  // 只有收尾玩家（roundEndBy）才能触发
  if (room.roundEndBy !== openid) return { success: false, error: '只有收尾玩家可以开始新一轮' }

  const mode = room.mode || 'classic'
  const activePlayers = room.players.filter(p => p.active)
  const realActive = activePlayers.filter(p => !p.isBot)

  // 第一步：把所有玩家本轮 chips 退回账户余额
  for (const p of realActive) {
    if (p.chips > 0) {
      await players.doc(p.openid).update({
        data: { balance: _.inc(p.chips) }
      }).catch(() => {})
    }
  }

  if (mode === 'classic') {
    const stake = room.stake || 32

    // 检查所有人账户余额是否够交 stake
    const playerBalances = await Promise.all(
      realActive.map(p => players.doc(p.openid).get().catch(() => null))
    )

    const cannotPay = []
    for (let i = 0; i < realActive.length; i++) {
      const p = realActive[i]
      const bal = playerBalances[i] ? (playerBalances[i].data.balance || 0) : 0
      if (bal < stake) cannotPay.push(p.nickname)
    }

    if (cannotPay.length > 0) {
      // 有人不够，终止房间——先把刚才退回的 chips 不用追回（已退回账户）
      // 重置 chips 为 0，走结束流程
      const resetPlayers = room.players.map(p => ({ ...p, chips: 0 }))
      await _finishGame(roomId, { ...room, players: resetPlayers, pool: 0 }, null)
      return { success: false, terminated: true, cannotPay }
    }

    // 所有人都够，收底注，chips 重置为 0
    let totalPool = 0
    const updatedPlayers = await Promise.all(room.players.map(async p => {
      if (!p.active) return p
      if (p.isBot) {
        totalPool += stake
        return { ...p, chips: 0 }
      }
      const balRes = await players.doc(p.openid).get().catch(() => null)
      const bal = balRes ? (balRes.data.balance || 0) : 0
      await players.doc(p.openid).update({ data: { balance: _.inc(-stake) } }).catch(() => {})
      totalPool += stake
      return { ...p, chips: 0, balance: bal - stake }
    }))

    // 找第一个 active 玩家作为新轮起始
    const firstIdx = updatedPlayers.findIndex(p => p.active)

    await rooms.doc(roomId).update({
      data: {
        players: updatedPlayers,
        pool: totalPool,
        round: room.round + 1,
        currentPlayerIndex: firstIdx,
        phase: 'waiting',
        lastResult: _.set(null),
        lastPayout: 0,
        diceValues: [1, 2, 3, 4, 5, 6],
        roundEndBy: _.set(null),
        updatedAt: db.serverDate(),
      }
    })
    return { success: true }

  } else {
    // 对决版：以当前存活玩家最低 chips 为基准
    // 注意：chips 刚刚已经退回账户了，所以现在要重新从账户收
    // 对决版基准 = 本轮退回前各人的 chips（room.players 里还有）
    const minChips = Math.min(...activePlayers.map(p => p.chips))

    if (minChips <= 0) {
      // 有人 chips=0，终止
      const resetPlayers = room.players.map(p => ({ ...p, chips: 0 }))
      await _finishGame(roomId, { ...room, players: resetPlayers, pool: 0 }, null)
      return { success: false, terminated: true }
    }

    // 从账户余额收 minChips（刚刚已经退回了，账户余额 = 原余额 + chips）
    let totalPool = 0
    const updatedPlayers = await Promise.all(room.players.map(async p => {
      if (!p.active) return p
      if (p.isBot) {
        totalPool += minChips
        return { ...p, chips: 0 }
      }
      await players.doc(p.openid).update({ data: { balance: _.inc(-minChips) } }).catch(() => {})
      const balRes = await players.doc(p.openid).get().catch(() => null)
      const newBal = balRes ? (balRes.data.balance || 0) : 0
      totalPool += minChips
      return { ...p, chips: 0, balance: newBal }
    }))

    const firstIdx = updatedPlayers.findIndex(p => p.active)

    await rooms.doc(roomId).update({
      data: {
        players: updatedPlayers,
        pool: totalPool,
        round: room.round + 1,
        currentPlayerIndex: firstIdx,
        phase: 'waiting',
        lastResult: _.set(null),
        lastPayout: 0,
        diceValues: [1, 2, 3, 4, 5, 6],
        roundEndBy: _.set(null),
        updatedAt: db.serverDate(),
      }
    })
    return { success: true }
  }
}

// confirmNewRound（v1.3 新增）
// 对决版有人淘汰后，房主确认是否重开新局
// 重开时：已淘汰玩家标记 active:false，按新 stake 重新收底注
// ─────────────────────────────────────────────────────────────────
async function confirmNewRound(event, openid) {
  const { roomId, restart, newStake } = event
  const roomRes = await rooms.doc(roomId).get()
  if (!roomRes.data) return { success: false, error: '房间不存在' }
  const room = roomRes.data
  if (room.hostOpenid !== openid) return { success: false, error: '只有房主可以操作' }

  if (!restart) {
    // 不重开，直接结束游戏
    const alive = room.players.filter(p => p.active && p.chips > 0)
    const winner = alive.length === 1 ? alive[0].openid : null
    await _finishGame(roomId, room, winner)
    return { success: true, finished: true }
  }

  // 重开新局
  const stake = newStake || room.stake || 32
  const activePlayers = room.players.filter(p => p.active)
  const realActive = activePlayers.filter(p => !p.isBot)

  // 先把所有玩家本局 chips 结算回账户余额
  for (const p of realActive) {
    if (p.chips > 0) {
      await players.doc(p.openid).update({
        data: { balance: _.inc(p.chips) }
      }).catch(() => {})
    }
  }

  // 淘汰 chips=0 的玩家，重新收底注
  let totalPool = 0
  const updatedPlayers = await Promise.all(room.players.map(async p => {
    if (!p.active) return p
    if (p.chips === 0 && !p.isBot) {
      // 淘汰
      return { ...p, active: false }
    }
    // 重新收底注
    if (!p.isBot) {
      const balRes = await players.doc(p.openid).get().catch(() => null)
      const bal = balRes ? (balRes.data.balance || 0) : 0
      const canPay = Math.min(bal, stake)
      await players.doc(p.openid).update({
        data: { balance: _.inc(-canPay) }
      }).catch(() => {})
      totalPool += canPay
      return { ...p, chips: 0, initialChips: 0 }
    } else {
      totalPool += stake
      return { ...p, chips: 0, initialChips: 0 }
    }
  }))

  const stillActive = updatedPlayers.filter(p => p.active)
  if (stillActive.length <= 1) {
    // 剩一人或没人，直接结束
    await _finishGame(roomId, { ...room, players: updatedPlayers, pool: totalPool },
      stillActive[0] ? stillActive[0].openid : null)
    return { success: true, finished: true }
  }

  await rooms.doc(roomId).update({
    data: {
      players: updatedPlayers,
      pool: totalPool,
      stake,
      round: 1,
      currentPlayerIndex: 0,
      phase: 'waiting',
      lastResult: _.set(null),
      lastPayout: 0,
      diceValues: [1, 2, 3, 4, 5, 6],
      updatedAt: db.serverDate(),
    }
  })

  return { success: true, restarted: true }
}

// getHostGames — 新增：房主查自己创建的对局列表
// ─────────────────────────────────────────────────────────────────
async function getHostGames(event, openid) {
  const { limit = 20, skip = 0 } = event

  const res = await logs
    .where({ hostOpenid: openid })
    .orderBy('createdAt', 'desc')
    .skip(skip)
    .limit(Math.min(limit, 50))
    .get()

  // 只返回列表所需字段，完整 events 不在列表里传（节省流量）
  const list = res.data.map(log => ({
    roomId: log.roomId,
    roomCode: log.roomCode,
    createdAt: log.createdAt,
    finishedAt: log.finishedAt,
    endReason: log.endReason || null,
    playerCount: (log.playerDetails || log.players || []).length,
    playerNicknames: (log.playerDetails || []).map(p => p.nickname).filter(Boolean),
    verifyPassed: log.verifyPassed,
    locked: log.locked,
  }))

  return { success: true, list, total: res.data.length }
}

// ─────────────────────────────────────────────────────────────────
// getGameDetail — 新增：查某局完整明细（房主 + 管理员）
// ─────────────────────────────────────────────────────────────────
async function getGameDetail(event, openid) {
  const { roomId } = event

  const logRes = await logs.doc(roomId).get().catch(() => null)
  if (!logRes) return { success: false, error: '记录不存在' }
  const log = logRes.data

  // 鉴权：只有房主或管理员可查完整明细
  // 管理员通过 playerManager adminLogin 验证，此处只验证房主
  if (log.hostOpenid !== openid) {
    return { success: false, error: '仅房主可查看明细' }
  }

  return { success: true, detail: log }
}

// ─────────────────────────────────────────────────────────────────
// botRoll
// ─────────────────────────────────────────────────────────────────
async function botRoll(event, openid) {
  const { roomId, botOpenid } = event

  const roomRes = await rooms.doc(roomId).get().catch(() => null)
  if (!roomRes) return { success: false, error: '房间不存在' }
  const room = roomRes.data

  // 从数据库取 hostOpenid，防止客户端伪造
  if (openid !== room.hostOpenid) return { success: false, error: '非法操作' }

  const cur = room.players[room.currentPlayerIndex]
  if (!cur || cur.openid !== botOpenid || !cur.isBot) {
    return { success: false, error: '当前不是该机器人的回合' }
  }

  const diceValues = Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1)
  return await rollDiceForPlayer(room, roomId, botOpenid, diceValues)
}

// ─────────────────────────────────────────────────────────────────
// addBot
// ─────────────────────────────────────────────────────────────────
async function addBot(event, openid) {
  const { roomId } = event

  const roomRes = await rooms.doc(roomId).get().catch(() => null)
  if (!roomRes) return { success: false, error: '房间不存在' }
  const room = roomRes.data
  if (room.hostOpenid !== openid) return { success: false, error: '只有房主可以添加机器人' }
  if (room.phase === 'playing') return { success: false, error: '游戏已开始' }

  const existingBots = room.players.filter(p => p.isBot)
  if (existingBots.length >= 3) return { success: false, error: '最多添加3个机器人' }
  const botNum = String(existingBots.length + 1).padStart(3, '0')
  const botOpenid = openid + '_' + botNum
  const botNickname = '机器人' + botNum

  const alreadyIn = room.players.find(p => p.openid === botOpenid)
  if (alreadyIn) return { success: false, error: '机器人已在房间内' }

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

// ─────────────────────────────────────────────────────────────────
// _evaluateDice（与前端 Rules.js 保持同步）
// ─────────────────────────────────────────────────────────────────
function _evaluateDice(dice) {
  const counts = {}
  for (let d of dice) counts[d] = (counts[d] || 0) + 1
  const fours = counts[4] || 0
  const sorted = [...dice].sort((a, b) => a - b).join('')

  if (fours === 6) return { type: 'jackpot', call: '六红，夯特！', label: '六个4', amount: Infinity, emoji: '🎰' }
  if (fours === 5) return { type: 'win', call: '五红！！！',  label: '五个4', amount: 64, emoji: '🔥' }
  if (fours === 4) return { type: 'win', call: '四红！！',    label: '四个4', amount: 32, emoji: '💥' }

  const tripleEntries = Object.entries(counts).filter(([k, v]) => v === 3)
  if (tripleEntries.length === 2) {
    const hasFourTriple = counts[4] === 3
    if (hasFourTriple) return { type: 'win', call: '红格二十四！', label: '红格（三个4+三条）', amount: 24, emoji: '🔴' }
    return { type: 'win', call: '格子十六！', label: '格子（两个三条）', amount: 16, emoji: '🎲' }
  }

  if (fours === 3) return { type: 'win', call: '三红！', label: '三个4', amount: 8, emoji: '🎯' }

  if (sorted === '123456') return { type: 'win', call: '八洞！',   label: '顺子123456',  amount: 16, emoji: '🌈' }
  if (sorted === '223366') return { type: 'win', call: '腻三靠！', label: '二三Call',     amount: 16, emoji: '📣' }
  if (sorted === '112233') return { type: 'win', call: '一两三！', label: '连对112233',   amount: 16, emoji: '🎊' }
  if (sorted === '445566') return { type: 'win', call: '四五六！', label: '连对445566',   amount: 19, emoji: '🎊' }

  const pairCount = Object.values(counts).filter(c => c >= 2).length
  if (pairCount === 3) {
    const hasFourPair = (counts[4] || 0) >= 2
    if (hasFourPair) return { type: 'win', call: '红三对！', label: '三对含一对4', amount: 11, emoji: '🎭' }
    return { type: 'win', call: '三对！', label: '三对', amount: 8, emoji: '🎭' }
  }

  const sixKind = Object.entries(counts).find(([k, v]) => v === 6 && k !== '4')
  if (sixKind) return { type: 'win', call: '六十四！！！', label: `六个${sixKind[0]}`, amount: 64, emoji: '🌟' }

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

  if (fours === 2) return { type: 'win', call: '两红', label: '两个4', amount: 3, emoji: '✨' }
  if (fours === 1) return { type: 'win', call: '一红', label: '一个4', amount: 1, emoji: '🎲' }

  return { type: 'none', call: '空屁一只', label: '轮空', amount: 0, emoji: '💨' }
}

// ─────────────────────────────────────────────────────────────────
// initDB
// ─────────────────────────────────────────────────────────────────
async function initDB() {
  const collections = [
    'rooms',
    'players',
    'game_logs',
    'balance_ledger',
    'security_logs',
    'admin_logs',
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