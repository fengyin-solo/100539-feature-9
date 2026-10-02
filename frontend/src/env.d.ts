/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_APP_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// File System Access API：仅用于导出时记住已选文件，重复导出直接写回同一个文件。
// 旧浏览器没有这个接口，local-service 会退回普通下载。
interface SaveFilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: SaveFilePickerAcceptType[]
}

interface ExportFileWritable {
  write(data: string | Blob): Promise<void>
  close(): Promise<void>
}

interface ExportFileHandle {
  queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
  requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
  createWritable(): Promise<ExportFileWritable>
}

interface Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<ExportFileHandle>
}
