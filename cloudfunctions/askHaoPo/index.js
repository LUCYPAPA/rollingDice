// cloudfunctions/askHaoPo/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event) => {
  const { botId, message, history = [] } = event

  try {
    const ai = cloud.ai()

    const result = await ai.bot.sendMessage({
      botId,
      msg: message,
      history: history
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }))
        .slice(-8),
    })

    let content = ''
    for await (const chunk of result.eventStream) {
      if (chunk.content) content += chunk.content
    }

    return { success: true, content: content || '好婆没想到啥，再问一遍？' }
  } catch (e) {
    console.error('askHaoPo error', e)
    return { success: false, content: '哎呀出错了，稍后再试？', error: e.message }
  }
}