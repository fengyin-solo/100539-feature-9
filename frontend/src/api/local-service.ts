import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

function downloadBlob(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadBlob(filename, content)
}

// ===== 出土物（find）清单导出 =====
// 交库房的纸质清单专用：按当前筛选导出、带日期、编号校验、重复导出只覆盖当天同一个文件。

// 器物编号规则：FIND- 开头加 4 位顺序号，如 FIND-0001。
// 规则若调整只改这一处；已登记器物沿用既有编号，导出只做校验，绝不重新编号或改号。
const FIND_NUMBER_PATTERN = /^FIND-\d{4}$/
export const FIND_NUMBER_RULE_TEXT = 'FIND- 开头加 4 位顺序号（例：FIND-0001）'

export type FindExportResult =
  | {
      ok: true
      exported: number
      failed: number
      total: number
      date: string
      reason: string
      reused: boolean
    }
  | { ok: false; canceled: boolean; message: string }

// 同一天重复导出时复用已选文件句柄，直接覆盖写回，不每次堆一个新文件。
// 只留在本次会话内存里，不落 localStorage，隔天再导自动换新一天的文件。
let findExportHandle: { date: string; handle: ExportFileHandle } | null = null

function todayStamp(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function nowStamp(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${todayStamp(date)} ${hours}:${minutes}`
}

function csvCell(value: unknown): string {
  const text = String(value ?? '').trim()
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function csvLine(values: unknown[]): string {
  return values.map(csvCell).join(',')
}

function describeFilters(filters: Record<string, string>): string {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return '全部记录（未设置筛选条件）'
  }
  return pairs.map(([field, value]) => `${field} 包含「${value.trim()}」`).join('；')
}

function checkFindNumber(row: EntryRow): string {
  const code = String(row['器物编号'] ?? '').trim()
  if (code === '') {
    return '器物编号为空'
  }
  if (!FIND_NUMBER_PATTERN.test(code)) {
    return `器物编号「${code}」不符合编号规则（应为：${FIND_NUMBER_RULE_TEXT}）`
  }
  return ''
}

export type FindExportFile = {
  filename: string
  content: string
  exported: number
  failed: number
  total: number
  date: string
  reason: string
}

// 纯函数：导出列直接取 find 模块的 meta.fields，与页面列表同源同序，不会一个多一个少。
export function buildFindExport(filters: Record<string, string> = {}): FindExportFile {
  const meta = moduleMeta('find')
  const columns = meta.fields
  const date = todayStamp()
  const { items } = listEntries(meta.key, filters)
  const reason = describeFilters(filters)

  const valid: EntryRow[] = []
  const invalid: { row: EntryRow; problem: string }[] = []
  for (const row of items) {
    const problem = checkFindNumber(row)
    if (problem) {
      invalid.push({ row, problem })
    } else {
      valid.push(row)
    }
  }

  const lines: string[] = []
  lines.push('出土物登记清单导出说明')
  lines.push(csvLine(['导出时间', nowStamp()]))
  lines.push(csvLine(['导出范围', reason]))
  lines.push(csvLine(['匹配记录数', items.length]))
  lines.push(csvLine(['成功导出', valid.length]))
  lines.push(csvLine(['校验未通过', invalid.length]))
  lines.push('')

  if (items.length === 0) {
    // 没匹配到记录：不产出空表格，只给说明文件（也不附失败区，根本没有记录可校验）。
    lines.push('一、出土物登记清单')
    lines.push(csvLine(['说明', '当前筛选条件下没有匹配到出土物记录，未生成清单明细；请调整筛选条件后重新导出。']))
    return {
      filename: `出土物登记清单-${date}.csv`,
      content: `﻿${lines.join('\n')}`,
      exported: valid.length,
      failed: invalid.length,
      total: items.length,
      date,
      reason,
    }
  }

  lines.push(`一、出土物登记清单（${valid.length} 条）`)
  if (valid.length > 0) {
    lines.push(csvLine([...columns, '当前状态']))
    for (const row of valid) {
      lines.push(csvLine([...columns.map((field) => row[field] ?? ''), row.status]))
    }
  } else {
    lines.push(
      csvLine(['说明', `本次匹配的 ${items.length} 条记录器物编号均未通过格式校验，未生成清单明细；修正编号后可重新导出。`]),
    )
  }

  lines.push('')
  lines.push(`二、导出失败记录（${invalid.length} 条）`)
  lines.push(
    csvLine([
      '说明',
      `编号规则：${FIND_NUMBER_RULE_TEXT}。以下记录器物编号格式校验未通过，未列入上方清单；请沿用既有编号修正数据后再导一遍，导出不会改号。`,
    ]),
  )
  if (invalid.length > 0) {
    lines.push(csvLine(['记录ID', ...columns, '当前状态', '未通过原因']))
    for (const { row, problem } of invalid) {
      lines.push(csvLine([row.id, ...columns.map((field) => row[field] ?? ''), row.status, problem]))
    }
  }

  return {
    filename: `出土物登记清单-${date}.csv`,
    content: `\uFEFF${lines.join('\n')}`,
    exported: valid.length,
    failed: invalid.length,
    total: items.length,
    date,
    reason,
  }
}

async function resolveWritableHandle(file: FindExportFile): Promise<
  | { ok: true; handle: ExportFileHandle; reused: boolean }
  | { ok: false; canceled: boolean; message: string }
> {
  if (findExportHandle && findExportHandle.date === file.date) {
    const handle = findExportHandle.handle
    let permission = await handle.queryPermission({ mode: 'readwrite' })
    if (permission !== 'granted') {
      permission = await handle.requestPermission({ mode: 'readwrite' })
    }
    if (permission !== 'granted') {
      return { ok: false, canceled: true, message: '未获得已选导出文件的写入授权，导出已取消；可再次点击导出重新选择文件。' }
    }
    return { ok: true, handle, reused: true }
  }

  try {
    const handle = await window.showSaveFilePicker!({
      suggestedName: file.filename,
      types: [{ description: 'CSV 表格', accept: { 'text/csv': ['.csv'] } }],
    })
    findExportHandle = { date: file.date, handle }
    return { ok: true, handle, reused: false }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, canceled: true, message: '已取消选择导出文件。' }
    }
    throw error
  }
}

// 按当前筛选条件导出出土物清单：首次弹保存框（文件名带当天日期），之后当天再导直接覆盖同一份。
export async function exportFindEntries(filters: Record<string, string> = {}): Promise<FindExportResult> {
  const file = buildFindExport(filters)

  // 不支持 File System Access API 的浏览器退回普通下载，文件名仍带日期（同一天多次下载会被浏览器自动加序号）。
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
    downloadBlob(file.filename, file.content)
    return {
      ok: true,
      exported: file.exported,
      failed: file.failed,
      total: file.total,
      date: file.date,
      reason: file.reason,
      reused: false,
    }
  }

  const resolved = await resolveWritableHandle(file)
  if (!resolved.ok) {
    return resolved
  }

  const writable = await resolved.handle.createWritable()
  await writable.write(new Blob([file.content], { type: 'text/csv;charset=utf-8' }))
  await writable.close()

  return {
    ok: true,
    exported: file.exported,
    failed: file.failed,
    total: file.total,
    date: file.date,
    reason: file.reason,
    reused: resolved.reused,
  }
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
