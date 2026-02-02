const sendResponse = (res, { statusCode, success, message, data = null }) => {
  const response = {
    success,
    message,
  };

  if (data !== null) {
    response.data = data;
  }

  res.status(statusCode).json(response);
};

export default sendResponse;
