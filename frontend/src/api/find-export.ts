import { moduleMeta } from './local-service'
import type { EntryRow } from '@/data/types'

/**
 * 出土物清单导出：按列表当前筛选结果出表，导出前校验器物编号。
 * 与通用导出（local-service.downloadEntries）分开，只服务出土物模块。
 */

// 器物编号规则历经调整：老编号继续沿用、不换号，校验时新旧规则都认。
// 规则只增不改——新规则往数组末尾加，既有器物的编号保持原样，不因规则调整换号。
const ARTIFACT_NUMBER_RULES: { label: string; pattern: RegExp }[] = [
  { label: '2019 版（KG+发掘年份-流水号）', pattern: /^KG\d{4}-\d{3}$/ },
  { label: '现行（FIND-四位流水号）', pattern: /^FIND-\d{4}$/ },
]

/** 编号校验未通过的记录：原始行 + 未通过原因，导出时单独列出。 */
export type FailedRow = {
  row: EntryRow
  reason: string
}

/** 导出计划：要落盘的内容先算好，再交给 deliverExport 决定去重与下载。 */
export type FindExportPlan = {
  filename: string
  content: string
  mime: string
  matched: number
  exported: number
  failed: FailedRow[]
}

export type DeliverOutcome =
  | { downloaded: true; filename: string }
  | { downloaded: false; filename: string; exportedAt: string }

// 已导出清单的登记簿：按内容指纹去重，重复提交不再堆新文件。
const REGISTRY_KEY = 'archaeology-field:find-exports'

type ExportRecord = {
  filename: string
  exportedAt: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function formatTimestamp(date: Date): string {
  return `${formatDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 器物编号格式校验：空编号、不符合任何一版规则都拦下。 */
export function checkArtifactNumber(row: EntryRow): { ok: boolean; reason: string } {
  const number = String(row['器物编号'] ?? '').trim()
  if (!number) {
    return { ok: false, reason: '器物编号为空' }
  }
  if (ARTIFACT_NUMBER_RULES.some((rule) => rule.pattern.test(number))) {
    return { ok: true, reason: '' }
  }
  return { ok: false, reason: `编号「${number}」不符合现行及历史编号规则` }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(header: string[], body: string[][]): string {
  const lines = [header, ...body].map((cells) => cells.map(csvCell).join(','))
  return `\uFEFF${lines.join('\n')}`
}

function describeFilters(filters: Record<string, string>): string {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return '未设置筛选条件（全量导出）'
  }
  return pairs.map(([field, value]) => `${field}＝${value.trim()}`).join('；')
}

/**
 * 按列表当前展示的记录生成导出计划：
 * - 一条匹配都没有 → 生成说明文件，不给空表；
 * - 有匹配 → 先校验器物编号，通过的进清单，未通过的单独列出。
 */
export function planFindExport(
  rows: EntryRow[],
  filters: Record<string, string>,
  columns: string[],
  date: Date = new Date(),
): FindExportPlan {
  const meta = moduleMeta('find')
  const dateStr = formatDate(date)
  if (rows.length === 0) {
    const content = [
      `${meta.name}清单导出说明`,
      '',
      `筛选条件：${describeFilters(filters)}`,
      '导出结果：当前筛选条件下没有匹配到出土物登记记录，清单无内容。',
      '处理建议：调整或清空筛选条件后重新导出；若确认无记录，可持本说明向库房报备。',
    ].join('\n')
    return {
      filename: `${meta.name}清单-${dateStr}-无匹配记录说明.txt`,
      content,
      mime: 'text/plain;charset=utf-8',
      matched: 0,
      exported: 0,
      failed: [],
    }
  }
  const passed: EntryRow[] = []
  const failed: FailedRow[] = []
  for (const row of rows) {
    const check = checkArtifactNumber(row)
    if (check.ok) {
      passed.push(row)
    } else {
      failed.push({ row, reason: check.reason })
    }
  }
  const header = [...columns, '当前状态']
  const body = passed.map((row) => [
    ...columns.map((column) => String(row[column] ?? '')),
    String(row.status),
  ])
  return {
    filename: `${meta.name}清单-${dateStr}.csv`,
    content: toCsv(header, body),
    mime: 'text/csv;charset=utf-8',
    matched: rows.length,
    exported: passed.length,
    failed,
  }
}

/** 把校验未通过的记录单独做成一份清单，方便修正编号后核对、再导一遍。 */
export function planFailedFindExport(
  failed: FailedRow[],
  columns: string[],
  date: Date = new Date(),
): FindExportPlan {
  const meta = moduleMeta('find')
  const header = [...columns, '当前状态', '未通过原因']
  const body = failed.map(({ row, reason }) => [
    ...columns.map((column) => String(row[column] ?? '')),
    String(row.status),
    reason,
  ])
  return {
    filename: `${meta.name}清单-${formatDate(date)}-编号校验未通过.csv`,
    content: toCsv(header, body),
    mime: 'text/csv;charset=utf-8',
    matched: failed.length,
    exported: failed.length,
    failed: [],
  }
}

function fingerprint(content: string): string {
  // djb2：内容一样指纹就一样，重复提交能认出来
  let hash = 5381
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) + hash + content.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}

function readRegistry(): Record<string, ExportRecord> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(REGISTRY_KEY) ?? '{}',
    ) as Record<string, ExportRecord> | null
    return parsed ?? {}
  } catch {
    return {}
  }
}

function writeRegistry(registry: Record<string, ExportRecord>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  try {
    window.localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry))
  } catch {
    // 登记簿写不进去不拦导出，大不了下次多去重一次
  }
}

function downloadFile(plan: FindExportPlan): void {
  const blob = new Blob([plan.content], { type: plan.mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = plan.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/**
 * 落盘前去重：相同内容的导出只留一份文件。
 * 重复提交时返回已导出的文件名，不再生成新文件；确实需要可 force 重新下载同一份内容。
 */
export function deliverExport(plan: FindExportPlan, options: { force?: boolean } = {}): DeliverOutcome {
  const key = fingerprint(plan.content)
  const registry = readRegistry()
  const existing = registry[key]
  if (existing && !options.force) {
    return { downloaded: false, filename: existing.filename, exportedAt: existing.exportedAt }
  }
  if (!existing) {
    registry[key] = { filename: plan.filename, exportedAt: formatTimestamp(new Date()) }
    writeRegistry(registry)
  }
  downloadFile(plan)
  return { downloaded: true, filename: plan.filename }
}
