// Holds a RESERVED lock (BEGIN IMMEDIATE, rollback-journal mode) on a database for a while,
// like a second daemon that is in the middle of creating the schema.
// argv: <db path> <hold ms>. Prints HOLDING once the lock is taken.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const db = new Database(process.argv[2]);
db.exec("BEGIN IMMEDIATE");
console.log("HOLDING");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[3]));
db.exec("COMMIT");
db.close();
