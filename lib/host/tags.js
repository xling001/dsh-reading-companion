/**
 * 自动打 tag（P3）。
 *
 * 读者不该为了给一条笔记分类而停下来思考。所以 tag 是**自动建议的**，读者
 * 只在看不顺眼时改一改，也可以完全自己写。
 *
 * ## 为什么这一版不是模型调用
 *
 * 「AI 自动打 tag」最初的设想是让模型来分。实际考察宿主接口后放弃了，
 * 理由是代价与收益不成比例：
 *
 *   - 宿主的模型面是 `llm.stream`（一个 remote/RPC 服务），在插件侧直接调用
 *     需要自己解决路由解析（`agentDefaultModel`）、超时、取消、重试，以及
 *     `subagents.start` 那条路上的**父代理锚定**（宿主 agent 注册表是懒注册的，
 *     重启后逐个出现，锚不到就得等一轮再试）。
 *   - 换来的只是**一个属性**（tag）。而它一旦失败，用户点「写入笔记」就写不成
 *     ——为了自动分类而让核心动作多一个失败模式，是明显的亏本买卖。
 *   - 打 tag 这件事的信号其实极强：读者的感想里本来就写着他关心什么
 *     （"这段人设崩了"、"文笔真好"、"这个设定有意思"）。关键词命中在这个
 *     语料上已经够用，而且是**零延迟、零成本、离线可用、永不失败**的。
 *
 * 所以本模块输出的是**建议**：面板把它填进 tag 框，用户可增删——**最终打哪些 tag
 * 由读者决定**，可以点建议的 chip，也可以完全自己敲。
 *
 * 「让模型来打 tag」这条方案已**最终否决**（v1.18 §186，理由同上）：打 tag 不是
 * 重要功能，预设词表 + 读者自由输入就是最终形态。{@link suggestTags} 只产出候选，
 * 不参与判定；它仍是唯一的分类入口，所以将来无论怎么改，笔记层与界面层都不用动。
 */

/**
 * 内置 tag 词表。
 *
 * `keywords` 是这个 tag 的**信号词**——它们出现在摘抄/感想/回应里的密度决定
 * 该 tag 的得分。刻意收录口语化的说法（"破防"、"绷不住"），因为那才是读者
 * 真正会写下来的词。
 *
 * 词表可扩展：用户在界面上手写的 tag 会原样保留，不受此表限制。
 *
 * @type {ReadonlyArray<{tag: string, keywords: readonly string[]}>}
 */
export const TAG_VOCABULARY = Object.freeze([
  {
    tag: '人设',
    keywords: ['人设', '角色', '性格', '人物', '身份', '立场', '关系', '成长', '弧光', '塑造', '立体', '崩', 'ooc', '讨喜', '好感'],
  },
  {
    tag: '文笔',
    keywords: ['文笔', '文风', '句子', '比喻', '意象', '描写', '修辞', '语言', '笔力', '用词', '段落', '行文', '优美', '细腻'],
  },
  {
    tag: '世界观',
    keywords: ['设定', '世界观', '规则', '体系', '势力', '地理', '历史', '种族', '魔法', '科技', '架空', '副本', '背景', '架构'],
  },
  {
    tag: '情节',
    keywords: ['情节', '伏笔', '反转', '铺垫', '转折', '高潮', '悬念', '支线', '主线', '走向', '节奏', '推进'],
  },
  {
    tag: '情感',
    keywords: ['感动', '心疼', '难过', '开心', '愤怒', '压抑', '治愈', '破防', '泪目', '胃疼', '甜', '虐', '刀', '心碎', '心动'],
  },
  {
    tag: '名场面',
    keywords: ['名场面', '经典', '震撼', '鸡皮疙瘩', '燃', '高光', '封神', '起立', '鼓掌'],
  },
  {
    tag: '主题',
    keywords: ['主题', '母题', '隐喻', '象征', '意义', '内核', '立意', '讽刺', '想表达', '在讲'],
  },
  {
    tag: '结构',
    keywords: ['结构', '叙事', '视角', '时间线', '插叙', '倒叙', '多线', '铺垫', '编排'],
  },
  {
    tag: '疑问',
    keywords: ['为什么', '难道', '是不是', '不懂', '疑惑', '没看懂', '求解释', '什么意思', '？'],
  },
  {
    tag: '吐槽',
    keywords: ['哈哈', '笑死', '离谱', '无语', '吐槽', '抽象', '绷不住', '生草', '什么鬼'],
  },
  {
    tag: '考据',
    keywords: ['考据', '典故', '引用', '原型', '出处', '致敬', '原型是'],
  },
])

/**
 * 归一化一个 tag。
 *
 * 接受 `#人设`、`人设`、` 人设 ` 等写法，输出不含 `#`、不含空白的短标签。
 * 失败回空串，由调用方过滤——**不抛错**，因为 tag 来自用户输入，一个打错的
 * 标签不该让整次笔记写入失败。
 *
 * @param {unknown} raw 原始 tag
 * @returns {string} 归一化后的 tag，或空串
 */
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return ''
  // 去掉所有 `#`（用户可能写成 `##人设`）与首尾空白。
  const cleaned = raw.replace(/#/g, '').trim()
  if (cleaned === '') return ''
  // 内部空白会把 tag 变成两个词，破坏 `tags=a,b` 这种机器可读标记。
  if (/\s/.test(cleaned)) return ''
  // 逗号是 md 标记里的分隔符，不能出现在 tag 内部。
  if (cleaned.includes(',') || cleaned.includes('，')) return ''
  return cleaned.slice(0, 24)
}

/**
 * 归一化一组 tag：去空、去重、保序。
 *
 * @param {unknown} list 原始列表
 * @returns {string[]}
 */
export function normalizeTags(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const raw of list) {
    const tag = normalizeTag(raw)
    if (tag !== '' && !out.includes(tag)) out.push(tag)
  }
  return out
}

/**
 * 三路文本的权重。
 *
 * **感想权重最高**：这条笔记是"读者在意什么"的记录，而不是"这一段写了什么"。
 * 摘抄权重最低，因为它是书的原文，背景信息量最大但指向性最弱。
 */
const FIELD_WEIGHTS = Object.freeze({ thought: 3, reply: 2, excerpt: 1 })

/**
 * 给一条笔记建议 tag。
 *
 * @param {object} input
 * @param {string} [input.excerpt] 原文摘抄
 * @param {string} [input.thought] 我的感想
 * @param {string|null} [input.reply] AI 回应
 * @param {number} [input.limit] 最多返回几个
 * @param {ReadonlyArray<{tag: string, keywords: readonly string[]}>} [input.vocabulary] 覆盖词表
 * @returns {string[]} 建议的 tag（可能为空）
 */
export function suggestTags(input = {}) {
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 4
  const vocabulary = Array.isArray(input.vocabulary) ? input.vocabulary : TAG_VOCABULARY

  const corpus = [
    [String(input.thought ?? ''), FIELD_WEIGHTS.thought],
    [String(input.reply ?? ''), FIELD_WEIGHTS.reply],
    [String(input.excerpt ?? ''), FIELD_WEIGHTS.excerpt],
  ].filter(([text]) => text !== '')

  if (corpus.length === 0) return []

  const scored = []
  for (const [order, entry] of vocabulary.entries()) {
    let score = 0
    for (const [text, weight] of corpus) {
      for (const keyword of entry.keywords) {
        if (keyword === '') continue
        // 统计出现次数而不是"是否出现"：反复提到的主题才是主题。
        let at = text.indexOf(keyword)
        while (at !== -1) {
          score += weight
          at = text.indexOf(keyword, at + keyword.length)
        }
      }
    }
    if (score > 0) scored.push({ tag: entry.tag, score, order })
  }

  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order))
  return scored.slice(0, limit).map((entry) => entry.tag)
}

/**
 * 合并 tag 列表：建议的在前，用户手写的在后，整体去重。
 *
 * @param {...unknown} lists 若干列表
 * @returns {string[]}
 */
export function mergeTags(...lists) {
  const out = []
  for (const list of lists) {
    for (const tag of normalizeTags(list)) {
      if (!out.includes(tag)) out.push(tag)
    }
  }
  return out
}
