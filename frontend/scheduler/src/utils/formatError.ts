import { ApiError } from '../api/client';

export function describeSchedulerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes('duplicate') ||
    lower.includes('unique') ||
    lower.includes('already exists') ||
    lower.includes('conflict')
  ) {
    return '名称或内容已存在，请更换后重试';
  }
  if (lower.includes('invalid spec ini') || lower.includes('no sections')) {
    return 'Spec INI 格式无效：未找到有效的 Section 或上下限键';
  }
  if (error instanceof ApiError && error.status === 409) {
    return '名称或内容已存在，请更换后重试';
  }
  if (error instanceof ApiError && error.status >= 500) {
    return '服务器错误，请稍后重试';
  }

  return message;
}
