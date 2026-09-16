import { clearCredential } from '../../auth/tokens.js';
import { accountFor, describe as describeKeychain, forget, identityAccount } from '../../core/keychain.js';
import { openSession } from '../../core/session.js';
import { cyan, plural } from '../lib/format.js';
import { command, heading, note, ok, outcome, warn } from '../lib/ui.js';

/**
 * Drop this machine's cached identity keys and its identity provider token
 */
export async function logout(args) {
  const session = await openSession({ cwd: args.flags.cwd ?? process.cwd() });

  const auth = session.config.auth;
  const signedOut = auth?.issuer ? await clearCredential(auth.issuer) : false;

  if (!describeKeychain()) {
    if (signedOut) ok(`Signed out of ${cyan(auth.issuer)}`);
    else warn('No keychain is available on this machine, so nothing is cached.');

    return 0;
  }

  const { recipients } = session.config;
  const wanted = args.flags.as ? recipients.filter((r) => r.name === args.flags.as || r.keyid === args.flags.as) : recipients;

  if (!wanted.length) {
    warn(args.flags.as ? `No identity called ${cyan(args.flags.as)} in this project.` : 'No identities to forget.');
    return 1;
  }

  heading(`Forgetting cached keys for ${cyan(session.project)}`);

  let cleared = 0;

  for (const r of wanted) {
    const who = r.name ?? r.keyid;

    // An identity is cached once for every project it belongs to, and older versions cached it per project
    const shared = await forget(identityAccount(r.keyid));
    const legacy = await forget(accountFor(session.project, r.keyid));

    if (shared || legacy) {
      ok(who);
      cleared++;
    } else
      note(`${who} was not cached`);
  }

  outcome({
    ok: cleared ? `${plural(cleared, 'key')} forgotten` : 'Nothing was cached on this machine',
    next: [
      signedOut ? `Also signed out of ${auth.issuer}` : 'No identity provider token was stored',
      `Your secrets are untouched - the next ${command('pull')} will ask for your passphrase again${cleared ? ', in every project that key belongs to' : ''}`
    ]
  });

  return 0;
}
