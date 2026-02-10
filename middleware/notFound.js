const notFound = (req, res, next) => {
  return res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl}`,
    error: "API Not Found",
  });
};

export default notFound;
