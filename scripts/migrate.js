
const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("../src/store");

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = openDatabase(databasePath);
database.close();
console.log(`数据库迁移完成：${databasePath}`);
