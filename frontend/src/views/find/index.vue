<template>
  <section class="page" data-module="find">
    <header class="page-head">
      <div>
        <h2>出土物登记管理</h2>
        <p class="page-desc">维护出土物，围绕器物编号、出土探方、出土层位、器物类别做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记出土物</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportRows">
          {{ exporting ? '正在导出…' : '按当前筛选导出清单' }}
        </button>
        <button v-if="lastExportFailed > 0" class="btn ghost" type="button" :disabled="exporting" @click="exportRows">
          重新导出（上次 {{ lastExportFailed }} 条未通过）
        </button>
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

    <p v-if="exportMessage" class="export-note">{{ exportMessage }}</p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

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

    <footer class="page-foot">
      <span>共 {{ total }} 条出土物登记记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  exportFindEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('find')
// 列与导出明细同源（直接取模块字段），导出内容与列表保持一致，不会一个多一个少。
const columns = meta.fields
const actions = ["提交登记", "完成编目", "提交复检"]
const statuses = ["待登记", "已登记", "已编目", "待复检"]
const stats = [{"label": "待登记器物", "value": 0}, {"label": "已编目器物", "value": 0}, {"label": "本月出土件数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const exporting = ref(false)
const exportMessage = ref('')
const lastExportFailed = ref(0)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  exportMessage.value = ''
  reload()
}

async function exportRows() {
  if (exporting.value) {
    return
  }
  exporting.value = true
  errorMessage.value = ''
  try {
    const result = await exportFindEntries(filters.value)
    if (!result.ok) {
      exportMessage.value = result.message
      return
    }
    lastExportFailed.value = result.failed
    if (result.total === 0) {
      exportMessage.value =
        `当前筛选条件下没有匹配的出土物记录，已导出说明文件「出土物登记清单-${result.date}.csv」，未生成空清单。`
    } else if (result.failed > 0) {
      exportMessage.value =
        `已${result.reused ? '覆盖更新' : '导出'}「出土物登记清单-${result.date}.csv」：成功 ${result.exported} 条，` +
        `${result.failed} 条器物编号格式校验未通过，已在文件末尾单独列出；修正后可点「重新导出」再导一遍。`
    } else {
      exportMessage.value =
        `已${result.reused ? '覆盖更新' : '导出'}「出土物登记清单-${result.date}.csv」：共 ${result.exported} 条，编号格式全部校验通过。`
    }
  } catch (error) {
    exportMessage.value = error instanceof Error ? error.message : '出土物清单导出失败'
  } finally {
    exporting.value = false
  }
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
