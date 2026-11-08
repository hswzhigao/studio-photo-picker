const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateReadablePassword(length = 12) {
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export function loginInfoText({ name, phone, password, url }) {
  return `${url ? `网址：${url}\n` : ''}客户：${name}\n手机号：${phone}\n密码：${password}`;
}
