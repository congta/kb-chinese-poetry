import { randomBytes } from "node:crypto";

const countArgument = process.argv[2] ?? "1";

if (!/^\d+$/.test(countArgument)) {
  console.error("用法：node scripts/generate-object-id.mjs [数量]");
  process.exit(1);
}

const count = Number(countArgument);

if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) {
  console.error("数量必须是 1 到 1000 之间的整数。");
  process.exit(1);
}

const timestamp = Math.floor(Date.now() / 1_000);
const processRandom = randomBytes(5);
let counter = randomBytes(3).readUIntBE(0, 3);

for (let index = 0; index < count; index += 1) {
  const objectId = Buffer.alloc(12);
  objectId.writeUInt32BE(timestamp, 0);
  processRandom.copy(objectId, 4);
  objectId.writeUIntBE(counter, 9, 3);

  console.log(objectId.toString("hex"));
  counter = (counter + 1) & 0xffffff;
}
