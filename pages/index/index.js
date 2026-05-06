// pages/index/index.js  v3.6 — 签文云端配置化
// 改动：
//   1. 签文从云数据库 signs 集合拉取，本地 data/signs.js 作兜底
//   2. 运营参数（maxDailyDraws / cooldownDays / 账号 ID）从 sign_config 集合读取
//   3. 启动时优先用本地缓存（< 24h），后台静默刷新

const { SIGNS: LOCAL_SIGNS } = require('../../data/signs')

// ── 签文运行时（启动后由 _loadSignsFromCloud 覆盖）─────────────
let _signs = LOCAL_SIGNS   // 当前可用签文（云端 or 本地兜底）

// ── 运营参数默认值（云端拉取后覆盖）──────────────────────────────
let _cfg = {
  maxDailyDraws:  3,
  cooldownDays:   7,
  publicAccount:  'rangecross',
  videoAccount:   'sphCiXQ9MjIUOgR',
}

const SIGNS_CACHE_KEY    = 'sign_remote_cache_v1'
const SIGNS_CACHE_TS_KEY = 'sign_remote_cache_ts_v1'
const CACHE_TTL_MS       = 24 * 60 * 60 * 1000  // 24小时

/** 加载本地缓存的签文（同步，给启动用）*/
function loadCachedSigns() {
  try {
    const ts = wx.getStorageSync(SIGNS_CACHE_TS_KEY)
    if (!ts || Date.now() - ts > CACHE_TTL_MS) return false
    const cached = wx.getStorageSync(SIGNS_CACHE_KEY)
    if (cached && cached.signs && cached.signs.length > 0) {
      _signs = cached.signs
      if (cached.config) Object.assign(_cfg, cached.config)
      return true
    }
  } catch (e) {}
  return false
}

/** 后台从云端拉取最新签文和配置，静默更新 */
async function refreshFromCloud() {
  try {
    const [signsRes, cfgRes] = await Promise.all([
      wx.cloud.callFunction({ name: 'signManager', data: { action: 'getSigns' } }),
      wx.cloud.callFunction({ name: 'signManager', data: { action: 'getSignConfig' } }),
    ])
    const signs  = signsRes.result && signsRes.result.signs
    const config = cfgRes.result  && cfgRes.result.config

    if (signs && signs.length > 0) {
      _signs = signs
      if (config) Object.assign(_cfg, config)
      wx.setStorageSync(SIGNS_CACHE_KEY, { signs, config })
      wx.setStorageSync(SIGNS_CACHE_TS_KEY, Date.now())
    }
  } catch (e) {
    console.warn('[Signs] 云端刷新失败，继续用本地/缓存签文', e)
  }
}

const LEVEL_BTN_COLOR = {
  '上上签': '#1D9E75',
  '上签':   '#534AB7',
  '中签':   '#BA7517',
  '小凶签': '#D85A30',
}

const LEVEL_TITLE_COLOR = {
  '上上签': '#085041',
  '上签':   '#3C3489',
  '中签':   '#633806',
  '小凶签': '#712B13',
}

// ── 像素网格生成（36列×8行）────────────────────────────────────
function makePixelGrid(level) {
  const themes = {
    '上上签': { bg:'#E8F8F1', sky:'#B8EAD8', gnd:'#7FD4A8', sun:'#F5D76E', glow:'#FFFACD', dark:'#0A5E42', mid:'#1D9E75' },
    '上签':   { bg:'#EEEDFE', sky:'#3C3489', gnd:'#9B96E8', sun:'#F5D76E', glow:'#FFFFFF', dark:'#26215C', mid:'#534AB7' },
    '中签':   { bg:'#FDF6E8', sky:'#FDF6E8', gnd:'#D4A850', sun:'#FFFFFF', glow:'#F5DFA0', dark:'#7A4D0E', mid:'#BA7517' },
    '小凶签': { bg:'#FDF0EC', sky:'#FDF0EC', gnd:'#D88070', sun:'#FFFFFF', glow:'#F5C4B3', dark:'#712B13', mid:'#D85A30' },
  }
  const c = themes[level] || themes['上签']
  const { sky:K, gnd:G, sun:S, glow:W, dark:D, mid:M, bg:BG } = c
  const _ = BG
  let grid

  if (level === '上上签') {
    grid = [
      _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
      K,K,K,K,K,K,K,K,K,K,K,K,K,K,K,W,W,W,W,W,K,K,K,K,K,K,K,K,K,K,K,K,K,K,K,K,
      K,K,K,K,K,K,K,K,K,K,K,K,K,K,W,S,S,S,S,S,W,K,K,K,K,K,K,K,K,K,K,K,K,K,K,K,
      K,K,K,K,K,K,K,K,K,K,K,K,K,W,S,S,S,S,S,S,S,W,K,K,K,K,K,K,K,K,K,K,K,K,K,K,
      D,_,D,_,_,_,D,D,_,_,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,
      G,G,G,D,G,D,G,G,G,D,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,
      G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,
      M,G,G,G,M,G,G,G,M,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,M,G,G,M,G,
    ]
  } else if (level === '上签') {
    const mo = '#FFF8DC'
    grid = [
      K,K,K,K,S,K,K,K,K,K,K,S,K,K,K,K,K,K,K,K,K,S,K,K,K,K,K,K,K,K,S,K,K,K,K,K,
      K,K,S,K,K,K,K,K,K,K,K,K,K,S,K,K,K,K,K,K,K,K,K,K,S,K,K,K,K,K,K,K,K,K,K,K,
      K,K,K,K,K,K,S,K,K,K,K,K,K,K,K,mo,mo,K,K,K,K,K,K,S,K,K,K,K,K,K,K,K,S,K,K,K,
      K,S,K,K,K,K,K,K,K,K,K,K,K,K,mo,mo,mo,mo,K,K,K,K,K,K,K,K,S,K,K,K,K,K,K,K,K,K,
      K,K,K,K,S,K,K,K,K,K,K,S,K,K,K,mo,mo,K,K,K,K,K,K,K,K,K,K,K,K,S,K,K,K,K,K,K,
      M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,
      D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,
      G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,
    ]
  } else if (level === '中签') {
    grid = [
      _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
      _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
      W,W,_,_,W,W,W,_,_,W,W,W,_,_,W,W,W,_,_,W,W,W,_,_,W,W,W,_,_,W,W,W,_,_,W,W,
      W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,
      M,M,_,_,M,M,M,_,_,M,M,M,_,_,M,M,M,_,_,M,M,M,_,_,M,M,M,_,_,M,M,M,_,_,M,M,
      M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,
      D,D,_,_,D,D,D,_,_,D,D,D,_,_,D,D,D,_,_,D,D,D,_,_,D,D,D,_,_,D,D,D,_,_,D,D,
      D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,D,
    ]
  } else {
    grid = [
      _,_,M,M,M,M,M,_,_,_,M,M,M,M,M,M,M,_,_,_,M,M,M,M,M,M,_,_,_,M,M,M,M,M,M,_,
      _,M,D,D,D,D,D,M,_,M,D,D,D,D,D,D,D,M,_,M,D,D,D,D,D,D,M,_,M,D,D,D,D,D,D,M,
      M,D,D,D,D,D,D,D,M,D,D,D,D,D,D,D,D,D,M,D,D,D,D,D,D,D,D,M,D,D,D,D,D,D,D,D,
      _,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,
      M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,
      _,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,_,M,
      G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,
      G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,G,
    ]
  }
  return { pixelGrid: grid, pixelBg: BG }
}

// ── 海报绘制 ────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r)
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r)
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r)
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r)
  ctx.closePath(); ctx.fill()
}

function wrapText(ctx, text, x, y, maxW, lineH) {
  const chars = text.split('')
  let line='', curY=y
  for(let i=0;i<chars.length;i++){
    const test = line+chars[i]
    if(ctx.measureText(test).width>maxW && line!==''){
      ctx.fillText(line,x,curY); line=chars[i]; curY+=lineH
    } else { line=test }
  }
  ctx.fillText(line,x,curY)
}

const POSTER_THEMES = {
  '上上签': { bg:'#E8F8F1', accent1:'#1D9E75', accent2:'#0A5E42' },
  '上签':   { bg:'#EEEDFE', accent1:'#534AB7',  accent2:'#3C3489' },
  '中签':   { bg:'#FDF6E8', accent1:'#BA7517',  accent2:'#7A4D0E' },
  '小凶签': { bg:'#FDF0EC', accent1:'#D85A30',  accent2:'#712B13' },
}

function drawAndExportPoster(canvas, sign, W, H, dpr) {
  const theme = POSTER_THEMES[sign.level] || POSTER_THEMES['上签']
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  // 用绝对像素定位，W=375逻辑宽，H=W*1.78≈668
  // 整体分区：顶部信息区(0~240) 签诗区(240~420) Joey区(420~560) 二维码区(560~H)

  ctx.fillStyle=theme.bg; ctx.fillRect(0,0,W,H)
  ctx.fillStyle=theme.accent1; ctx.fillRect(0,0,W,6)

  // ── 品牌 14px ──
  ctx.textAlign='center'
  ctx.fillStyle=theme.accent2
  ctx.font=`500 14px monospace`
  ctx.fillText('CROSS-RANGE',W/2,36)

  // ── 签级徽章 ──
  const badgeW=80,badgeH=24,badgeX=W/2-40,badgeY=46
  ctx.fillStyle=sign.badgeBg; roundRect(ctx,badgeX,badgeY,badgeW,badgeH,12)
  ctx.fillStyle=sign.badgeColor
  ctx.font=`500 13px sans-serif`
  ctx.fillText(sign.level,W/2,badgeY+17)

  // ── 签号 36px ──
  ctx.fillStyle=theme.accent2
  ctx.font=`500 36px sans-serif`
  ctx.fillText(sign.num,W/2,118)

  // ── 签题 24px ──
  ctx.fillStyle='#1a1a18'
  ctx.font=`600 24px sans-serif`
  ctx.fillText(sign.title,W/2,150)

  // ── 分隔线 ──
  ctx.strokeStyle='rgba(0,0,0,0.08)'; ctx.lineWidth=0.5
  ctx.beginPath(); ctx.moveTo(W*0.12,168); ctx.lineTo(W*0.88,168); ctx.stroke()

  // ── 签诗 4行，行距32px，从y=205开始 ──
  ctx.fillStyle='#6b6b66'
  ctx.font=`400 18px serif`
  sign.poem.split('\n').forEach((line,i)=>ctx.fillText(line,W/2,205+i*32))

  // ── 分隔线 ──
  ctx.beginPath(); ctx.moveTo(W*0.12,340); ctx.lineTo(W*0.88,340); ctx.stroke()

  // ── Joey解读，从y=362开始 ──
  ctx.textAlign='left'
  ctx.fillStyle=theme.accent1
  ctx.font=`500 13px sans-serif`
  ctx.fillText('mini Joey 说',W*0.1,362)
  ctx.fillStyle='#1a1a18'
  ctx.font=`400 15px sans-serif`
  wrapText(ctx,sign.joey,W*0.1,386,W*0.8,24)

  // ── 分隔线 ──
  ctx.strokeStyle='rgba(0,0,0,0.06)'
  ctx.beginPath(); ctx.moveTo(W*0.1,480); ctx.lineTo(W*0.9,480); ctx.stroke()

  // ── 二维码：宽度55%居中，从y=500开始 ──
  const qrSize = Math.floor(W*0.55)
  const qrX = W/2-qrSize/2
  const qrY = 500

  // 文字在二维码下方
  ctx.textAlign='center'
  ctx.fillStyle=theme.accent2
  ctx.font=`500 13px sans-serif`
  ctx.fillText('扫码求你的今日签',W/2,qrY+qrSize+20)
  ctx.fillStyle='#9b9b96'
  ctx.font=`400 12px sans-serif`
  ctx.fillText('每天一次 · 好运随行',W/2,qrY+qrSize+38)

  // ── 日期右下 ──
  ctx.textAlign='right'
  ctx.fillStyle='rgba(0,0,0,0.18)'
  ctx.font=`400 11px monospace`
  const d=new Date()
  ctx.fillText(
    `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`,
    W*0.92,H-12
  )

  // ── 二维码图片 ──
  function doExport(){
    wx.canvasToTempFilePath({
      canvas,x:0,y:0,width:W*dpr,height:H*dpr,destWidth:W*dpr,destHeight:H*dpr,fileType:'png',
      success(r){
        wx.hideLoading()
        wx.showShareImageMenu({
          path:r.tempFilePath,
          fail(){
            wx.saveImageToPhotosAlbum({
              filePath:r.tempFilePath,
              success(){ wx.showToast({title:'图片已保存到相册',icon:'success'}) },
              fail(){ wx.showToast({title:'请长按图片保存',icon:'none'}) },
            })
          },
        })
      },
      fail(){ wx.hideLoading(); wx.showToast({title:'生成失败，请重试',icon:'none'}) },
    })
  }

  const qr=canvas.createImage()
  qr.onload=()=>{
    ctx.fillStyle='#FFFFFF'
    roundRect(ctx, qrX-8, qrY-8, qrSize+16, qrSize+16, 12)
    ctx.drawImage(qr,qrX,qrY,qrSize,qrSize)
    doExport()
  }
  qr.onerror=()=>{
    ctx.fillStyle='rgba(0,0,0,0.06)'
    roundRect(ctx,qrX,qrY,qrSize,qrSize,8)
    ctx.fillStyle='#9b9b96'
    ctx.textAlign='center'
    ctx.font=`400 ${Math.floor(W*0.032)}px sans-serif`
    ctx.fillText('扫码关注',W/2,qrY+qrSize/2)
    doExport()
  }
  qr.src='/images/qrcode.jpg'
}

// ── 工具函数 ────────────────────────────────────────────────────
const STORAGE_COOLDOWN_KEY = 'sign_cooldown_v2'

function getCooldownMap() {
  try { return wx.getStorageSync(STORAGE_COOLDOWN_KEY) || {} } catch(e) { return {} }
}
function setCooldownMap(map) {
  try { wx.setStorageSync(STORAGE_COOLDOWN_KEY, map) } catch(e) {}
}
function pickSignWithCooldown() {
  const map = getCooldownMap()
  const today = Math.floor(Date.now() / 86400000)
  const cooldownDays = _cfg.cooldownDays
  let pool = _signs.map((s,i)=>({s,i})).filter(({i})=>{
    const last=map[i]; return !last||(today-last)>=cooldownDays
  })
  if (!pool.length) pool = _signs.map((s,i)=>({s,i}))
  const picked = pool[Math.floor(Math.random()*pool.length)]
  map[picked.i] = today; setCooldownMap(map)
  return picked.i
}

function getTodayKey() {
  const d=new Date()
  return `sign_${d.getFullYear()}_${d.getMonth()+1}_${d.getDate()}`
}

function buildStreakDots(days) {
  const arr=[]
  const filled = Math.min(days, 7)
  for(let i=0;i<7;i++) arr.push(i<filled)
  return arr
}

function getTodayDrawCount() {
  try { return wx.getStorageSync('draw_count_' + getTodayKey()) || 0 } catch(e) { return 0 }
}
function saveTodayDrawCount(count) {
  try { wx.setStorageSync('draw_count_' + getTodayKey(), count) } catch(e) {}
}

// ── Page ───────────────────────────────────────────────────────
Page({
  data: {
    todaySigned: false,
    signLevel:'', signNum:'', signTitle:'', signPoem:'',
    joeyText:'', isGoodSign:true,
    signBadgeBg:'#E1F5EE', signBadgeColor:'#085041', signBorderColor:'#9FE1CB',
    signBtnColor:'#1D9E75',
    signTitleColor:'#1a1a18',
    badSignRedrawn: false,
    pixelGrid: [],
    pixelBg: '#FDFCF8',
    gameIcon32:'',
    streakDays:0,
    streakDots:[false,false,false,false,false,false,false],
    showFortune:false,
    fortuneYiJi:'', fortuneTrend:'', fortuneQuestion:'',
    showFollowSheet: false,
    showLimitSheet: false,
    isFollowing: false,
    todayDrawCount: 0,
    vesselShaking: false,
    stickFlying: false,
    cardAppearing: false,
    posterW: 375,
    posterH: 788,
  },

  _currentSign: null,

  onLoad() {
    // 1. 优先读本地缓存（同步，不阻塞渲染）
    loadCachedSigns()
    // 2. 后台静默刷新（不等结果，失败不影响使用）
    refreshFromCloud()

    this._loadTodaySign()
    this._loadStreak()
    this._startShakeListener()
    try {
      const followed = wx.getStorageSync('oa_followed') || false
      const count = getTodayDrawCount()
      this.setData({ isFollowing: followed, todayDrawCount: count })
    } catch(e) {}
  },

  onShow() { this._loadTodaySign() },
  onUnload() { wx.stopAccelerometer() },

  _loadTodaySign() {
    try {
      const saved = wx.getStorageSync(getTodayKey())
      if (saved && saved.signIdx !== undefined) {
        const sign = _signs[saved.signIdx]
        if (!sign) return   // 云端签文条数可能和本地不同，防越界
        this._currentSign = sign
        this._applySign(sign, saved.badSignRedrawn || false)
      }
    } catch(e) {}
  },

  _loadStreak() {
    try {
      const days = wx.getStorageSync('sign_streak') || 0
      this.setData({ streakDays:days, streakDots:buildStreakDots(days) })
    } catch(e) {}
  },

  _applySign(sign, badSignRedrawn=false) {
    const btnColor = LEVEL_BTN_COLOR[sign.level] || '#534AB7'
    const titleColor = LEVEL_TITLE_COLOR[sign.level] || '#1a1a18'
    const { pixelGrid, pixelBg } = makePixelGrid(sign.level)
    this.setData({
      todaySigned:true,
      signLevel:sign.level, signNum:sign.num, signTitle:sign.title,
      signPoem:sign.poem, joeyText:sign.joey,
      isGoodSign:sign.isGood,
      signBadgeBg:sign.badgeBg, signBadgeColor:sign.badgeColor,
      signBorderColor:sign.borderColor,
      signBtnColor:btnColor,
      signTitleColor:titleColor,
      badSignRedrawn,
      pixelGrid, pixelBg,
      fortuneYiJi:sign.yiji, fortuneTrend:sign.trend, fortuneQuestion:sign.question,
      cardAppearing: true,
    })
    setTimeout(() => this.setData({ cardAppearing: false }), 500)
  },

  // ── 摇签动画统一入口 ────────────────────────────────────────
  _playShakeAndDraw() {
    wx.vibrateShort({ type: 'medium' })
    this.setData({ vesselShaking: true, stickFlying: false })
    setTimeout(() => this.setData({ stickFlying: true }), 200)
    setTimeout(() => {
      this.setData({ vesselShaking: false, stickFlying: false })
      this._doDraw()
    }, 750)
  },

  // ── 首次抽签入口（点击签筒 / 摇一摇）──────────────────────
  onShake() {
    const key = getTodayKey()
    try {
      const saved = wx.getStorageSync(key)
      if (saved && saved.signIdx !== undefined) {
        const sign = _signs[saved.signIdx]
        if (sign) this._applySign(sign, saved.badSignRedrawn || false)
        return
      }
    } catch(e) {}
    if (this.data.vesselShaking) return
    this._playShakeAndDraw()
  },

  _startShakeListener() {
    let lastShake = 0
    wx.onAccelerometerChange((res) => {
      const { x, y, z } = res
      const force = Math.sqrt(x*x + y*y + z*z)
      if (force > 2.0) {
        const now = Date.now()
        if (now - lastShake < 1500) return
        lastShake = now
        this.onShake()
      }
    })
    wx.startAccelerometer({ interval: 'normal' })
  },

  _doDraw() {
    const idx = pickSignWithCooldown()
    const sign = _signs[idx]
    this._currentSign = sign
    this._applySign(sign, false)
    const key = getTodayKey()
    try { wx.setStorageSync(key, { signIdx:idx, badSignRedrawn:false }) } catch(e) {}
    // 连续天数
    try {
      const lastKey = wx.getStorageSync('sign_last_date')
      let streak = wx.getStorageSync('sign_streak') || 0
      if (lastKey !== key) {
        const yesterday = new Date()
        yesterday.setDate(yesterday.getDate() - 1)
        const yKey = `sign_${yesterday.getFullYear()}_${yesterday.getMonth()+1}_${yesterday.getDate()}`
        streak = (lastKey === yKey) ? streak + 1 : 1
        wx.setStorageSync('sign_streak', streak)
        wx.setStorageSync('sign_last_date', key)
        this.setData({ streakDays:streak, streakDots:buildStreakDots(streak) })
      }
    } catch(e) {}
    // 今日抽签次数
    const count = getTodayDrawCount() + 1
    saveTodayDrawCount(count)
    this.setData({ todayDrawCount: count })
  },

  // ── 标题旁"再抽一个"──────────────────────────────────────
  // 所有人都能看到，未关注引导关注，已关注直接抽（每天限3次）
  onBrandRedraw() {
    if (this.data.vesselShaking) return
    if (!this.data.isFollowing) {
      // 未关注：弹关注引导
      this.setData({ showFollowSheet: true })
      return
    }
    if (this.data.todayDrawCount >= _cfg.maxDailyDraws) {
      // 已关注但超次数：弹达上限引导
      this.setData({ showLimitSheet: true })
      return
    }
    // 已关注且未超限：回签筒摇
    this.setData({ todaySigned: false })
    setTimeout(() => this._playShakeAndDraw(), 100)
  },

  // ── 凶签"换一支"——回到签筒让用户重新摇 ────────────────────
  onRedrawBadSign() {
    const key = getTodayKey()
    try { wx.removeStorageSync(key) } catch(e) {}
    wx.vibrateShort({ type: 'light' })
    this.setData({ todaySigned: false })
    wx.showToast({ title: '再摇一摇试试运气', icon: 'none', duration: 1500 })
  },

  // ── 公众号跳转 ─────────────────────────────────────────────
  onOpenOfficialAccount() {
    const self = this
    wx.openOfficialAccountProfile({
      username: _cfg.publicAccount,
      success() {},
      fail(err) {
        console.warn('跳转公众号失败:', err.errMsg)
        self.setData({ showFollowSheet: true })
      }
    })
  },

  // ── 海报生成 ────────────────────────────────────────────────
  onSharePoster() {
    if (!this._currentSign) return
    wx.showLoading({ title:'生成中...' })
    const sign = this._currentSign
    const info = wx.getWindowInfo()
    const dpr = info.pixelRatio || 2
    const W = info.windowWidth        // 逻辑宽度，如375
    const H = Math.round(W * 2.1)    // 足够高，二维码+文字不截断
    // 先设置 canvas 的 DOM 尺寸，再获取节点
    this.setData({ posterW: W, posterH: H }, () => {
      wx.createSelectorQuery().in(this)
        .select('#posterCanvas').fields({ node:true, size:true })
        .exec(res => {
          if (!res[0] || !res[0].node) {
            wx.hideLoading()
            wx.showToast({ title:'生成失败，请重试', icon:'none' })
            return
          }
          const canvas = res[0].node
          canvas.width=W*dpr; canvas.height=H*dpr
          drawAndExportPoster(canvas, sign, W, H, dpr)
        })
    })
  },

  // ── 运势解读浮层 ────────────────────────────────────────────
  onShowFortune() { this.setData({ showFortune:true }) },
  onCloseFortune() { this.setData({ showFortune:false }) },

  // ── 关注公众号浮层 ──────────────────────────────────────────
  onOALoad(e) { console.log('公众号卡片加载成功', e) },
  onOAError(e) {
    console.warn('公众号卡片加载失败', e)
    wx.showToast({ title:'请搜索关注CROSS-RANGE', icon:'none', duration:2500 })
  },
  onOAFollow(e) {
    console.log('用户关注了公众号', e)
    try { wx.setStorageSync('oa_followed', true) } catch(e2) {}
    this.setData({ isFollowing: true })
    wx.showToast({ title:'关注成功！', icon:'success' })
  },
  onConfirmFollowed() {
    try { wx.setStorageSync('oa_followed', true) } catch(e) {}
    this.setData({ isFollowing: true, showFollowSheet: false, todaySigned: false })
    wx.showToast({ title:'已关注，点"再抽一个"继续', icon:'none', duration: 2000 })
  },
  onCloseFollowSheet() { this.setData({ showFollowSheet: false }) },

  // ── 达上限引导浮层 ──────────────────────────────────────────
  onCloseLimitSheet() { this.setData({ showLimitSheet: false }) },
  onLimitGoPublic() {
    this.setData({ showLimitSheet: false })
    wx.openOfficialAccountProfile({
      username: _cfg.publicAccount,
      success() {},
      fail() { wx.showToast({ title:'搜索公众号 CROSS-RANGE', icon:'none', duration:2500 }) }
    })
  },
  onLimitGoVideo() {
    this.setData({ showLimitSheet: false })
    wx.openChannelsUserProfile({
      finderUserName: _cfg.videoAccount,
      success() {},
      fail() { wx.showToast({ title:'搜索视频号 CROSS-RANGE', icon:'none', duration:2500 }) }
    })
  },
  onLimitGoGame() {
    this.setData({ showLimitSheet: false })
    wx.navigateTo({ url: '/pages/game/game' })
  },

  // ── 其他 ────────────────────────────────────────────────────
  goToGame() { wx.navigateTo({ url:'/pages/game/game' }) },
  onShareAppMessage() {
    return { title:'每天一签，好运随行 · 祝君好运', path:'/pages/index/index' }
  },
})
