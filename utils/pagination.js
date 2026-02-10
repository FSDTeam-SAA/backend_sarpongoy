export const parsePagination = (query = {}) => {
  const page = Math.max(Number.parseInt(query.page || "1", 10), 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit || "10", 10), 1), 100);
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

export const getPaginationMeta = ({ page, limit, total }) => ({
  page,
  limit,
  total,
  totalPages: Math.max(Math.ceil(total / limit), 1),
});
