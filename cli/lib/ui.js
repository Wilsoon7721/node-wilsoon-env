import { cyan, dim, green, red, S, yellow } from './format.js';

export function command(text) {
  return cyan(`npx @wilsoon/env ${text}`);
}

export function heading(text) {
  console.log('');
  console.log(`  ${text}`);
  console.log('');
}

export function field(label, value, width = 12) {
  console.log(`  ${dim(label.padEnd(width))}  ${value}`);
}

export function ok(text) {
  console.log(`  ${green(S.ok)} ${text}`);
}

export function warn(text) {
  console.log(`  ${yellow(S.info)} ${text}`);
}

export function fail(text) {
  console.error(`  ${red(S.bad)} ${text}`);
}

export function note(text) {
  console.log(`  ${dim(text)}`);
}

export function outcome({ ok: headline, next = [] }) {
  console.log('');
  console.log(`  ${green(S.ok)} ${headline}`);
  for (const line of next) console.log(`    ${dim(line)}`);
  console.log('');
}
