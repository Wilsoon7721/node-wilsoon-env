import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach } from 'vitest';

process.env.WILSOON_ENV_NO_KEYCHAIN = '1';
beforeEach(() => (process.env.WILSOON_ENV_CREDENTIALS_DIR = mkdtempSync(path.join(tmpdir(), 'wenv-home-'))));
