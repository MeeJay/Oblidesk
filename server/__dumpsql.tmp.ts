/* Renders every DDL statement migration 006 would issue, without a database. */
import Knex from 'knex';
import { up, down } from 'D:/ObliDesk/server/src/db/migrations/006_problem_management';

const real = Knex({ client: 'pg' });
const out: string[] = [];

function makeSchema() {
  return {
    createTable(name: string, cb: unknown) {
      out.push((real.schema.createTable(name, cb as never) as unknown as { toString(): string }).toString());
      return Promise.resolve();
    },
    alterTable(name: string, cb: unknown) {
      out.push((real.schema.alterTable(name, cb as never) as unknown as { toString(): string }).toString());
      return Promise.resolve();
    },
    raw(sql: string) {
      out.push(sql.replace(/\s+/g, ' ').trim());
      return Promise.resolve();
    },
    dropTableIfExists(name: string) {
      out.push(`drop table if exists "${name}"`);
      return Promise.resolve();
    },
  };
}

const fake = Object.assign(
  (table: string) => real(table),
  { schema: makeSchema(), fn: real.fn, raw: real.raw.bind(real) },
);

async function main() {
  await up(fake as never);
  console.log('=================== UP ===================');
  out.forEach((s, i) => console.log(`\n[${i + 1}] ${s};`));
  out.length = 0;
  await down(fake as never);
  console.log('\n\n=================== DOWN ===================');
  out.forEach((s, i) => console.log(`\n[${i + 1}] ${s};`));
  await real.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
