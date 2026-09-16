import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { open } from '../../core/crypto/envelope.js';
import { diff } from '../../core/dotenv.js';
import { unlockIdentity } from '../../core/session.js';
import { dim } from './format.js';
import { confirm, password } from './prompt.js';
import { note, ok, warn } from './ui.js';

// Line endings and trailing newlines are an editor's business, not a difference worth asking about
export const normalise = (text) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '');

/**
 * Pull what was just pushed and compare it with what is on disk.
 *
 * The comparison happens in memory. A decrypted copy written beside the project
 * - under a name no .gitignore entry covers - is one crash and one `git add -A`
 * away from a commit.
 *
 * @returns {Promise<boolean>} whether the round trip is good, or accepted as good
 */
export async function verifyRoundTrip(session, names, args = { flags: {} }) {
  const fromEnv = process.env.WILSOON_ENV_PASSPHRASE;
  const { privateRaw } = await unlockIdentity(session, fromEnv ? async () => fromEnv : () => password('  Passphrase: '), { cache: !args.flags['no-cache'] });

  const differing = [];

  for (const name of names) {
    const fetched = await session.provider.get(session.envRef(name));

    if (!fetched) {
      differing.push({ name, summary: 'nothing came back from the store' });
      continue;
    }

    const remote = open({ blob: fetched.blob, privateRaw, project: session.project, name }).plaintext.toString('utf8');
    const local = await readFile(path.join(session.dir, name), 'utf8');

    if (normalise(local) === normalise(remote)) continue;

    const d = diff(local, remote);
    const keys = [...d.added.map((k) => `+ ${k}`), ...d.removed.map((k) => `- ${k}`), ...d.changed.map((k) => `~ ${k}`)];

    differing.push({ name, summary: keys.join('   ') || 'the same keys and values, laid out differently' });
  }

  console.log('');

  if (!differing.length) {
    ok(`Round trip checked - the store gives back exactly what is on disk`);
    return true;
  }

  warn('What came back from the store is not what is on disk:');
  for (const d of differing) note(`   ${d.name}   ${dim(d.summary)}`);
  console.log('');

  if (await confirm('  Does that look right?')) return true;

  note('Nothing on disk was changed. Push again once the files are as you want them.');
  return false;
}
