/*
 * Safe, repeatable migration for Doctors Tracker demo records.
 * Default: dry run (read-only). Run --apply only after database backup.
 */
require("dotenv").config();
const { MongoClient } = require("mongodb");

const apply = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI missing. Set it in the local .env file.");
  process.exitCode = 1;
} else {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  const dbName = process.env.MONGODB_DB || "doctor-tracker";

  async function backfill(collection, filter, mapper) {
    const operations = [];
    let changed = 0;
    let skipped = 0;
    const cursor = collection.find(filter).batchSize(200);
    for await (const doc of cursor) {
      const update = mapper(doc);
      if (!update || !Object.keys(update).length) { skipped++; continue; }
      operations.push({ updateOne: { filter: { _id: doc._id }, update: { $set: update } } });
      changed++;
      if (operations.length >= 200) {
        if (apply) await collection.bulkWrite(operations, { ordered: false });
        operations.length = 0;
      }
    }
    if (operations.length && apply) await collection.bulkWrite(operations, { ordered: false });
    return { matched: changed + skipped, changed, skipped };
  }

  async function main() {
    await client.connect();
    const db = client.db(dbName);
    console.log(apply ? "APPLY MODE: updates will be written" : "DRY RUN: nothing will be written");
    const user = db.collection("user");
    const roleFilter = { $or: [{ role: { $exists: false } }, { role: null }] };
    const roles = await user.countDocuments(roleFilter);
    if (apply && roles) await user.updateMany(roleFilter, { $set: { role: "user" } });
    console.log("Accounts with no role -> user:", roles);

    const normalize = (value) => typeof value === "string"
      ? value.trim().replace(/\s+/g, " ").toLowerCase()
      : "";
    const doctors = await backfill(db.collection("doctors"), {
      $or: [{ searchName: { $exists: false } }, { searchHospital: { $exists: false } }]
    }, doc => {
      const searchName = normalize(doc.name);
      const searchHospital = normalize(doc.hospital);
      if (!searchName || !searchHospital) return null;
      return { searchName, searchHospital };
    });
    console.log("Doctor search-field backfill:", doctors);

    const patients = await backfill(db.collection("patients"), {
      searchName: { $exists: false }
    }, doc => {
      const searchName = normalize(doc.name);
      return searchName ? { searchName } : null;
    });
    console.log("Patient search-field backfill:", patients);

    console.log("Done. Legacy patient doctorId cannot be inferred; assign doctors using the Patients page.");
  }
  main().catch(err => {
    console.error("Migration error:", err?.name || "Error", err?.message || "");
    process.exitCode = 1;
  }).finally(async () => { await client.close(); });
}
