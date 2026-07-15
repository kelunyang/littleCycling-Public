import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../schema-validate.js';
import type { JsonSchema } from '../types.js';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['limit'],
};

test('接受合法輸入', () => {
  const r = validateSchema({ limit: 10, mode: 'a', tags: ['x', 'y'] }, schema);
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('缺少必填欄位', () => {
  const r = validateSchema({ mode: 'a' }, schema);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('limit')));
});

test('型別錯誤', () => {
  const r = validateSchema({ limit: 'ten' }, schema);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('integer')));
});

test('integer 拒絕小數', () => {
  const r = validateSchema({ limit: 3.5 }, schema);
  assert.equal(r.valid, false);
});

test('數值範圍越界', () => {
  assert.equal(validateSchema({ limit: 0 }, schema).valid, false);
  assert.equal(validateSchema({ limit: 51 }, schema).valid, false);
  assert.equal(validateSchema({ limit: 25 }, schema).valid, true);
});

test('enum 不在允許清單', () => {
  const r = validateSchema({ limit: 1, mode: 'c' }, schema);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('mode')));
});

test('array items 型別錯誤', () => {
  const r = validateSchema({ limit: 1, tags: ['ok', 123] }, schema);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('tags[1]')));
});

test('非物件根值', () => {
  assert.equal(validateSchema(null, schema).valid, false);
  assert.equal(validateSchema(42, schema).valid, false);
});

test('巢狀物件遞迴驗證', () => {
  const nested: JsonSchema = {
    type: 'object',
    properties: {
      inner: { type: 'object', properties: { n: { type: 'number', minimum: 0 } }, required: ['n'] },
    },
    required: ['inner'],
  };
  assert.equal(validateSchema({ inner: { n: 5 } }, nested).valid, true);
  assert.equal(validateSchema({ inner: { n: -1 } }, nested).valid, false);
  assert.equal(validateSchema({ inner: {} }, nested).valid, false);
});
