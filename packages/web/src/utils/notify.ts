import { ElMessage } from 'element-plus';

export function notifyError(msg: string): void {
  ElMessage({ type: 'error', message: msg, duration: 5000, grouping: true });
}

export function notifySuccess(msg: string): void {
  ElMessage({ type: 'success', message: msg, duration: 3000, grouping: true });
}

export function notifyWarn(msg: string): void {
  ElMessage({ type: 'warning', message: msg, duration: 4000, grouping: true });
}
