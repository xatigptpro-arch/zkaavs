import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export async function hashPassword(password) {
  const salt = randomBytes(32);
  const hash = await derive(password, salt, 32);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}
export async function verifyPassword(password, credential) {
  const salt = Buffer.from(credential.salt, 'base64');
  const hash = Buffer.from(credential.hash, 'base64');
  if (salt.length !== 32 || hash.length !== 32) throw new Error('Invalid password hash');
  const candidate = await derive(password, salt, hash.length);
  return timingSafeEqual(candidate, hash);
}
