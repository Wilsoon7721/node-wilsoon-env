/*
  Tests must never touch the real user keychain, and must never pay for a
  PowerShell or `security` spawn on every unlock. Caching is off by default here;
  the keychain's own tests opt back in explicitly.
*/
process.env.WILSOON_ENV_NO_KEYCHAIN = '1';
