import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
export const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
export class Vault {
  private key: Buffer;
  constructor(key: string) { this.key = Buffer.from(key, 'base64'); if (this.key.length !== 32) throw new Error('Invalid encryption key'); }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }
  open<T>(value: string, context: string): T {
    const [version, iv, tag, data] = value.split('.');
    if (version !== 'v1') throw new Error('Unsupported ciphertext');
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8')) as T;
  }
}
