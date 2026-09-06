export const GRADE_LEVELS = ["JHS 1", "JHS 2", "JHS 3"];

export const normalizeGradeLevel = (value) => {
  if (!value) return value;
  const compact = String(value).trim().toUpperCase().replace(/\s+/g, "");
  const map = {
    JHS1: "JHS 1",
    JHS2: "JHS 2",
    JHS3: "JHS 3",
  };
  return map[compact] || value;
};
