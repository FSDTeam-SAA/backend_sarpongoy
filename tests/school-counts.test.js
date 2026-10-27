import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Evaluate the actual handlers with database doubles; no live database writes.
const source = readFileSync(new URL("../controllers/admin.controller.js", import.meta.url), "utf8");
function handler(name, dependencies) {
  const start = source.indexOf(`export const ${name} =`);
  const end = source.indexOf("\nexport const ", start + 1);
  const declaration = source.slice(start, end === -1 ? undefined : end).replace("export const ", "const ");
  return vm.runInNewContext(`${declaration}\n${name}`, {
    catchAsync: (fn) => fn,
    sendResponse: (res, response) => { res.body = response; },
    ...dependencies,
  });
}

function schoolsHandler(items, students, teachers) {
  const pipelines = [];
  const query = {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
  return {
    pipelines,
    run: handler("getSchools", {
      parsePagination: () => ({ page: 1, limit: 10, skip: 0 }),
      getPaginationMeta: (value) => value,
      School: { find: () => query, countDocuments: async () => items.length },
      Student: { aggregate: async (pipeline) => { pipelines.push(pipeline); return students; } },
      Teacher: { aggregate: async (pipeline) => { pipelines.push(pipeline); return teachers; } },
    }),
  };
}

test("school list replaces stale totals with actual registrations, including zero", async () => {
  const items = [
    { _id: "school-a", totalStudent: 99, totalTeacher: 99 },
    { _id: "school-b", totalStudent: 88, totalTeacher: 88 },
  ];
  const { run, pipelines } = schoolsHandler(items, [{ _id: "school-a", total: 3 }], [{ _id: "school-a", total: 1 }]);
  const res = {};
  await run({ query: {} }, res);
  assert.deepEqual(items.map((item) => [item.totalStudent, item.totalTeacher]), [[3, 1], [0, 0]]);
  assert.equal(res.body.data.meta.total, 2);
  assert.equal(pipelines.length, 2);
  assert.equal(JSON.stringify(pipelines[0][0]), JSON.stringify({ $match: { school: { $in: ["school-a", "school-b"] } } }));
});

test("empty school page avoids count aggregation", async () => {
  const { run, pipelines } = schoolsHandler([], [], []);
  const res = {};
  await run({ query: {} }, res);
  assert.equal(res.body.data.items.length, 0);
  assert.equal(pipelines.length, 0);
});

for (const targetSchool of ["school-a", "school-b"]) {
  test(`student update syncs every affected school once (${targetSchool})`, async () => {
    const saved = [];
    const synced = [];
    const student = { _id: "student", user: "user", school: "school-a", save: async () => { saved.push("student"); } };
    const user = { save: async () => { saved.push("user"); } };
    const run = handler("updateStudent", {
      Student: { findById: async () => student },
      User: { findById: async () => user },
      School: { findById: async () => ({ _id: targetSchool }) },
      parseSecurityQuestions: async () => [],
      syncSchoolCounts: async (id) => {
        assert.equal(saved.length, 2);
        synced.push(id);
      },
    });
    const res = {};
    await run({ params: { studentId: "student" }, body: { schoolId: targetSchool } }, res);
    assert.equal(student.school, targetSchool);
    assert.equal(user.school, targetSchool);
    assert.deepEqual(synced.sort(), targetSchool === "school-a" ? ["school-a"] : ["school-a", "school-b"]);
    assert.equal(res.body.success, true);
  });
}
