import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { brandingDefaults } from '../shared/branding.mjs';
import { framingDefaults } from '../shared/framing.mjs';

export const defaultSettings = () => ({
  name: 'My YouTube stream', videoId: null, quality: '720p', loop: true, endAt: null,
  source: 'upload', youtubeUrl: '', youtubeMode: 'direct',
  layout: 'vertical', frameFit: 'cover',
  ...brandingDefaults,
  ...framingDefaults,
});

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.uploads = join(directory, 'uploads');
    this.thumbnails = join(directory, 'thumbnails');
    this.incoming = join(directory, 'incoming');
    for (const path of [directory, this.uploads, this.thumbnails, this.incoming]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    this.path = join(directory, 'state.json');
    const secretPath = join(directory, '.encryption-key');
    if (!existsSync(secretPath)) {
      if (existsSync(this.path) && JSON.parse(readFileSync(this.path, 'utf8')).encryptedKey) {
        throw new Error('The encryption key is missing. Restore data/.encryption-key from your backup.');
      }
      writeFileSync(secretPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    this.secret = readFileSync(secretPath);
    if (this.secret.length !== 32) throw new Error('Invalid data encryption key.');
    this.state = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : { settings: defaultSettings(), encryptedKey: null, videos: [], desiredRunning: false, events: [] };
    this.state.settings = { ...defaultSettings(), ...this.state.settings };
    this.save();
  }

  save() {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  setKey(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.state.encryptedKey = [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('base64')).join('.');
  }

  getKey() {
    if (!this.state.encryptedKey) return null;
    const [iv, tag, value] = this.state.encryptedKey.split('.').map(v => Buffer.from(v, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.secret, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(value), decipher.final()]).toString('utf8');
  }

  event(message, level = 'info') {
    this.state.events.unshift({ id: randomBytes(8).toString('hex'), at: new Date().toISOString(), message, level });
    this.state.events = this.state.events.slice(0, 40);
    this.save();
  }
}
