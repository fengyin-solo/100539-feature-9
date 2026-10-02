<template>
  <section class="page" data-module="find">
    <header class="page-head">
      <div>
        <h2>出土物登记管理</h2>
        <p class="page-desc">维护出土物，围绕器物编号、出土探方、出土层位、器物类别做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记出土物</button>
        <button class="btn" type="button" @click="exportRows">导出出土物登记清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p v-if="exportMessage" class="export-message">
      {{ exportMessage }}
      <button v-if="duplicatePlan" class="link" type="button" @click="forceDownload">仍要重新下载</button>
    </p>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无出土物登记数据，可先登记出土物</td>
        </tr>
      </tbody>
    </table>

    <section v-if="failedRows.length" class="failed-panel">
      <h3>编号校验未通过（{{ failedRows.length }} 条）</h3>
      <p class="panel-desc">
        以下记录未写入本次导出文件，修正器物编号后重新导出即可；也可以先单独导出这份名单核对。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>未通过原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in failedRows" :key="String(item.row.id)">
            <td v-for="column in columns" :key="column">{{ item.row[column] ?? '—' }}</td>
            <td>{{ item.row.status }}</td>
            <td>{{ item.reason }}</td>
          </tr>
        </tbody>
      </table>
      <button class="btn" type="button" @click="exportFailedRows">单独导出未通过记录</button>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条出土物登记记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  deliverExport,
  planFailedFindExport,
  planFindExport,
} from '@/api/find-export'
import type { FailedRow, FindExportPlan } from '@/api/find-export'
import {
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('find')
const columns = ["器物编号", "出土探方", "出土层位", "器物类别", "质地", "完残程度", "最大尺寸", "登记状态"]
const actions = ["提交登记", "完成编目", "提交复检"]
const statuses = ["待登记", "已登记", "已编目", "待复检"]
const stats = [{"label": "待登记器物", "value": 0}, {"label": "已编目器物", "value": 0}, {"label": "本月出土件数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const exportMessage = ref('')
const failedRows = ref<FailedRow[]>([])
const duplicatePlan = ref<FindExportPlan | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetExportFeedback() {
  exportMessage.value = ''
  failedRows.value = []
  duplicatePlan.value = null
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  errorMessage.value = ''
  resetExportFeedback()
  // 先按当前筛选条件刷新列表，导出的就是列表里这一批，两处内容保持一致
  reload()
  if (errorMessage.value) {
    return
  }
  const plan = planFindExport(rows.value, filters.value, columns)
  failedRows.value = plan.failed
  if (plan.matched === 0) {
    const outcome = deliverExport(plan)
    if (outcome.downloaded) {
      exportMessage.value = `当前筛选没有匹配到记录，已导出说明文件 ${outcome.filename}`
    } else {
      duplicatePlan.value = plan
      exportMessage.value = `相同条件的说明文件已于 ${outcome.exportedAt} 导出（${outcome.filename}），未重复生成`
    }
    return
  }
  if (plan.exported === 0) {
    exportMessage.value = `匹配到 ${plan.matched} 条记录，但器物编号校验均未通过，未生成清单文件；已在下方单独列出`
    return
  }
  const outcome = deliverExport(plan)
  if (outcome.downloaded) {
    exportMessage.value = plan.failed.length
      ? `已导出 ${plan.exported} 条（${outcome.filename}）；${plan.failed.length} 条编号校验未通过，已在下方单独列出`
      : `已导出 ${plan.exported} 条，文件 ${outcome.filename}`
  } else {
    duplicatePlan.value = plan
    exportMessage.value = `相同内容的清单已于 ${outcome.exportedAt} 导出为 ${outcome.filename}，未重复生成文件`
  }
}

function exportFailedRows() {
  errorMessage.value = ''
  exportMessage.value = ''
  duplicatePlan.value = null
  const plan = planFailedFindExport(failedRows.value, columns)
  const outcome = deliverExport(plan)
  if (outcome.downloaded) {
    exportMessage.value = `已单独导出 ${plan.exported} 条校验未通过记录（${outcome.filename}）`
  } else {
    duplicatePlan.value = plan
    exportMessage.value = `相同内容的未通过记录清单已于 ${outcome.exportedAt} 导出（${outcome.filename}），未重复生成`
  }
}

function forceDownload() {
  if (!duplicatePlan.value) {
    return
  }
  const plan = duplicatePlan.value
  deliverExport(plan, { force: true })
  duplicatePlan.value = null
  exportMessage.value = `已重新下载 ${plan.filename}，内容与之前导出的一致`
}

function openCreate() {
  errorMessage.value = '出土物登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  resetExportFeedback()
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '出土物登记列表读取失败'
  }
}

onMounted(reload)
</script>
