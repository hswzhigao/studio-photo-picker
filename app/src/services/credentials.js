import crypto from 'node:crypto';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateReadablePassword(length = 12) {
  let password = '';
  for (let i = 0; i < length; i += 1) password += alphabet[crypto.randomInt(alphabet.length)];
  return password;
}

export function suppliedPassword(value) {
  const password = String(value || '');
  return password.length >= 8 && password.length <= 128 ? password : null;
}
