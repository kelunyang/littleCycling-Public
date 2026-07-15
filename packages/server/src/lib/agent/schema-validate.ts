/**
 * 輕量 JSON Schema validator（draft-07 子集）。
 *
 * 僅支援 tool 參數用得到的關鍵字：type / properties / required / items /
 * enum / minimum / maximum。刻意不引入 ajv——保持零相依、體積小、
 * 錯誤訊息用繁中直接回填給 LLM 讓它自行修正。
 */

import type { JsonSchema } from './types.js';

export interface ValidateResult {
  valid: boolean;
  errors: string[];
}

/** 對 value 依 schema 驗證，回傳所有錯誤（路徑以 root 起算）。 */
export function validateSchema(value: unknown, schema: JsonSchema): ValidateResult {
  const errors: string[] = [];
  walk(value, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}

function walk(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  // enum：值必須落在允許清單內
  if (schema.enum) {
    if (!schema.enum.some((e) => e === value)) {
      errors.push(`${path} 必須是 ${JSON.stringify(schema.enum)} 其中之一`);
      return;
    }
  }

  if (schema.type) {
    if (!checkType(value, schema.type)) {
      errors.push(`${path} 型別應為 ${schema.type}`);
      return; // 型別都不對，後續子驗證無意義
    }
  }

  // 數值範圍
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path} 不得小於 ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path} 不得大於 ${schema.maximum}`);
    }
  }

  // 物件：required + properties 逐一遞迴
  if (schema.type === 'object' && isObject(value)) {
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) {
          errors.push(`${path} 缺少必填欄位 "${key}"`);
        }
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) {
          walk((value as Record<string, unknown>)[key], sub, `${path}.${key}`, errors);
        }
      }
    }
  }

  // 陣列：逐元素套 items
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], schema.items, `${path}[${i}]`, errors);
    }
  }
}

function checkType(value: unknown, type: NonNullable<JsonSchema['type']>): boolean {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
