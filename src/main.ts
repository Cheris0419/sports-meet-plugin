import { bitable } from '@lark-base-open/js-sdk'
import './style.css'

/* ============ 配置：表名与字段名（与多维表格保持一致） ============ */
const T_SIGNUP = '比赛报名表'
const T_MATCH = '比赛记录表'
const T_SCORE = '积分统计表'

const RANKS = ['第一名', '第二名', '第三名'] as const
const MEDALS = ['🥇', '🥈', '🥉'] as const

/* ============ SDK 基础封装 ============ */
type Cell = any
interface Rec {
  recordId: string
  fields: Record<string, Cell>
}

const tableCache: Record<string, any> = {}
const fieldMapCache: Record<string, Record<string, string>> = {}

async function loadTable(name: string) {
  if (!tableCache[name]) tableCache[name] = await bitable.base.getTableByName(name)
  return tableCache[name]
}

/** 字段名 → 字段ID 映射 */
async function fieldMap(tableName: string): Promise<Record<string, string>> {
  if (!fieldMapCache[tableName]) {
    const t = await loadTable(tableName)
    const metas = await t.getFieldMetaList()
    const m: Record<string, string> = {}
    for (const meta of metas) m[meta.name] = meta.id
    fieldMapCache[tableName] = m
  }
  return fieldMapCache[tableName]
}

/** 拉全表记录，字段键从 fieldId 翻译为字段名 */
async function fetchAll(tableName: string): Promise<Rec[]> {
  const t = await loadTable(tableName)
  const fm = await fieldMap(tableName)
  const id2name: Record<string, string> = {}
  for (const [n, id] of Object.entries(fm)) id2name[id] = n
  const out: Rec[] = []
  let pageToken: string | undefined
  do {
    const res = await t.getRecordsByPage({ pageSize: 200, pageToken })
    for (const r of res.records as any[]) {
      const f: Record<string, Cell> = {}
      for (const [fid, val] of Object.entries(r.fields || {})) {
        f[id2name[fid] ?? fid] = val
      }
      out.push({ recordId: r.recordId, fields: f })
    }
    pageToken = (res as any).pageToken
  } while (pageToken)
  return out
}

/* ---------- 单元格读取辅助 ---------- */
function sel(v: Cell): string {
  // 单选: {text}|string；多选: 数组
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? x.text : x)).join('/')
  if (typeof v === 'object') return v.text ?? ''
  return String(v)
}
function persons(v: Cell): { id: string; name: string }[] {
  if (!Array.isArray(v)) return []
  return v.filter((x) => x && x.id).map((x) => ({ id: x.id, name: x.name || x.id }))
}
function linkIds(v: Cell): string[] {
  if (!v) return []
  if (Array.isArray(v)) {
    // 兼容 [{recordId}] / [{record_ids}] / [IOpenLink]
    const ids: string[] = []
    for (const x of v) {
      if (typeof x === 'string') ids.push(x)
      else if (x.recordIds) ids.push(...x.recordIds)
      else if (x.record_ids) ids.push(...x.record_ids)
      else if (x.recordId) ids.push(x.recordId)
      else if (x.id) ids.push(x.id)
    }
    return ids
  }
  if (v.recordIds) return v.recordIds
  return []
}

/* ---------- 写入值构造 ---------- */
async function userVal(tableName: string, fieldName: string, ids: string[]) {
  const fm = await fieldMap(tableName)
  return { [fm[fieldName]]: ids.map((id) => ({ id })) }
}
function linkVal(ids: string[]) {
  return { text: '', type: 'text', recordIds: ids, tableId: tableCache[T_SIGNUP]?.id || '' }
}

/* ============ 业务数据模型 ============ */
interface SignupRow {
  recordId: string
  序号: string
  概要: string
  类型: string // 个人赛 / 团体赛
  项目: string
  状态: string
  名次选择: string // 第一名/第二名/第三名/空
  title: string
  members: { id: string; name: string }[] // 个人赛=姓名，团体赛=成员
}

function signupTitle(r: Rec): { title: string; members: { id: string; name: string }[] } {
  const 类型 = sel(r.fields['报名类型'])
  const 项目 = sel(r.fields['项目']) || sel(r.fields['个人赛项目']) || sel(r.fields['团体赛项目'])
  const seq = sel(r.fields['报名概要']) || sel(r.fields['序号'])
  let members: { id: string; name: string }[] = []
  let title = ''
  if (类型 === '个人赛') {
    members = persons(r.fields['姓名'])
    title = `${项目}·${members.map((m) => m.name).join('、')}`
  } else {
    members = persons(r.fields['成员'])
    const 队名 = (r.fields['队伍名称'] || '').toString().trim()
    title = `${项目}·${队名 || members.map((m) => m.name).join('、')}`
  }
  return { title: seq ? `${seq}` : title, members }
}

async function loadSignups(): Promise<SignupRow[]> {
  const recs = await fetchAll(T_SIGNUP)
  return recs
    .filter((r) => sel(r.fields['项目']))
    .map((r) => {
      const { title, members } = signupTitle(r)
      return {
        recordId: r.recordId,
        序号: sel(r.fields['报名概要']) || sel(r.fields['序号']),
        概要: sel(r.fields['报名概要']),
        类型: sel(r.fields['报名类型']),
        项目: sel(r.fields['项目']),
        状态: sel(r.fields['报名状态']),
        名次选择: sel(r.fields['比赛名次']),
        title,
        members,
      }
    })
}

/* ============ 模块一：记录同步 + 体检 ============ */
async function runSync(): Promise<string> {
  const [signups, scores] = await Promise.all([loadSignups(), fetchAll(T_SCORE)])

  // 积分表现状：报名记录 -> 已有参赛者集合
  const existing = new Map<string, Set<string>>() // signupRecordId -> personIds
  for (const s of scores) {
    const personIds = persons(s.fields['参赛者']).map((p) => p.id)
    for (const rid of linkIds(s.fields['报名记录'])) {
      if (!existing.has(rid)) existing.set(rid, new Set())
      for (const p of personIds) existing.get(rid)!.add(p)
    }
  }

  const confirmed = signups.filter((s) => s.状态 === '已确认')
  const toCreate: { fields: Record<string, any> }[] = []
  let individualCnt = 0
  let teamCnt = 0

  for (const s of confirmed) {
    const have = existing.get(s.recordId) || new Set<string>()
    const missing = s.members.filter((m) => !have.has(m.id))
    for (const m of missing) {
      const fUser = await userVal(T_SCORE, '参赛者', [m.id])
      const fmScore = await fieldMap(T_SCORE)
      toCreate.push({
        fields: {
          ...fUser,
          [fmScore['报名记录']]: linkVal([s.recordId]),
        },
      })
      if (s.类型 === '个人赛') individualCnt++
      else teamCnt++
    }
  }

  if (toCreate.length > 0) {
    const t = await loadTable(T_SCORE)
    for (let i = 0; i < toCreate.length; i += 200) {
      await t.addRecords(toCreate.slice(i, i + 200))
    }
  }

  const lines: string[] = []

  /* ---- 自动清理：已确认=false 的积分行（报名被取消确认/退赛/无关联） ---- */
  const confirmedIds = new Set(confirmed.map((s) => s.recordId))
  const toDelete: string[] = []
  for (const s of scores) {
    const links = linkIds(s.fields['报名记录'])
    const invalid =
      links.length === 0 || links.every((rid) => !confirmedIds.has(rid))
    if (invalid) toDelete.push(s.recordId)
  }
  if (toDelete.length > 0) {
    const t = await loadTable(T_SCORE)
    for (let i = 0; i < toDelete.length; i += 200) {
      await t.deleteRecords(toDelete.slice(i, i + 200))
    }
  }

  /* ---- 名次展示回填：把报名行的「比赛名次」写入比赛记录表的第一/二/三名（单向展示） ---- */
  let displaySynced = 0
  try {
    const matches = await fetchAll(T_MATCH)
    const fmMatch = await fieldMap(T_MATCH)
    const updates: { recordId: string; fields: Record<string, any> }[] = []
    for (const m of matches) {
      const proj = sel(m.fields['项目'])
      if (!proj) continue
      const want: Record<string, string[]> = { 第一名: [], 第二名: [], 第三名: [] }
      for (const s of confirmed) {
        if (s.项目 === proj && s.名次选择 && (RANKS as readonly string[]).includes(s.名次选择)) {
          want[s.名次选择].push(s.recordId)
        }
      }
      const fields: Record<string, any> = {}
      let dirty = false
      RANKS.forEach((rk) => {
        const cur = [...linkIds(m.fields[rk])].sort().join(',')
        const target = [...want[rk]].sort().join(',')
        if (cur !== target) {
          fields[fmMatch[rk]] = linkVal(want[rk])
          dirty = true
        }
      })
      if (dirty) updates.push({ recordId: m.recordId, fields })
    }
    if (updates.length) {
      const t = await loadTable(T_MATCH)
      await t.setRecords(updates)
      displaySynced = updates.length
    }
  } catch (e: any) {
    lines.push(`ℹ️ 名次展示回填跳过：${e?.message || e}`)
  }

  /* ---- 体检 ---- */
  lines.push(
    `已确认报名 ${confirmed.length} 条；本次新生成积分记录 ${toCreate.length} 条（个人赛 ${individualCnt}、团体赛 ${teamCnt}）`,
  )
  if (displaySynced > 0) lines.push(`🏆 名次展示已回填 ${displaySynced} 个比赛行`)

  // 重复确认：同一人+同一项目出现在多条已确认报名里
  const seen = new Map<string, string[]>()
  for (const s of confirmed) {
    for (const m of s.members) {
      const key = `${m.id}|${s.项目}`
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key)!.push(`${m.name}·${s.项目}(#${s.序号})`)
    }
  }
  const dups = [...seen.values()].filter((v) => v.length > 1)
  if (dups.length) {
    lines.push(`⚠️ 重复确认 ${dups.length} 组（同人同项目多条已确认，请取消旧的）：`)
    for (const d of dups) lines.push(`　· ${d.join(' ↔ ')}`)
  } else {
    lines.push('✅ 无重复确认')
  }

  // 已确认但还没有积分行的
  const noRows = confirmed.filter((s) => (existing.get(s.recordId)?.size || 0) < s.members.length)
  if (noRows.length && toCreate.length === 0) {
    lines.push(`⚠️ 有 ${noRows.length} 条已确认报名的积分记录仍不全，请重试同步`)
  }

  // 失效行：积分行指向的报名已不处于已确认（已在上方清理段删除，这里统计报告）
  let stale = 0
  for (const s of scores) {
    for (const rid of linkIds(s.fields['报名记录'])) {
      if (!confirmedIds.has(rid)) stale++
    }
  }
  if (stale) lines.push(`ℹ️ ${stale} 条积分行对应的报名已取消确认（积分已自动归零，无需处理，仅存档）`)

  if (toDelete.length > 0) {
    lines.push(`🗑️ 已自动删除 ${toDelete.length} 条失效积分行（对应报名未处于已确认）`)
  } else {
    lines.push('✅ 无失效积分行需要清理')
  }

  return lines.join('\n')
}

/* ============ 模块二：名次录入（写在报名行的「比赛名次」单选上） ============ */
let rankAssign: Record<string, Record<string, string>> = {} // 项目 -> {rankName->signupRecordId|''}
let matchConfirmed: Record<string, boolean> = {} // 项目 -> 比赛是否已确认
let signupsCache: SignupRow[] = []

async function loadMatchRanks() {
  const matches = await fetchAll(T_MATCH)
  signupsCache = await loadSignups()
  matchConfirmed = {}
  rankAssign = {}
  const projects: string[] = []
  for (const m of matches) {
    const 项目 = sel(m.fields['项目'])
    if (!项目) continue
    projects.push(项目)
    matchConfirmed[项目] = sel(m.fields['成绩确认']) === '已确认'
    rankAssign[项目] = {}
    RANKS.forEach((rk) => {
      rankAssign[项目][rk] = ''
    })
  }
  // 名次来自报名行自身的「比赛名次」单选
  for (const s of signupsCache) {
    if (s.名次选择 && rankAssign[s.项目] && RANKS.includes(s.名次选择 as any)) {
      rankAssign[s.项目][s.名次选择] = s.recordId
    }
  }
  return projects
}

async function saveRanks(项目: string): Promise<string> {
  const t = await loadTable(T_SIGNUP)
  const field = await t.getField('比赛名次')
  const rows = signupsCache.filter((s) => s.项目 === 项目 && s.状态 === '已确认')
  const assign = rankAssign[项目] || {}
  let changed = 0
  for (const s of rows) {
    const desired = (RANKS as readonly string[]).find((rk) => assign[rk] === s.recordId) || ''
    if (desired !== s.名次选择) {
      await (field as any).setValue(s.recordId, desired || null)
      changed++
    }
  }
  const conf = matchConfirmed[项目]
    ? '✅ 该比赛已确认，积分生效中'
    : '⚠️ 该比赛成绩尚未确认，名次已记录但暂不计分——请到比赛记录表该项目行「成绩确认」点已确认'
  return `✅ 「${项目}」名次已保存（更新 ${changed} 行）。${conf}`
}

/* ============ UI 渲染 ============ */
const app = document.getElementById('app')!
let currentTab = 'sync'
let projects: string[] = []
let currentProject = ''

function el(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html.trim()
  return div.firstChild as HTMLElement
}

function render() {
  app.innerHTML = ''
  const tabs = el(`
    <div class="tabs">
      <button class="tab ${currentTab === 'sync' ? 'on' : ''}" data-tab="sync">① 记录同步·体检</button>
      <button class="tab ${currentTab === 'rank' ? 'on' : ''}" data-tab="rank">② 名次录入</button>
    </div>`)
  tabs.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      currentTab = (b as HTMLElement).dataset.tab!
      render()
    }),
  )
  app.appendChild(tabs)
  const body = el('<div class="body" id="body"></div>')
  app.appendChild(body)
  if (currentTab === 'sync') renderSync(body)
  else renderRank(body)
}

function loading(text: string) {
  const body = document.getElementById('body')!
  body.innerHTML = `<div class="card">${text}</div>`
}

async function renderSync(body: HTMLElement) {
  body.innerHTML = `
    <div class="card">
      <div class="row"><b>同步积分记录</b>
        <button class="btn" id="btn-sync">立即同步</button>
      </div>
      <div class="desc">把「报名状态=已确认」的报名生成积分行：个人赛 1:1，团体赛按成员拆行（改过成员名单再跑一次即对齐）。自动查重，重复执行安全。</div>
      <pre class="result" id="sync-result">打开时自动同步中…</pre>
    </div>`
  const run = async () => {
    const pre = document.getElementById('sync-result')!
    pre.textContent = '同步中…'
    try {
      pre.textContent = await runSync()
    } catch (e: any) {
      pre.textContent = `❌ ${e?.message || e}\n（请确认在三张表所在的多维表格中打开本插件）`
    }
  }
  document.getElementById('btn-sync')!.addEventListener('click', run)
  await run()
}

async function renderRank(body: HTMLElement) {
  loading('加载比赛与报名…')
  try {
    projects = await loadMatchRanks()
  } catch (e: any) {
    body.innerHTML = `<div class="card">❌ ${e?.message || e}</div>`
    return
  }
  if (!currentProject || !projects.includes(currentProject)) currentProject = projects[0] || ''
  body.innerHTML = `
    <div class="card">
      <div class="row"><label>比赛项目</label>
        <select id="proj" class="sel">${projects.map((p) => `<option ${p === currentProject ? 'selected' : ''}>${p}</option>`).join('')}</select>
      </div>
      <div class="desc">只列出该项目「已确认」的报名。点奖牌授予名次，再点一次取消；同一报名不会同时占两个名次。保存写入报名行的「比赛名次」，比赛记录表确认后积分自动生效。</div>
      <div id="ranks"></div>
      <div class="row gap">
        <button class="btn primary" id="btn-save">保存名次</button>
        <span class="hint" id="save-msg"></span>
      </div>
    </div>`
  document.getElementById('proj')!.addEventListener('change', (e) => {
    currentProject = (e.target as HTMLSelectElement).value
    renderRanks()
  })
  document.getElementById('btn-save')!.addEventListener('click', async () => {
    const msg = document.getElementById('save-msg')!
    msg.textContent = '保存中…'
    try {
      msg.textContent = await saveRanks(currentProject)
    } catch (e: any) {
      msg.textContent = `❌ ${e?.message || e}`
    }
  })
  renderRanks()
}

function renderRanks() {
  const box = document.getElementById('ranks')!
  if (!box) return
  const 项目 = currentProject
  const assign = rankAssign[项目] || {}
  const list = signupsCache.filter((s) => s.项目 === 项目 && s.状态 === '已确认')
  box.innerHTML = ''
  if (!list.length) {
    box.appendChild(el('<div class="empty">该项目暂无已确认的报名</div>'))
    return
  }
  for (const s of list) {
    const row = el(`
      <div class="signup">
        <div class="s-title">${s.title}</div>
        <div class="medals">
          ${RANKS.map((rk, i) => {
            const on = assign[rk] === s.recordId
            return `<button class="medal ${on ? 'on' : ''}" data-rank="${rk}">${MEDALS[i]}</button>`
          }).join('')}
        </div>
      </div>`)
    row.querySelectorAll('.medal').forEach((b) =>
      b.addEventListener('click', () => {
        const rk = (b as HTMLElement).dataset.rank!
        const cur = rankAssign[项目][rk]
        if (cur === s.recordId) {
          rankAssign[项目][rk] = '' // 再点取消
        } else {
          // 同一报名移出其他名次
          RANKS.forEach((r2) => {
            if (rankAssign[项目][r2] === s.recordId) rankAssign[项目][r2] = ''
          })
          rankAssign[项目][rk] = s.recordId
        }
        renderRanks()
      }),
    )
    box.appendChild(row)
  }
}

render()
