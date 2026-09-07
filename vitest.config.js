export default {
  test: {
    setupFiles: ['./test/setup.js'],

    /*
      Argon2id at the shipped cost is ~200ms by design, and several suites call
      setup, which pays it for real. Run enough files in parallel and one test can
      pass the 5s default while doing nothing wrong - which shows up as a
      different handful of timeouts on every run, and would be worse on a slower
      CI machine. The work is genuinely this slow; the default is what is wrong.
    */
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
};
