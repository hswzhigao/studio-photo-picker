import { describe, expect, it } from 'vitest';
import { generateReadablePassword, loginInfoText } from './utils/password.js';

describe('customer password helpers', () => {
  it('generates a readable password with the backend-compatible alphabet', () => {
    const password = generateReadablePassword();
    expect(password).toHaveLength(12);
    expect(password).toMatch(/^[A-HJ-NP-Za-km-z23456789]+$/);
  });

  it('formats the one-time login information for copying', () => {
    expect(loginInfoText({ name: '测试客户', phone: '13900000000', password: 'Abc23456' }))
      .toBe('客户：测试客户\n手机号：13900000000\n密码：Abc23456');
  });
});
