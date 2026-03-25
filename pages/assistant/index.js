const ENV_ID = 'cloud1-0gqcenjqfe77a332'

const SYSTEM_PROMPT = `你是「好婆叫侬掷骰子了」小程序的游戏助手，角色是一位苏州老太太「好婆」，说话亲切、简短，带点苏州家常语气，偶尔用「侬」「伐」「蛮」等词。

你有两个职责：
1. 解释游戏规则——玩家问什么牌型、怎么赢、什么是红4，你都能解释清楚。
2. 收集玩家反馈——玩家说好玩、说有bug、说建议，你都耐心记下来，回复温暖。

完整规则：
红4主线：1个4→一红→1点；2个4→两红→3点；3个4→三红→8点；4个4→四红→32点；5个4→五红→64点；6个4→六红夯特→拿走底池全部
特殊牌型：格子(两个三条)→16点；红格(三个4+另一三条)→24点；三对→8点；红三对→11点；一两三(112233)→16点；四五六(445566)→19点；腻三靠(223366)→16点；八洞(顺子123456)→16点
四条(非4)：基础→16点；+1个4→17点；+2个4→19点；升级(剩余两骰之和=四条点数)→32点；升级含4→33点
五条/六条(非4)：五条→32点；五条+1个4→33点；六条→64点

游戏流程：每人投入底池(默认32点)，轮流摇6颗骰子，摇出好牌从底池拿钱，轮空换下一人，底池赢光开始新一轮。

只回答和这个游戏相关的问题，回答控制在100字以内。`

Page({
  data: {
    messages: [],
    inputVal: '',
    loading: false,
  },

  // 维护对话历史，传给模型
  _history: [],

  onLoad() {
    wx.cloud.init({ env: ENV_ID, traceUser: true })
    this.setData({
      messages: [{
        role: 'assistant',
        content: '侬好！我是好婆 🎲\n有啥规则不懂尽管问，也欢迎告诉我游戏好不好玩～'
      }]
    })
  },

  onInput(e) {
    this.setData({ inputVal: e.detail.value })
  },

  async onSend() {
    const text = this.data.inputVal.trim()
    if (!text || this.data.loading) return

    const messages = [...this.data.messages, { role: 'user', content: text }]
    this.setData({ messages, inputVal: '', loading: true })
    this._scrollToBottom()

    // 加入历史
    this._history.push({ role: 'user', content: text })

    try {
      const model = wx.cloud.extend.AI.createModel('hunyuan-exp')
      const res = await model.streamText({
        data: {
          model: 'hunyuan-turbos-latest',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...this._history.slice(-10),  // 最近10条历史
          ],
        }
      })

      let reply = ''
      for await (const str of res.textStream) {
        reply += str
      }

      // 加入历史
      this._history.push({ role: 'assistant', content: reply })

      this.setData({
        messages: [...this.data.messages, {
          role: 'assistant',
          content: reply || '好婆没想到啥，再问一遍？'
        }],
        loading: false,
      })
    } catch (e) {
      console.error('AI error', e)
      this.setData({
        messages: [...this.data.messages, {
          role: 'assistant',
          content: '哎，网络不好，稍后再试试？'
        }],
        loading: false,
      })
    }
    this._scrollToBottom()
  },

  _scrollToBottom() {
    setTimeout(() => {
      wx.createSelectorQuery()
        .select('#msg-bottom')
        .boundingClientRect(rect => {
          if (rect) wx.pageScrollTo({ scrollTop: rect.bottom, duration: 200 })
        })
        .exec()
    }, 100)
  },
})