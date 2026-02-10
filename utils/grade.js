export const GRADE_LEVELS = ["JHS 1", "JHS 2", "JHS 3", "SS 1", "SS 2", "SS 3", "SS 4", "SS 5"];

export const normalizeGradeLevel = (value) => {
  if (!value) return value;
  const compact = String(value).trim().toUpperCase().replace(/\s+/g, "");
  const map = {
    JHS1: "JHS 1",
    JHS2: "JHS 2",
    JHS3: "JHS 3",
    SS1: "SS 1",
    SS2: "SS 2",
    SS3: "SS 3",
    SS4: "SS 4",
    SS5: "SS 5",
  };
  return map[compact] || value;
};
